import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appDir, '..');
const configPath = process.env.DEMO_CONFIG_PATH || path.join(root, 'state/private/demo-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const publicDir = path.join(appDir, 'public');
const evidencePath = path.resolve(root, config.evidenceFile);
const cache = new Map();
const history = [];
const actionLog = { pressure: null, interruption: null, probes: [] };
const pressureRuns = new Map();
let latestPressureRun = null;
let interruptionRun = null;
let trafficRun = null;
let resetBusy = false;

const MODEL = config.model;
const CAPACITY = config.profile.capacity;
const MAX_PRESSURE_SECONDS = config.profile.maxPressureSeconds;
const REQUEST_BODY = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Please respond with a short, friendly greeting.' }],
  max_tokens: 128,
  stream: false,
};

function poolDisplayName(poolId) {
  return ({
    'pool-a': 'Dynamo · Pool A',
    'pool-b': 'Dynamo · Pool B',
    'site-pool': 'Dynamo · Remote Pool',
  })[poolId] || `Dynamo · ${poolId || 'Pool unavailable'}`;
}

function utcNow() {
  return new Date().toISOString();
}

function safeError(error) {
  return error?.name === 'AbortError' ? 'request aborted' : (error?.name || 'source error');
}

function writeEvidence(record) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(evidencePath, `${JSON.stringify({ recordedAt: utcNow(), ...record })}\n`, { mode: 0o600 });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: options.timeout ?? 12000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error('command failed');
        failure.kind = error.killed ? 'timeout' : 'command';
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve(stdout);
    });
  });
}

function kubeArgs(cluster, args) {
  const kubeconfig = path.resolve(root, cluster.kubeconfig);
  return ['--kubeconfig', kubeconfig, '--context', cluster.context, ...args];
}

async function kubeText(cluster, args, timeout = 12000) {
  return runCommand('kubectl', kubeArgs(cluster, args), { timeout });
}

async function kubeJson(cluster, args, timeout = 12000) {
  const output = await kubeText(cluster, [...args, '-o', 'json'], timeout);
  return JSON.parse(output);
}

function parseLabels(source) {
  const labels = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  for (const match of source.matchAll(pattern)) {
    labels[match[1]] = match[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return labels;
}

function parsePrometheus(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (!match) continue;
    samples.push({ name: match[1], labels: parseLabels(match[2] || ''), raw: match[3] });
  }
  return samples;
}

function metric(samples, name, expectedLabels = {}) {
  const matches = samples.filter(sample => sample.name === name &&
    Object.entries(expectedLabels).every(([key, value]) => sample.labels[key] === value));
  if (matches.length !== 1) {
    return { value: null, status: 'UNAVAILABLE', reason: matches.length ? 'ambiguous series' : 'series absent' };
  }
  const value = Number(matches[0].raw);
  if (!Number.isFinite(value)) return { value: null, status: 'UNAVAILABLE', reason: 'non-finite sample' };
  return { value, status: 'LIVE', labels: matches[0].labels };
}

function cachedRead(key, value) {
  const sampledAt = Date.now();
  cache.set(key, { value, sampledAt });
  return { status: 'LIVE', observedAt: new Date(sampledAt).toISOString(), ageSeconds: 0, value };
}

function staleRead(key, error) {
  const previous = cache.get(key);
  const now = Date.now();
  if (previous) {
    const ageSeconds = (now - previous.sampledAt) / 1000;
    if (ageSeconds <= 30) {
      return {
        status: 'STALE', observedAt: new Date(previous.sampledAt).toISOString(), ageSeconds,
        value: previous.value, sourceError: safeError(error),
      };
    }
  }
  return { status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, value: null, sourceError: safeError(error) };
}

async function readMetrics(key, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3500), cache: 'no-store' });
    if (!response.ok) throw new Error('metrics request failed');
    const text = await response.text();
    const parsed = parsePrometheus(text);
    if (!parsed.length) throw new Error('empty metrics response');
    return cachedRead(key, parsed);
  } catch (error) {
    return staleRead(key, error);
  }
}

function sampleValue(source, name, labels = {}) {
  if (source.status !== 'LIVE') {
    return { value: null, status: source.status, observedAt: source.observedAt, ageSeconds: source.ageSeconds };
  }
  const result = metric(source.value, name, labels);
  return { ...result, observedAt: source.observedAt, ageSeconds: source.ageSeconds };
}

function constrainMetric(result, predicate, reason) {
  if (result.status !== 'LIVE' || predicate(result.value)) return result;
  return { ...result, value: null, status: 'UNAVAILABLE', reason };
}

function parseOverlay(data, revisionAnnotation) {
  const text = data?.['routing-overlay.json'];
  if (!text) return { status: 'UNAVAILABLE', revision: null, candidates: [], observedAt: null };
  try {
    const overlay = JSON.parse(text);
    const revision = overlay.revision?.value || revisionAnnotation || null;
    const candidates = Array.isArray(overlay.overlay?.candidates) ? overlay.overlay.candidates : [];
    return { status: 'LIVE', revision, candidates, observedAt: overlay.provenance?.rendered_at || overlay.overlay?.generated_at || null };
  } catch {
    return { status: 'UNAVAILABLE', revision: null, candidates: [], observedAt: null };
  }
}

function overlayFromConfigMap(configMap) {
  const annotations = configMap.metadata?.annotations || {};
  return parseOverlay(configMap.data, annotations['grid.praxis.fast/overlay-revision']);
}

function overlayFromFile(text) {
  try {
    const overlay = JSON.parse(text);
    return { status: 'LIVE', revision: overlay.revision?.value || null, observedAt: overlay.provenance?.rendered_at || null };
  } catch {
    return { status: 'UNAVAILABLE', revision: null, observedAt: null };
  }
}

async function readPublishedOverlay() {
  const key = 'publishedOverlay';
  try {
    const object = await kubeJson(config.kubernetes.hub, [
      '-n', config.kubernetes.namespace, 'get', 'configmap', config.grid.overlayConfigMap,
    ]);
    const overlay = overlayFromConfigMap(object);
    if (overlay.status !== 'LIVE' || !overlay.revision) throw new Error('overlay revision absent');
    return cachedRead(key, overlay);
  } catch (error) {
    return staleRead(key, error);
  }
}

async function readConsumedOverlay() {
  const key = 'consumedOverlay';
  try {
    const output = await kubeText(config.kubernetes.hub, [
      '-n', config.kubernetes.namespace, 'exec', `deployment/${config.grid.localGateway}`,
      '-c', 'praxis', '--', 'cat', '/etc/praxis/routing/routing-overlay.json',
    ], 12000);
    const overlay = overlayFromFile(output);
    if (overlay.status !== 'LIVE' || !overlay.revision) throw new Error('mounted overlay revision absent');
    return cachedRead(key, overlay);
  } catch (error) {
    return staleRead(key, error);
  }
}

function conditionValue(object, name) {
  const conditions = object?.status?.conditions || [];
  const condition = conditions.find(item => item.type === name);
  if (!condition) return { value: null, status: 'UNAVAILABLE', observedAt: null, reason: 'condition absent' };
  return {
    value: condition.status === 'True', status: 'LIVE', reason: condition.reason || null,
    message: condition.message || null, observedAt: condition.lastTransitionTime || object.status?.lastProbeTime || null,
  };
}

async function readPeerStatus() {
  const key = 'peerStatus';
  try {
    const peerCluster = config.kubernetes[config.peer.gridSiteCluster];
    const providerCluster = config.kubernetes[config.gateways.remoteProvider.cluster];
    const remoteSite = await kubeJson(peerCluster, [
      'get', 'gridsite', config.peer.remoteSiteResource,
    ]);
    const remoteGateway = await kubeJson(providerCluster, [
      '-n', config.kubernetes.namespace, 'get', 'deployment', config.gateways.remoteProvider.deployment,
    ]);
    const actualGateway = remoteSite.spec?.gatewayEndpoint?.address || null;
    const signalAddress = remoteSite.spec?.signalsEndpoint?.address || null;
    const owned = remoteSite.metadata?.labels?.['praxis.fast/run-id'] === config.peer.runLabel;
    const signals = conditionValue(remoteSite, 'SignalsReachable');
    const replicas = Number(remoteGateway.status?.replicas);
    const readyReplicas = Number(remoteGateway.status?.readyReplicas);
    const value = {
      owned,
      signals,
      signalsAddress: signalAddress,
      gatewayAddress: actualGateway,
      configuredGatewayAddress: config.peer.remoteGatewayAddress,
      providerGatewayReady: Number.isInteger(replicas) && replicas > 0 && readyReplicas === replicas,
      providerGatewayReplicas: `${Number.isInteger(readyReplicas) ? readyReplicas : '—'}/${Number.isInteger(replicas) ? replicas : '—'}`,
    };
    if (!owned) throw new Error('peer object is outside this run');
    return cachedRead(key, value);
  } catch (error) {
    return staleRead(key, error);
  }
}

function poolFromMetrics(pool, source) {
  const modelReady = constrainMetric(
    sampleValue(source, 'dynamo_frontend_model_ready', { model: MODEL }),
    value => value === 0 || value === 1,
    'model_ready must be zero or one',
  );
  const activeRequests = constrainMetric(
    sampleValue(source, 'dynamo_frontend_active_requests', { model: MODEL }),
    value => value >= 0,
    'active_requests cannot be negative',
  );
  const capacity = Number.isSafeInteger(CAPACITY) && CAPACITY > 0 ? CAPACITY : null;
  const profile = typeof config.profile.id === 'string' && config.profile.id.trim() ? config.profile.id : null;
  const stages = source.status === 'LIVE'
    ? source.value.filter(item => item.name === 'dynamo_frontend_stage_requests' && Number.isFinite(Number(item.raw)))
      .map(item => ({ stage: item.labels.stage || 'unknown', phase: item.labels.phase || '', value: Number(item.raw) }))
    : [];
  return {
    id: pool.id, label: poolDisplayName(pool.id), site: pool.site, model: MODEL,
    profile, capacity,
    source: { status: source.status, observedAt: source.observedAt, ageSeconds: source.ageSeconds },
    modelReady, activeRequests, stages,
  };
}

function decisionMetrics(source) {
  const candidates = new Map();
  if (source.status !== 'LIVE') return { status: source.status, candidates: [] };
  const keyFor = labels => JSON.stringify([labels.site, labels.cluster]);
  const getCandidate = labels => {
    const key = keyFor(labels);
    if (!candidates.has(key)) {
      candidates.set(key, {
        site: labels.site, cluster: labels.cluster, score: null, scoreStatus: 'UNAVAILABLE',
        rho: null, sampleAgeSeconds: null, scoreOrder: null,
      });
    }
    return candidates.get(key);
  };
  for (const sample of source.value) {
    if (sample.name === 'grid_route_candidate_info' && Number(sample.raw) === 1) getCandidate(sample.labels);
    if (sample.name !== 'grid_route_site_score') continue;
    const candidate = getCandidate(sample.labels);
    const score = Number(sample.raw);
    if (Number.isFinite(score)) {
      candidate.score = score;
      candidate.scoreStatus = 'LIVE';
    }
  }
  const result = [...candidates.values()];
  for (const candidate of result) {
    const labels = { site: candidate.site, cluster: candidate.cluster };
    const rho = metric(source.value, 'grid_route_site_rho', labels);
    const age = metric(source.value, 'grid_route_site_last_sample_age_seconds', labels);
    candidate.rho = rho.status === 'LIVE' ? rho.value : null;
    candidate.sampleAgeSeconds = age.status === 'LIVE' ? age.value : null;
  }
  result.sort((a, b) => {
    const left = Number.isFinite(a.score) ? a.score : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(b.score) ? b.score : Number.POSITIVE_INFINITY;
    return left - right || a.site.localeCompare(b.site) || a.cluster.localeCompare(b.cluster);
  });
  let scoreOrder = 0;
  for (const candidate of result) {
    if (candidate.scoreStatus === 'LIVE' && Number.isFinite(candidate.score)) candidate.scoreOrder = ++scoreOrder;
  }
  return { status: 'LIVE', candidates: result };
}

function routeCounts(source) {
  if (source.status !== 'LIVE') return { status: source.status, counts: [] };
  const counts = source.value.filter(item => item.name === 'grid_route_decisions_total')
    .map(item => ({ site: item.labels.site, cluster: item.labels.cluster, reason: item.labels.reason, value: Number(item.raw) }))
    .filter(item => Number.isFinite(item.value));
  return { status: 'LIVE', counts };
}

function gatewayRequestCounts(source) {
  if (source.status !== 'LIVE') return { status: source.status, counts: [] };
  const counts = source.value.filter(item => item.name === 'praxis_http_requests_total')
    .map(item => ({
      cluster: item.labels.cluster || null,
      method: item.labels.method || null,
      statusClass: item.labels.status_class || null,
      value: Number(item.raw),
    }))
    .filter(item => item.cluster && Number.isFinite(item.value));
  return { status: 'LIVE', counts };
}

function gatewayRequestDelta(before, after) {
  if (before?.status !== 'LIVE' || after?.status !== 'LIVE') {
    return { status: 'UNAVAILABLE', total: null, selectedBackend: null, counts: [] };
  }
  const sumByCluster = readings => {
    const totals = new Map();
    for (const reading of readings?.counts || []) {
      totals.set(reading.cluster, (totals.get(reading.cluster) || 0) + reading.value);
    }
    return totals;
  };
  const oldTotals = sumByCluster(before);
  const newTotals = sumByCluster(after);
  const clusters = new Set([...oldTotals.keys(), ...newTotals.keys()]);
  const counts = [...clusters].map(cluster => ({
    cluster,
    delta: (newTotals.get(cluster) || 0) - (oldTotals.get(cluster) || 0),
  }));
  if (counts.some(item => item.delta < 0)) {
    return { status: 'UNAVAILABLE', total: null, selectedBackend: null, counts: [], reason: 'counter reset during probe' };
  }
  const changed = counts.filter(item => item.delta > 0);
  const total = changed.reduce((sum, item) => sum + item.delta, 0);
  const selectedBackend = total === 1 && changed.length === 1 ? changed[0].cluster : null;
  return {
    status: 'LIVE', total, selectedBackend, counts: changed,
    interpretation: selectedBackend ? 'one request counter increment' : 'probe was not uniquely identified by request counters',
  };
}

function emptyPoolRequestCounts() {
  return Object.fromEntries(config.pools.map(pool => [pool.id, 0]));
}

function currentTraffic() {
  if (!trafficRun) {
    return {
      status: 'READY', phase: 'idle', running: false, target: 'site-gateway-grid-site-route',
      requested: 0, completed: 0, succeeded: 0, failed: 0, attributed: 0, unattributed: 0,
      countsByPool: emptyPoolRequestCounts(), results: [],
    };
  }
  return {
    status: 'LIVE', id: trafficRun.id, phase: trafficRun.phase, running: trafficRun.running,
    target: 'site-gateway-grid-site-route',
    requested: trafficRun.requested, completed: trafficRun.completed, succeeded: trafficRun.succeeded,
    failed: trafficRun.failed, attributed: trafficRun.attributed, unattributed: trafficRun.unattributed,
    countsByPool: { ...trafficRun.countsByPool }, startedAt: trafficRun.startedAt,
    finishedAt: trafficRun.finishedAt || null, results: [...trafficRun.results],
    error: trafficRun.error || null,
  };
}

function responsePool(headers) {
  return config.pools.find(pool => pool.id === headers.backend && pool.site === headers.site) || null;
}

function siteGatewayRouteReady(state) {
  const route = state.gatewayMetrics?.crossSite;
  const maxAge = Number.isFinite(route?.freshnessWindowMs) ? route.freshnessWindowMs / 1000 : null;
  const candidates = route?.candidates || [];
  const poolsReady = state.pools.length === config.pools.length && state.pools.every(pool =>
    pool.source.status === 'LIVE' && pool.modelReady.status === 'LIVE' && pool.modelReady.value === 1 &&
    pool.activeRequests.status === 'LIVE' && Number.isFinite(pool.activeRequests.value) && pool.activeRequests.value >= 0);
  return state.peer?.status === 'LIVE' && state.peer.signals?.status === 'LIVE' && state.peer.signals.value === true &&
    poolsReady && route?.status === 'LIVE' && Number.isFinite(route.ageSeconds) && route.ageSeconds <= 5 &&
    candidates.length === config.pools.length &&
    Number.isFinite(maxAge) && candidates.every(candidate =>
      candidate.scoreStatus === 'LIVE' && Number.isFinite(candidate.score) &&
      Number.isFinite(candidate.rho) && Number.isFinite(candidate.sampleAgeSeconds) &&
      candidate.sampleAgeSeconds <= maxAge);
}

function siteGatewaySeesFullPoolPressure(state, poolId) {
  const pool = state.pools.find(item => item.id === poolId);
  const candidate = state.gatewayMetrics?.crossSite?.candidates?.find(item => item.cluster === poolId);
  const maxAge = Number.isFinite(state.gatewayMetrics?.crossSite?.freshnessWindowMs)
    ? state.gatewayMetrics.crossSite.freshnessWindowMs / 1000 : null;
  return pool?.activeRequests?.status === 'LIVE' && pool.activeRequests.value >= pool.capacity &&
    candidate?.scoreStatus === 'LIVE' && Number.isFinite(candidate.rho) && candidate.rho >= 1 &&
    Number.isFinite(candidate.sampleAgeSeconds) && Number.isFinite(maxAge) && candidate.sampleAgeSeconds <= maxAge;
}

function findCandidate(overlay, cluster) {
  return overlay?.candidates?.find(item => item.cluster === cluster && (item.model ?? item.name) === MODEL) || null;
}

function pressureRunState(run) {
  if (!run) return null;
  const { id, label, site, namespace, context, pod } = run.target;
  return {
    phase: run.phase,
    target: { id, label, site, namespace, context, pod, routeScope: run.routeScope },
    baselineRevision: run.baselineRevision,
    routeScope: run.routeScope,
    workerCount: run.workerCount,
    inFlight: run.inFlight,
    completed: run.completed,
    valid: run.valid,
    failed: run.failed,
    startedAt: run.startedAt,
    endsAt: run.endsAt,
    gate: run.gate || null,
    recovery: run.recovery || null,
    error: run.error || null,
  };
}

function pressureRunsInProgress() {
  return [...pressureRuns.values()].filter(run =>
    ['starting', 'applied', 'recovering', 'recovery-pending', 'failed'].includes(run.phase));
}

function currentPressure() {
  const runsByPool = Object.fromEntries(config.pools.map(pool => {
    const run = pressureRuns.get(pool.id);
    return [pool.id, pressureRunState(run) || {
      phase: 'idle', target: { id: pool.id, label: poolDisplayName(pool.id) },
      workerCount: 0, inFlight: 0, completed: 0, valid: 0, failed: 0,
      startedAt: null, endsAt: null, gate: null, recovery: null, error: null,
    }];
  }));
  const active = pressureRunsInProgress();
  const primary = active.at(-1) || latestPressureRun;
  if (!primary) {
    return {
      phase: 'idle', workerCount: 0, inFlight: 0, completed: 0, valid: 0,
      failed: 0, startedAt: null, endsAt: null, target: null,
      activeTargets: [], runsByPool,
    };
  }
  const aggregatePhase = active.some(run => run.phase === 'starting') ? 'starting'
    : active.some(run => ['recovering', 'recovery-pending'].includes(run.phase)) ? 'recovering'
      : active.some(run => run.phase === 'failed') ? 'failed'
        : active.length ? 'applied' : primary.phase;
  return {
    ...pressureRunState(primary),
    phase: aggregatePhase,
    activeTargets: active.map(run => run.target.id),
    runsByPool,
  };
}

function currentInterruption(peer) {
  if (!interruptionRun) {
    const originalAddress = config.peer.remoteSignalsAddress;
    const separator = originalAddress.lastIndexOf(':');
    const expectedInterruptedAddress = separator < 0 ? null
      : `${originalAddress.slice(0, separator)}:${config.peer.unservedPort}`;
    if (peer?.status === 'LIVE' && peer.signals?.status === 'LIVE' && peer.signals.value === false &&
        peer.signalsAddress === expectedInterruptedAddress && peer.gatewayAddress === config.peer.remoteGatewayAddress) {
      return {
        phase: 'interrupted', originalAddress, interruptedAddress: expectedInterruptedAddress,
        providerGatewayReachable: null,
      };
    }
    return { phase: 'idle', originalAddress: null, interruptedAddress: null };
  }
  return {
    phase: interruptionRun.phase,
    originalAddress: interruptionRun.originalAddress,
    interruptedAddress: interruptionRun.interruptedAddress,
    providerGatewayReachable: interruptionRun.providerGatewayReachable ?? null,
    fallbackProbe: interruptionRun.fallbackProbe || null,
    recoveryProbe: interruptionRun.recoveryProbe || null,
    error: interruptionRun.error || null,
  };
}

async function readState({ recordSample = true } = {}) {
  const metricReads = config.pools.map(pool => readMetrics(`pool:${pool.id}`, pool.metricsUrl));
  const gatewayReads = [
    readMetrics('gateway:local', config.gateways.local.metricsUrl),
    readMetrics('gateway:crossSite', config.gateways.crossSite.metricsUrl),
  ];
  const [poolSources, gatewaySources, published, consumed, peer] = await Promise.all([
    Promise.all(metricReads), Promise.all(gatewayReads), readPublishedOverlay(), readConsumedOverlay(), readPeerStatus(),
  ]);
  const pools = config.pools.map((pool, index) => poolFromMetrics(pool, poolSources[index]));
  const candidates = published.value?.candidates || [];
  const poolCandidates = candidates.map(item => ({
    site: item.site, cluster: item.cluster, model: item.name,
    score: Number.isFinite(item.score) ? item.score : null,
    rank: Number.isInteger(item.rank) ? item.rank + 1 : null,
    fresh: item.fresh === true,
    admission: item.admission_state || null,
  }));
  const localGatewayDecisionMetrics = decisionMetrics(gatewaySources[0]);
  const crossSiteGatewayDecisionMetrics = decisionMetrics(gatewaySources[1]);
  const publishedOverlay = {
    status: published.status,
    revision: published.value?.revision || null,
    observedAt: published.value?.observedAt || published.observedAt,
    ageSeconds: published.ageSeconds,
    candidates: poolCandidates,
  };
  const consumedOverlay = {
    status: consumed.status,
    revision: consumed.value?.revision || null,
    observedAt: consumed.value?.observedAt || consumed.observedAt,
    ageSeconds: consumed.ageSeconds,
  };
  const source = {
    status: pools.every(pool => pool.source.status === 'LIVE') && published.status === 'LIVE' && consumed.status === 'LIVE' ? 'LIVE' : 'PARTIAL',
    observedAt: utcNow(),
  };
  const sample = {
    sampledAt: source.observedAt,
    poolAActive: pools[0]?.activeRequests.value,
    poolAActiveStatus: pools[0]?.activeRequests.status,
    activeByPool: Object.fromEntries(pools.map(pool => [pool.id, {
      value: pool.activeRequests.value,
      status: pool.activeRequests.status,
    }])),
    poolAScore: findCandidate(published.value, 'pool-a')?.score,
    poolARank: findCandidate(published.value, 'pool-a')?.rank,
    poolBRank: findCandidate(published.value, 'pool-b')?.rank,
    publishedRevision: publishedOverlay.revision,
    consumedRevision: consumedOverlay.revision,
  };
  if (recordSample) {
    history.push(sample);
    if (history.length > 180) history.shift();
  }
  return {
    runId: config.runId,
    timestamp: source.observedAt,
    source,
    identity: config.identity,
    clusters: {
      hub: { name: config.kubernetes.hub.name, context: config.kubernetes.hub.context, nodeIp: config.kubernetes.hub.nodeIp },
      site: { name: config.kubernetes.site.name, context: config.kubernetes.site.context, nodeIp: config.kubernetes.site.nodeIp },
    },
    model: MODEL,
    profile: config.profile,
    pools,
    overlay: {
      published: publishedOverlay,
      consumed: consumedOverlay,
      converged: publishedOverlay.status === 'LIVE' && consumedOverlay.status === 'LIVE' &&
        Boolean(publishedOverlay.revision && publishedOverlay.revision === consumedOverlay.revision),
    },
    gatewayMetrics: {
      local: { status: gatewaySources[0].status, observedAt: gatewaySources[0].observedAt, ageSeconds: gatewaySources[0].ageSeconds, decisions: routeCounts(gatewaySources[0]), requests: gatewayRequestCounts(gatewaySources[0]), candidates: localGatewayDecisionMetrics.candidates },
      crossSite: {
        status: gatewaySources[1].status, observedAt: gatewaySources[1].observedAt, ageSeconds: gatewaySources[1].ageSeconds,
        freshnessWindowMs: config.gateways.crossSite.loadWindowMs,
        decisions: routeCounts(gatewaySources[1]), requests: gatewayRequestCounts(gatewaySources[1]), candidates: crossSiteGatewayDecisionMetrics.candidates,
      },
    },
    peer: { ...peer.value, status: peer.status, observedAt: peer.observedAt, ageSeconds: peer.ageSeconds },
    traffic: currentTraffic(),
    pressure: currentPressure(),
    interruption: currentInterruption(peer.value),
    probes: actionLog.probes.slice(-8),
    history: [...history],
  };
}

function validCompletion(payload) {
  const choices = payload?.choices;
  const content = choices?.[0]?.message?.content;
  return Array.isArray(choices) && choices.length > 0 && typeof content === 'string' && content.trim().length > 0;
}

function responseHeaders(response) {
  return {
    site: response.headers.get('x-grid-site'),
    backend: response.headers.get('x-grid-backend'),
    providerSite: response.headers.get('x-grid-provider-site'),
  };
}

async function sendChat(url, requestId, timeoutMs = 45000, parentSignal = null) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(REQUEST_BODY),
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { raw: raw.slice(0, 1000) }; }
  const content = payload?.choices?.[0]?.message?.content;
  return {
    status: response.status,
    valid: response.ok && validCompletion(payload),
    headers: responseHeaders(response),
    content: typeof content === 'string' ? content.slice(0, 500) : null,
    payload,
  };
}

function headerRecord(headers, kind) {
  const localOverlayRoute = kind === 'local';
  const localSiteRoute = kind === 'crossSite' && headers.site === config.grid.remoteSite;
  return {
    site: headers.site || null,
    backend: headers.backend || null,
    providerSite: headers.providerSite || null,
    siteContract: headers.site ? 'emitted' : localOverlayRoute ? 'not emitted by this route' : 'unavailable',
    backendContract: headers.backend ? 'emitted' : localOverlayRoute ? 'not emitted by this route' : 'unavailable',
    providerSiteContract: headers.providerSite ? 'emitted' : localOverlayRoute || localSiteRoute
      ? 'not emitted by this route' : 'unavailable',
  };
}

async function probeGateway(kind = 'local') {
  const target = kind === 'crossSite' ? config.gateways.crossSite : config.gateways.local;
  const requestId = `${config.runId}-probe-${randomUUID()}`;
  const before = await readState({ recordSample: false });
  const startAt = utcNow();
  let result;
  try {
    result = await sendChat(target.chatUrl, requestId);
  } catch (error) {
    result = { status: 0, valid: false, headers: { site: null, backend: null, providerSite: null }, content: null, error: safeError(error) };
  }
  const endAt = utcNow();
  const after = await readState({ recordSample: false });
  const gatewayKey = kind === 'crossSite' ? 'crossSite' : 'local';
  const gatewayMetricsBefore = before.gatewayMetrics[gatewayKey];
  const gatewayMetricsAfter = after.gatewayMetrics[gatewayKey];
  const localOverlay = kind === 'local';
  const routingEvidence = localOverlay
    ? {
      scope: 'hub-local-pressure-overlay',
      status: before.overlay.published.status === 'LIVE' && before.overlay.consumed.status === 'LIVE' ? 'LIVE' : 'UNAVAILABLE',
      publishedRevision: before.overlay.published.revision,
      consumedRevision: before.overlay.consumed.revision,
      publishedRevisionAfter: after.overlay.published.revision,
      consumedRevisionAfter: after.overlay.consumed.revision,
      convergedBefore: before.overlay.converged,
      convergedAfter: after.overlay.converged,
      candidates: before.overlay.published.candidates,
      gatewayRequestDelta: gatewayRequestDelta(gatewayMetricsBefore.requests, gatewayMetricsAfter.requests),
    }
    : {
      scope: 'site-grid-site-route-snapshot',
      status: gatewayMetricsBefore.status,
      peerSignals: {
        status: before.peer.signals?.status || 'UNAVAILABLE',
        reachable: before.peer.signals?.value ?? null,
        observedAt: before.peer.signals?.observedAt || null,
      },
      peerSignalsAfter: {
        status: after.peer.signals?.status || 'UNAVAILABLE',
        reachable: after.peer.signals?.value ?? null,
        observedAt: after.peer.signals?.observedAt || null,
      },
      candidates: gatewayMetricsBefore.candidates,
      gatewayRequestDelta: gatewayRequestDelta(gatewayMetricsBefore.requests, gatewayMetricsAfter.requests),
    };
  const record = {
    id: randomUUID(), kind,
    requestId, startedAt: startAt, completedAt: endAt,
    status: result.status, validResponse: result.valid,
    attribution: headerRecord(result.headers, kind), response: result.content,
    responseBodyShapeValid: result.valid,
    frontendSample: before.pools.map(pool => ({
      id: pool.id,
      observedAt: pool.activeRequests.observedAt,
      sourceStatus: pool.source.status,
      modelReady: { value: pool.modelReady.value, status: pool.modelReady.status, observedAt: pool.modelReady.observedAt },
      activeRequests: pool.activeRequests.value,
      activeRequestsStatus: pool.activeRequests.status,
      capacity: pool.capacity,
      profile: pool.profile,
    })),
    gridCandidates: routingEvidence.candidates,
    routingEvidence,
    overlayScope: routingEvidence.scope,
    overlayPublishedBefore: localOverlay ? before.overlay.published.revision : null,
    overlayPublishedAfter: localOverlay ? after.overlay.published.revision : null,
    overlayConsumedBefore: localOverlay ? before.overlay.consumed.revision : null,
    overlayConsumedAfter: localOverlay ? after.overlay.consumed.revision : null,
    gatewayMetricsBefore,
    gatewayMetricsAfter,
    error: result.error || null,
  };
  actionLog.probes.push(record);
  if (actionLog.probes.length > 24) actionLog.probes.shift();
  writeEvidence({ type: 'gateway-probe', ...record });
  return record;
}

async function trafficWorker(run) {
  while (!run.controller.signal.aborted) {
    const slot = Math.max(Date.now(), run.nextStartAt);
    run.nextStartAt = slot + run.intervalMs;
    const waitMs = slot - Date.now();
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    if (run.controller.signal.aborted || run.nextSequence >= run.requested) return;

    const sequence = ++run.nextSequence;
    const requestId = `${run.id}-request-${sequence}`;
    const startedAt = utcNow();
    const started = Date.now();
    let result;
    try {
      result = await sendChat(config.gateways.crossSite.chatUrl, requestId, 45000, run.controller.signal);
    } catch (error) {
      result = {
        status: 0, valid: false, headers: { site: null, backend: null, providerSite: null },
        content: null, payload: null, error: safeError(error),
      };
    }
    const completedAt = utcNow();
    const attribution = headerRecord(result.headers, 'crossSite');
    const selectedPool = responsePool(result.headers);
    run.completed += 1;
    if (result.valid) run.succeeded += 1;
    else run.failed += 1;
    if (selectedPool) {
      run.attributed += 1;
      run.countsByPool[selectedPool.id] += 1;
    } else {
      run.unattributed += 1;
    }
    const record = {
      sequence, requestId, startedAt, completedAt, status: result.status,
      validResponse: result.valid, durationMs: Date.now() - started,
      poolId: selectedPool?.id || null, attribution,
      error: result.error || null,
    };
    run.results.unshift(record);
    if (run.results.length > run.requested) run.results.length = run.requested;
    writeEvidence({
      type: 'site-gateway-sampler-request', samplerId: run.id, ...record,
      source: 'Site Gateway response site/backend headers',
    });
  }
}

async function startTraffic(body = {}) {
  if (trafficRun?.running) {
    throw Object.assign(new Error('a Site Gateway request sample is already running'), { statusCode: 409 });
  }
  if (resetBusy) throw Object.assign(new Error('baseline reset is in progress'), { statusCode: 409 });
  const pressureActionsPending = pressureRunsInProgress().filter(run => run.phase !== 'applied');
  if (pressureActionsPending.length) {
    throw Object.assign(new Error('wait for the pressure action to settle before generating a request sample'), { statusCode: 409 });
  }
  const baseline = await readState({ recordSample: false });
  if (!siteGatewayRouteReady(baseline)) {
    throw Object.assign(new Error('Site Gateway route snapshot is unavailable or stale; no traffic was generated'), { statusCode: 409 });
  }
  const count = Math.min(24, Math.max(1, Number.parseInt(body.count ?? 12, 10) || 12));
  const concurrency = Math.min(4, Math.max(1, Number.parseInt(body.concurrency ?? 3, 10) || 3));
  const rate = Math.min(4, Math.max(0.5, Number(body.rate ?? 3) || 3));
  const appliedPressureRuns = pressureRunsInProgress().filter(run => run.phase === 'applied');
  if (appliedPressureRuns.length) {
    try {
      await waitFor(state => siteGatewayRouteReady(state) && appliedPressureRuns.every(run =>
        siteGatewaySeesFullPoolPressure(state, run.target.id)), 30000, 1000);
    } catch {
      const targets = appliedPressureRuns.map(run => run.target.label).join(', ');
      throw Object.assign(new Error(`Site Gateway has not observed pressure on ${targets} at the configured Grid comparison reference; no traffic was generated`), { statusCode: 409 });
    }
  }
  const now = Date.now();
  const run = {
    id: `${config.runId}-sampler-${randomUUID()}`,
    phase: 'running', running: true, requested: count, concurrency, rate,
    completed: 0, succeeded: 0, failed: 0, attributed: 0, unattributed: 0,
    countsByPool: emptyPoolRequestCounts(), results: [], nextSequence: 0,
    nextStartAt: now, intervalMs: Math.max(250, Math.round(1000 / rate)),
    startedAt: utcNow(), finishedAt: null, controller: new AbortController(),
  };
  trafficRun = run;
  run.workers = Array.from({ length: concurrency }, () => trafficWorker(run));
  run.done = Promise.allSettled(run.workers).then(results => {
    run.running = false;
    run.finishedAt = utcNow();
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) {
      run.phase = 'failed';
      run.error = 'one or more bounded request workers failed';
    } else {
      run.phase = run.controller.signal.aborted ? 'stopped' : 'completed';
    }
    writeEvidence({
      type: 'site-gateway-sampler-finished', samplerId: run.id, phase: run.phase,
      requested: run.requested, completed: run.completed, succeeded: run.succeeded,
      failed: run.failed, attributed: run.attributed, unattributed: run.unattributed,
      countsByPool: run.countsByPool,
    });
  });
  writeEvidence({
    type: 'site-gateway-sampler-started', samplerId: run.id,
    gateway: 'crossSite', requested: count, concurrency, rate,
    pressurePhase: appliedPressureRuns.length ? 'applied' : 'baseline',
    pressureTargets: appliedPressureRuns.map(pressure => pressure.target.id),
  });
  return { traffic: currentTraffic() };
}

async function stopTraffic() {
  if (!trafficRun?.running) return { traffic: currentTraffic() };
  const run = trafficRun;
  run.phase = 'stopping';
  run.controller.abort();
  await run.done;
  return { traffic: currentTraffic() };
}

async function pressureWorker(run, workerIndex) {
  let sequence = 0;
  while (!run.controller.signal.aborted && Date.now() < run.deadline) {
    sequence += 1;
    const requestId = `${run.id}-load-${workerIndex}-${sequence}`;
    run.inFlight += 1;
    const startedAt = utcNow();
    try {
      const response = await fetch(run.target.chatUrl, {
        method: 'POST',
        signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(90000)]),
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify(REQUEST_BODY),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      const valid = response.ok && validCompletion(payload);
      run.completed += 1;
      run.valid += Number(valid);
      run.failed += Number(!valid);
      writeEvidence({ type: 'direct-mocker-request', requestId, pool: run.target.id, startedAt, completedAt: utcNow(), httpStatus: response.status, validResponse: valid });
    } catch (error) {
      if (!run.controller.signal.aborted) {
        run.failed += 1;
        writeEvidence({ type: 'direct-mocker-request', requestId, pool: run.target.id, startedAt, completedAt: utcNow(), httpStatus: 0, validResponse: false, error: safeError(error) });
      }
    } finally {
      run.inFlight -= 1;
    }
  }
}

function localCandidate(state, poolId) {
  return findCandidate(state.overlay?.published, poolId);
}

function crossSiteCandidate(state, poolId) {
  return state.gatewayMetrics?.crossSite?.candidates?.find(candidate => candidate.cluster === poolId) || null;
}

function pressureTransitionObserved(state, run) {
  const targetPool = state.pools.find(pool => pool.id === run.target.id);
  const active = targetPool?.activeRequests;
  if (active?.status !== 'LIVE' || !Number.isFinite(active.value) || active.value < targetPool.capacity) return false;

  if (run.routeScope === 'hub-local-pressure-overlay') {
    const candidates = state.overlay.published.candidates.filter(candidate => ['pool-a', 'pool-b'].includes(candidate.cluster));
    const target = candidates.find(candidate => candidate.cluster === run.target.id);
    const alternate = candidates.find(candidate => candidate.cluster !== run.target.id);
    const siteRoute = state.gatewayMetrics.crossSite;
    const siteTarget = crossSiteCandidate(state, run.target.id);
    const maxAge = Number.isFinite(siteRoute?.freshnessWindowMs) ? siteRoute.freshnessWindowMs / 1000 : null;
    const siteAlternates = siteRoute?.candidates?.filter(candidate => candidate.cluster !== run.target.id &&
      candidate.scoreStatus === 'LIVE' && Number.isInteger(candidate.scoreOrder) &&
      Number.isFinite(candidate.sampleAgeSeconds) && Number.isFinite(maxAge) && candidate.sampleAgeSeconds <= maxAge) || [];
    const sitePressureObserved = siteRoute?.status === 'LIVE' && Number.isFinite(siteRoute.ageSeconds) && siteRoute.ageSeconds <= 5 &&
      siteTarget?.scoreStatus === 'LIVE' && Number.isFinite(siteTarget.rho) && siteTarget.rho >= 1 &&
      Number.isInteger(siteTarget.scoreOrder) && Number.isFinite(siteTarget.sampleAgeSeconds) &&
      Number.isFinite(maxAge) && siteTarget.sampleAgeSeconds <= maxAge && siteAlternates.length > 0 &&
      siteTarget.scoreOrder > Math.min(...siteAlternates.map(candidate => candidate.scoreOrder));
    return state.overlay.published.status === 'LIVE' && state.overlay.consumed.status === 'LIVE' &&
      Number.isInteger(target?.rank) && Number.isInteger(alternate?.rank) &&
      state.overlay.published.revision !== run.baselineRevision && state.overlay.converged && sitePressureObserved;
  }

  const route = state.gatewayMetrics.crossSite;
  const maxAge = Number.isFinite(route?.freshnessWindowMs) ? route.freshnessWindowMs / 1000 : null;
  const target = crossSiteCandidate(state, run.target.id);
  const alternates = route?.candidates?.filter(candidate => candidate.cluster !== run.target.id &&
    candidate.scoreStatus === 'LIVE' && Number.isInteger(candidate.scoreOrder) &&
    Number.isFinite(candidate.sampleAgeSeconds) && Number.isFinite(maxAge) && candidate.sampleAgeSeconds <= maxAge) || [];
  return route?.status === 'LIVE' && Number.isFinite(route.ageSeconds) && route.ageSeconds <= 5 &&
    target?.scoreStatus === 'LIVE' && Number.isFinite(target.rho) && target.rho >= 1 &&
    Number.isInteger(target.scoreOrder) && Number.isFinite(target.sampleAgeSeconds) &&
    Number.isFinite(maxAge) && target.sampleAgeSeconds <= maxAge && alternates.length > 0 &&
    target.scoreOrder > Math.min(...alternates.map(candidate => candidate.scoreOrder));
}

function recoveryObserved(state, run) {
  const targetPool = state.pools.find(pool => pool.id === run.target.id);
  if (targetPool?.activeRequests?.status !== 'LIVE' || targetPool.activeRequests.value !== 0) return false;

  const route = state.gatewayMetrics.crossSite;
  const maxAge = Number.isFinite(route?.freshnessWindowMs) ? route.freshnessWindowMs / 1000 : null;
  const siteTarget = crossSiteCandidate(state, run.target.id);
  const siteRouteRecovered = siteGatewayRouteReady(state) && siteTarget?.scoreStatus === 'LIVE' &&
    Number.isFinite(siteTarget.rho) && siteTarget.rho < 1 &&
    Number.isFinite(siteTarget.sampleAgeSeconds) && Number.isFinite(maxAge) && siteTarget.sampleAgeSeconds <= maxAge;
  if (!siteRouteRecovered) return false;

  if (run.routeScope === 'hub-local-pressure-overlay') {
    const candidateA = localCandidate(state, 'pool-a');
    const candidateB = localCandidate(state, 'pool-b');
    const targetCandidate = run.target.id === 'pool-a' ? candidateA : candidateB;
    return state.overlay.published.status === 'LIVE' && state.overlay.consumed.status === 'LIVE' &&
      Number.isInteger(candidateA?.rank) && Number.isInteger(candidateB?.rank) &&
      Number.isInteger(targetCandidate?.rank) &&
      state.overlay.published.revision !== run.gate?.publishedRevision &&
      state.overlay.converged;
  }
  return siteRouteRecovered;
}

function resetBaselineObserved(state) {
  const candidateA = state.overlay.published.candidates.find(item => item.cluster === 'pool-a');
  const candidateB = state.overlay.published.candidates.find(item => item.cluster === 'pool-b');
  const poolsReady = state.pools.length === config.pools.length && state.pools.every(pool =>
    pool.source.status === 'LIVE' && pool.source.ageSeconds <= 5 &&
    pool.modelReady.status === 'LIVE' && pool.modelReady.value === 1 &&
    pool.activeRequests.status === 'LIVE' && pool.activeRequests.value === 0);
  return poolsReady && state.overlay.published.status === 'LIVE' && state.overlay.consumed.status === 'LIVE' &&
    state.overlay.converged &&
    candidateA?.rank !== undefined && candidateB?.rank !== undefined && candidateA.rank < candidateB.rank &&
    state.peer?.signals?.status === 'LIVE' && state.peer.signals.value === true;
}

async function waitFor(predicate, timeoutMs, intervalMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readState();
    if (predicate(lastState)) return lastState;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const error = new Error('live proof gate timed out');
  error.lastState = lastState;
  throw error;
}

async function startPressure(body = {}) {
  if (trafficRun?.running) {
    throw Object.assign(new Error('stop the Site Gateway request sample before applying direct pool pressure'), { statusCode: 409 });
  }
  if (resetBusy) throw Object.assign(new Error('baseline reset is in progress'), { statusCode: 409 });
  const profileReady = typeof config.profile.id === 'string' && config.profile.id.trim().length > 0 &&
    Number.isSafeInteger(CAPACITY) && CAPACITY > 0 && CAPACITY <= 8 &&
    Number.isSafeInteger(MAX_PRESSURE_SECONDS) && MAX_PRESSURE_SECONDS > 0 && MAX_PRESSURE_SECONDS <= 300;
  if (!profileReady) {
    throw Object.assign(new Error('bounded comparable pressure profile or capacity is unavailable'), { statusCode: 409 });
  }
  const targetId = typeof body.targetPoolId === 'string' ? body.targetPoolId : 'pool-a';
  const configuredTarget = config.pools.find(pool => pool.id === targetId);
  if (!configuredTarget) throw Object.assign(new Error('select one of the configured Dynamo pools'), { statusCode: 400 });
  const unsettledOtherRuns = pressureRunsInProgress().filter(run => run.target.id !== targetId &&
    ['starting', 'recovering', 'recovery-pending', 'failed'].includes(run.phase));
  if (unsettledOtherRuns.length) {
    throw Object.assign(new Error('wait for other pressure actions to settle before adding pressure to another pool'), { statusCode: 409 });
  }
  const existingRun = pressureRuns.get(targetId);
  if (existingRun && existingRun.phase !== 'recovered') {
    throw Object.assign(new Error(`pressure for ${poolDisplayName(targetId)} must be recovered before it can be started again`), { statusCode: 409 });
  }
  const target = { ...configuredTarget, label: poolDisplayName(configuredTarget.id) };
  const routeScope = targetId === 'site-pool' ? 'site-grid-site-route-snapshot' : 'hub-local-pressure-overlay';
  const baseline = await readState({ recordSample: false });
  const targetPool = baseline.pools.find(pool => pool.id === targetId);
  const allPoolsReady = baseline.pools.length === config.pools.length && baseline.pools.every(pool =>
    pool.source.status === 'LIVE' && pool.source.ageSeconds <= 5 &&
    pool.modelReady.status === 'LIVE' && pool.modelReady.value === 1 &&
    pool.activeRequests.status === 'LIVE' && Number.isFinite(pool.activeRequests.value) && pool.activeRequests.value >= 0);
  const targetIdle = targetPool?.activeRequests?.status === 'LIVE' && targetPool.activeRequests.value === 0;
  const validTargetProfile = targetPool?.profile === config.profile.id && targetPool.capacity === CAPACITY;
  const localCandidatesReady = ['pool-a', 'pool-b'].every(poolId => Number.isInteger(localCandidate(baseline, poolId)?.rank));
  const routeReady = siteGatewayRouteReady(baseline) && (routeScope === 'hub-local-pressure-overlay'
    ? baseline.overlay.converged && localCandidatesReady
    : Number.isInteger(crossSiteCandidate(baseline, targetId)?.scoreOrder));
  if (!allPoolsReady || !targetIdle || !validTargetProfile || !routeReady) {
    throw Object.assign(new Error(`fresh signals, a zero-active target, and a live ${routeScope} view are required before pressuring ${target.label}`), { statusCode: 409 });
  }
  const now = Date.now();
  const run = {
    id: `${config.runId}-pressure-${targetId}-${randomUUID()}`,
    target,
    routeScope,
    workerCount: CAPACITY,
    inFlight: 0,
    completed: 0,
    valid: 0,
    failed: 0,
    startedAt: utcNow(),
    endsAt: new Date(now + MAX_PRESSURE_SECONDS * 1000).toISOString(),
    deadline: now + MAX_PRESSURE_SECONDS * 1000,
    baselineRevision: baseline.overlay.published.revision,
    baselineTargetRank: routeScope === 'hub-local-pressure-overlay'
      ? localCandidate(baseline, targetId)?.rank
      : crossSiteCandidate(baseline, targetId)?.scoreOrder,
    phase: 'starting',
    controller: new AbortController(),
  };
  pressureRuns.set(targetId, run);
  latestPressureRun = run;
  run.workers = Array.from({ length: CAPACITY }, (_, i) => pressureWorker(run, i + 1));
  run.done = Promise.allSettled(run.workers).then(() => {
    if (run.phase === 'applied') run.phase = 'recovering';
  });
  writeEvidence({ type: 'pressure-start', pressureId: run.id, target: target.id, routeScope, profile: config.profile.id, capacity: CAPACITY, baselineRevision: run.baselineRevision, baselineTargetRank: run.baselineTargetRank, workerCount: CAPACITY, boundedSeconds: MAX_PRESSURE_SECONDS });
  actionLog.pressure = { startedAt: run.startedAt, target: target.id, routeScope, baselineRevision: run.baselineRevision, pressureId: run.id };
  try {
    const state = await waitFor(current => pressureTransitionObserved(current, run), 65000);
    run.phase = 'applied';
    const targetPoolState = state.pools.find(pool => pool.id === target.id);
    const targetRouteCandidate = routeScope === 'hub-local-pressure-overlay'
      ? localCandidate(state, target.id)
      : crossSiteCandidate(state, target.id);
    run.gate = {
      observedAt: state.timestamp,
      targetPool: target.id,
      activeRequests: targetPoolState?.activeRequests.value,
      profile: targetPoolState?.profile,
      capacity: targetPoolState?.capacity,
      routeScope,
      targetRank: targetRouteCandidate?.rank ?? targetRouteCandidate?.scoreOrder ?? null,
      publishedRevision: routeScope === 'hub-local-pressure-overlay' ? state.overlay.published.revision : null,
      consumedRevision: routeScope === 'hub-local-pressure-overlay' ? state.overlay.consumed.revision : null,
    };
    writeEvidence({ type: 'pressure-gate', pressureId: run.id, ...run.gate });
    return await readState();
  } catch (error) {
    run.error = `active signal and ${routeScope} preference change were not observed for ${target.label}`;
    run.phase = 'failed';
    run.controller.abort();
    await run.done;
    writeEvidence({ type: 'pressure-gate-failed', pressureId: run.id, target: target.id, error: run.error, completed: run.completed, valid: run.valid, failed: run.failed });
    throw Object.assign(new Error(run.error), { statusCode: 504 });
  }
}

async function stopPressureRun(run) {
  if (!run || run.phase === 'recovered') return;
  if (run.stopPromise) return run.stopPromise;
  run.stopPromise = (async () => {
    run.phase = 'recovering';
    run.controller.abort();
    await run.done;
    try {
      const state = await waitFor(current => recoveryObserved(current, run), 90000);
      run.phase = 'recovered';
      run.recovery = {
        observedAt: state.timestamp,
        targetPool: run.target.id,
        activeRequests: state.pools.find(pool => pool.id === run.target.id)?.activeRequests.value,
        routeScope: run.routeScope,
        publishedRevision: state.overlay.published.revision,
        consumedRevision: state.overlay.consumed.revision,
      };
      writeEvidence({ type: 'pressure-recovery', pressureId: run.id, ...run.recovery, completed: run.completed, valid: run.valid, failed: run.failed });
    } catch {
      run.phase = 'recovery-pending';
      run.error = 'fresh zero-active and revision convergence were not observed';
      run.stopPromise = null;
      writeEvidence({ type: 'pressure-recovery-pending', pressureId: run.id, target: run.target.id, completed: run.completed, valid: run.valid, failed: run.failed });
      throw Object.assign(new Error(`${run.error} for ${run.target.label}`), { statusCode: 504 });
    }
  })();
  return run.stopPromise;
}

async function stopPressure(body = {}) {
  const targetId = typeof body.targetPoolId === 'string' ? body.targetPoolId : null;
  if (targetId && !config.pools.some(pool => pool.id === targetId)) {
    throw Object.assign(new Error('select one of the configured Dynamo pools'), { statusCode: 400 });
  }
  const runs = targetId ? [pressureRuns.get(targetId)].filter(Boolean) : pressureRunsInProgress();
  const results = await Promise.allSettled(runs.map(stopPressureRun));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return await readState();
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = reachable => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

async function updatePeerSignalAddress(address, expectedCurrentAddress = null) {
  const peerCluster = config.kubernetes[config.peer.gridSiteCluster];
  const object = await kubeJson(peerCluster, ['get', 'gridsite', config.peer.remoteSiteResource]);
  if (object.metadata?.labels?.['praxis.fast/run-id'] !== config.peer.runLabel) {
    throw new Error('remote GridSite ownership label does not match this run');
  }
  const gatewayAddress = object.spec?.gatewayEndpoint?.address;
  if (gatewayAddress !== config.peer.remoteGatewayAddress) {
    throw new Error('remote provider Gateway endpoint changed; refusing signal update');
  }
  const originalSignalAddress = object.spec?.signalsEndpoint?.address;
  if (!originalSignalAddress) throw new Error('remote signal endpoint address is absent');
  if (expectedCurrentAddress && originalSignalAddress !== expectedCurrentAddress) {
    throw new Error('remote signal endpoint changed; refusing to overwrite it');
  }
  const patch = JSON.stringify({ spec: { signalsEndpoint: { address } } });
  await kubeText(peerCluster, [
    'patch', 'gridsite', config.peer.remoteSiteResource, '--type=merge', '-p', patch,
  ]);
  return { gatewayAddress, originalSignalAddress };
}

async function interruptPeer() {
  if (interruptionRun?.phase === 'interrupted') throw Object.assign(new Error('signal endpoint is already interrupted'), { statusCode: 409 });
  if (pressureRunsInProgress().some(run => ['starting', 'applied', 'recovering', 'recovery-pending'].includes(run.phase))) {
    throw Object.assign(new Error('recover pressure before interrupting the peer endpoint'), { statusCode: 409 });
  }
  const peerCluster = config.kubernetes[config.peer.gridSiteCluster];
  const source = await kubeJson(peerCluster, ['get', 'gridsite', config.peer.remoteSiteResource]);
  if (source.metadata?.labels?.['praxis.fast/run-id'] !== config.peer.runLabel) throw new Error('remote GridSite is outside this run');
  const gatewayAddress = source.spec?.gatewayEndpoint?.address;
  const signalAddress = source.spec?.signalsEndpoint?.address;
  if (gatewayAddress !== config.peer.remoteGatewayAddress || signalAddress !== config.peer.remoteSignalsAddress) {
    throw new Error('peer endpoint identity does not match the locked run configuration');
  }
  const host = signalAddress.slice(0, signalAddress.lastIndexOf(':'));
  const originalPort = Number(signalAddress.split(':').at(-1));
  const broken = `${host}:${config.peer.unservedPort}`;
  if (!await tcpProbe(host, originalPort)) throw new Error('original peer signal port is not reachable; refusing to label this an endpoint interruption');
  if (broken === signalAddress || await tcpProbe(host, config.peer.unservedPort)) throw new Error('configured interruption port is not verified unserved');
  const gatewaySeparator = gatewayAddress.lastIndexOf(':');
  const gatewayHost = gatewayAddress.slice(0, gatewaySeparator).replace(/^\[|\]$/g, '');
  const gatewayPort = Number(gatewayAddress.slice(gatewaySeparator + 1));
  if (gatewaySeparator < 1 || !Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new Error('provider Gateway endpoint is not a valid host and port');
  }
  const preserved = await updatePeerSignalAddress(broken, signalAddress);
  interruptionRun = {
    phase: 'interrupting', originalAddress: preserved.originalSignalAddress,
    interruptedAddress: broken, providerGatewayReachable: null,
  };
  const siteCondition = state => state.peer?.signals?.value === false && state.peer?.gatewayAddress === gatewayAddress;
  try {
    const state = await waitFor(siteCondition, 45000);
    const providerGatewayReachable = await tcpProbe(gatewayHost, gatewayPort);
    interruptionRun.phase = 'interrupted';
    interruptionRun.providerGatewayReachable = providerGatewayReachable;
    writeEvidence({ type: 'signal-endpoint-interruption', originalAddress: signalAddress, interruptedAddress: broken, providerGatewayAddress: gatewayAddress, providerGatewayReachable, observedAt: state.timestamp });
    return await readState();
  } catch (error) {
    interruptionRun.phase = 'interruption-pending';
    interruptionRun.error = 'peer signal endpoint interruption condition was not observed';
    throw Object.assign(new Error(interruptionRun.error), { statusCode: 504 });
  }
}

async function restorePeer() {
  const peerCluster = config.kubernetes[config.peer.gridSiteCluster];
  const source = await kubeJson(peerCluster, ['get', 'gridsite', config.peer.remoteSiteResource]);
  if (source.metadata?.labels?.['praxis.fast/run-id'] !== config.peer.runLabel) {
    throw new Error('remote GridSite ownership label does not match this run');
  }
  if (source.spec?.gatewayEndpoint?.address !== config.peer.remoteGatewayAddress) {
    throw new Error('remote provider Gateway endpoint changed; refusing signal restore');
  }
  const currentSignalAddress = source.spec?.signalsEndpoint?.address;
  const configuredSignalAddress = config.peer.remoteSignalsAddress;
  const separator = configuredSignalAddress.lastIndexOf(':');
  const expectedInterruptedAddress = separator < 0 ? null
    : `${configuredSignalAddress.slice(0, separator)}:${config.peer.unservedPort}`;
  let run = interruptionRun;
  if (!run) {
    if (currentSignalAddress === configuredSignalAddress) return await waitFor(
      state => state.peer?.signals?.value === true && state.peer?.gatewayAddress === config.peer.remoteGatewayAddress,
      60000,
    );
    if (currentSignalAddress !== expectedInterruptedAddress) {
      throw new Error('current peer signal endpoint is not the locked run interruption address');
    }
    run = interruptionRun = {
      phase: 'interrupted', originalAddress: configuredSignalAddress,
      interruptedAddress: expectedInterruptedAddress, providerGatewayReachable: null,
    };
  }
  if (run.originalAddress !== configuredSignalAddress ||
      (currentSignalAddress !== run.originalAddress && currentSignalAddress !== run.interruptedAddress)) {
    throw new Error('peer signal endpoint changed outside this run; refusing signal restore');
  }
  run.phase = 'restoring';
  const gatewayAddress = source.spec.gatewayEndpoint.address;
  if (currentSignalAddress === run.interruptedAddress) {
    await updatePeerSignalAddress(run.originalAddress, run.interruptedAddress);
  }
  if (gatewayAddress !== config.peer.remoteGatewayAddress) throw new Error('provider Gateway endpoint changed during restore');
  const predicate = state => state.peer?.signals?.value === true && state.peer?.gatewayAddress === gatewayAddress;
  const state = await waitFor(predicate, 60000);
  run.phase = 'restored';
  run.restoredAt = state.timestamp;
  writeEvidence({ type: 'signal-endpoint-restored', originalAddress: run.originalAddress, providerGatewayAddress: gatewayAddress, observedAt: state.timestamp });
  return await readState();
}

async function resetDemo() {
  if (resetBusy) throw Object.assign(new Error('reset is already running'), { statusCode: 409 });
  resetBusy = true;
  try {
    if (trafficRun?.running) await stopTraffic();
    if (pressureRunsInProgress().length) await stopPressure();
    const peer = await readPeerStatus();
    if ((interruptionRun && !['idle', 'restored'].includes(interruptionRun.phase)) || peer.value?.signals?.value === false) {
      await restorePeer();
    }
    const baseline = await waitFor(state => resetBaselineObserved(state), 90000);
    const probe = await probeGateway('local');
    if (probe.status !== 200 || !probe.validResponse) {
      throw Object.assign(new Error('fresh baseline Gateway probe did not return a valid Mocker completion'), { statusCode: 502 });
    }
    const requestDelta = probe.routingEvidence?.gatewayRequestDelta;
    if (requestDelta?.status !== 'LIVE' || requestDelta.total !== 1 || !['pool-a', 'pool-b'].includes(requestDelta.selectedBackend)) {
      throw Object.assign(new Error('fresh baseline Gateway probe did not identify exactly one selected local pool'), { statusCode: 502 });
    }
    pressureRuns.clear();
    latestPressureRun = null;
    interruptionRun = null;
    // Reset only the displayed sampler run; Gateway Prometheus counters stay cumulative.
    trafficRun = null;
    const finalState = await waitFor(state => resetBaselineObserved(state), 90000);
    finalState.pressure = currentPressure();
    finalState.interruption = currentInterruption(finalState.peer);
    writeEvidence({
      type: 'reset-baseline', observedAt: finalState.timestamp, probeRequestId: probe.requestId,
      probeValid: probe.validResponse, selectedBackend: requestDelta.selectedBackend,
      publishedRevision: finalState.overlay.published.revision, consumedRevision: finalState.overlay.consumed.revision,
    });
    return { state: finalState, probe };
  } finally {
    resetBusy = false;
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(payload));
}

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}

async function serve(request, response) {
  try {
    const url = new URL(request.url, `http://${config.listen.host}:${config.listen.port}`);
    if (url.pathname === '/api/state' && request.method === 'GET') {
      sendJson(response, 200, await readState());
      return;
    }
    if (url.pathname.startsWith('/api/') && request.method === 'POST') {
      const body = await readRequestBody(request);
      if (url.pathname === '/api/pressure/start') sendJson(response, 200, await startPressure(body));
      else if (url.pathname === '/api/pressure/stop') sendJson(response, 200, await stopPressure(body));
      else if (url.pathname === '/api/traffic/start') sendJson(response, 202, await startTraffic(body));
      else if (url.pathname === '/api/traffic/stop') sendJson(response, 200, await stopTraffic());
      else if (url.pathname === '/api/probe') sendJson(response, 200, await probeGateway('local'));
      else if (url.pathname === '/api/peer/probe') sendJson(response, 200, await probeGateway('crossSite'));
      else if (url.pathname === '/api/peer/interrupt') sendJson(response, 200, await interruptPeer());
      else if (url.pathname === '/api/peer/restore') sendJson(response, 200, await restorePeer());
      else if (url.pathname === '/api/reset') sendJson(response, 200, await resetDemo());
      else sendJson(response, 404, { error: 'unknown action' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) {
      sendJson(response, 400, { error: 'invalid path' });
      return;
    }
    const data = await fs.promises.readFile(file);
    response.writeHead(200, {
      'content-type': contentType(file),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(data);
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || 'request failed' });
  }
}

const server = http.createServer((request, response) => { void serve(request, response); });
server.listen(config.listen.port, config.listen.host, () => {
  console.log(`Grid/Dynamo demo UI listening on ${config.listen.host}:${config.listen.port}`);
  console.log(`run=${config.runId} grid_source_state_sha256=${config.identity.gridSourceStateSha256}`);
});
server.on('error', error => {
  console.error(`demo UI server failed: ${error.code || error.name}`);
  process.exitCode = 1;
});

process.on('SIGTERM', async () => {
  const pressure = pressureRunsInProgress();
  for (const run of pressure) {
    if (!run.controller.signal.aborted) run.controller.abort();
  }
  if (trafficRun?.running) {
    try { await stopTraffic(); } catch { /* shutdown must continue after bounded traffic cancellation */ }
  }
  await Promise.allSettled(pressure.map(run => run.done));
  if (interruptionRun && !['idle', 'restored'].includes(interruptionRun.phase)) {
    try { await restorePeer(); } catch { /* the handoff reset command reports any remaining condition */ }
  }
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
