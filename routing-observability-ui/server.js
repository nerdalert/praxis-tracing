import express from 'express';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT || '8080', 10);
const JAEGER_URL = process.env.JAEGER_URL || 'http://localhost:16686';
const VCR_EVIDENCE_DIR = process.env.VCR_EVIDENCE_DIR || null;
const execFileAsync = promisify(execFile);
const GLB_KUBECTL_CONTEXT = process.env.GLB_KUBECTL_CONTEXT || 'kind-grid-glb-gtm-emulator';
const GLB_GTM_SERVICE = process.env.GLB_GTM_SERVICE || 'gtm-emulator';
const GLB_GTM_NAMESPACE = process.env.GLB_GTM_NAMESPACE || 'grid-system';
const GLB_MODEL = process.env.GLB_MODEL || 'Qwen/Qwen3-0.6B';
const VCR_LIVE_ENABLED = process.env.VCR_LIVE !== 'false';
const VCR_CONTEXTS = [
  process.env.VCR_KUBECTL_CONTEXT_A || 'kind-grid-llmd-pm-pool-a',
  process.env.VCR_KUBECTL_CONTEXT_B || 'kind-grid-llmd-pm-pool-b',
];
const VCR_NAMESPACE = process.env.VCR_NAMESPACE || 'grid-system';
const VCR_QUEUE_CAPACITY = Number.parseFloat(process.env.VCR_QUEUE_CAPACITY || '4');
const VCR_OVERLAY_CONFIGMAP = process.env.VCR_OVERLAY_CONFIGMAP
  || 'grid-overlay-grid-llmd-pool-metrics-consumer-gateway';
let liveVcrCache = { expires: 0, value: null };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode = 'auto'; // auto, live, demo
let demoScenario = 'baseline';
let dataSource = 'glb'; // glb, vcr, combined
let requestJob = null;

const SCORING_WEIGHTS = { locality: 3.0, queue_depth: 5.0 };

const DEMO_SCENARIOS = {
  baseline: {
    label: 'Baseline',
    description: 'Pool A preferred — local advantage, low queue depth',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.2, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  pressure: {
    label: 'Pressure Failover',
    description: 'Pool A queue saturated — traffic shifts to Pool B',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.95, kv_cache: 0.5, latency_ms: 180, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.2, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  recovery: {
    label: 'Recovery',
    description: 'Pool A queue recovered — traffic returns to Pool A',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.3, kv_cache: 0.4, latency_ms: 45, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  degraded: {
    label: 'Pool A Degraded',
    description: 'Pool A unhealthy — all traffic to Pool B',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: false },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.3, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
};

// Deterministic mock trace history
let demoTraceCounter = 0;
const demoTraceHistory = [];

// ---------------------------------------------------------------------------
// Scoring (mirrors Rust scoring crate logic)
// ---------------------------------------------------------------------------

function localityScore(kind) {
  switch (kind) {
    case 'Local': return 1.0;
    case 'Remote': return 0.4;
    case 'CloudManaged': return 0.2;
    case 'ApiProvider': return 0.1;
    default: return 0.1;
  }
}

function scorePool(pool) {
  if (!pool.healthy) return { score: 0, rank: -1 };
  if (typeof pool.score === 'number') return { score: pool.score, rank: 0 };
  const loc = localityScore(pool.kind) * SCORING_WEIGHTS.locality;
  const qd = typeof pool.queue_depth === 'number'
    ? (1.0 - pool.queue_depth) * SCORING_WEIGHTS.queue_depth
    : 0;
  return { score: parseFloat((loc + qd).toFixed(4)), rank: 0 };
}

function scoreAndRankPools(pools) {
  const scored = pools.map(p => ({ ...p, ...scorePool(p) }));
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((p, i) => { p.rank = p.healthy ? i : -1; });
  return scored;
}

async function getGlbGatewayIp() {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', GLB_KUBECTL_CONTEXT,
    '-n', GLB_GTM_NAMESPACE,
    'get', 'svc', GLB_GTM_SERVICE,
    '-o', 'jsonpath={.status.loadBalancer.ingress[0].ip}',
  ], { timeout: 5000 });
  const ip = stdout.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error('GTM service has no load-balancer IP');
  }
  return ip;
}

function sendGlbRequest(ip, prompt, sequence) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: GLB_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 5,
    });
    const req = https.request({
      hostname: ip,
      port: 8443,
      path: '/v1/chat/completions',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Edge-Session-Id': `dashboard-observe-${Date.now()}-${sequence}`,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0, ok: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ status: 0, ok: false, error: error.message }));
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function runRequestJob(job, ip) {
  for (let i = 1; i <= job.count; i += 1) {
    if (job.cancelled) break;
    const result = await sendGlbRequest(ip, job.prompt, i);
    job.completed += 1;
    if (result.ok) job.succeeded += 1;
    else job.failed += 1;
    job.last_status = result.status;
    if (i < job.count && job.interval_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, job.interval_ms));
    }
  }
  job.running = false;
  job.finished_at = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Jaeger proxy helpers
// ---------------------------------------------------------------------------

function jaegerFetch(path) {
  return new Promise((resolve, reject) => {
    const url = `${JAEGER_URL}${path}`;
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function isJaegerReachable() {
  try {
    const result = await jaegerFetch('/api/services');
    return result.status === 200;
  } catch {
    return false;
  }
}

const JAEGER_SERVICES = [
  'grid-tracing-poc', 'consumer-gateway', 'praxis-ai',
  'praxis-gtm-emulator', 'praxis-east-edge', 'praxis-west-edge',
  'praxis-east-provider', 'praxis-west-provider',
];

async function fetchLiveTraces(service, limit) {
  try {
    const result = await jaegerFetch(`/api/traces?service=${service}&limit=${limit}`);
    if (result.status !== 200 || !result.body.data) return [];
    return result.body.data.map(parseJaegerTrace).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchLiveTracesAllServices(limit) {
  const allTraces = [];
  const seen = new Set();
  for (const svc of JAEGER_SERVICES) {
    const traces = await fetchLiveTraces(svc, limit);
    for (const t of traces) {
      if (!seen.has(t.trace_id)) {
        seen.add(t.trace_id);
        allTraces.push(t);
      }
    }
  }
  allTraces.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return allTraces.slice(0, limit);
}

function parseJaegerTrace(trace) {
  if (!trace.spans || trace.spans.length === 0) return null;
  const rootSpan = trace.spans.find(s => s.operationName === 'consumer.inbound')
    || trace.spans.find(s => s.operationName === 'http.request')
    || trace.spans[0];
  const routeSpan = trace.spans.find(s =>
    s.operationName === 'consumer.route_select' || s.operationName === 'routing.select');

  const getTag = (span, key) => {
    const tag = span?.tags?.find(t => t.key === key);
    return tag ? tag.value : null;
  };

  const libraryName = getTag(routeSpan || rootSpan, 'otel.library.name');
  let source = 'unknown';
  if (libraryName === 'praxis-ai') source = 'praxis';
  else if (libraryName === 'grid-tracing-poc') source = 'synthetic';

  const clientSpan = trace.spans.find(s =>
    getTag(s, 'span.kind') === 'client' || getTag(s, 'otel.kind') === 'CLIENT'
    || s.operationName === 'provider.request');
  const hasTraceparent = !!clientSpan;

  const spans = trace.spans.map(s => {
    const kind = getTag(s, 'span.kind') || getTag(s, 'otel.kind') || 'internal';
    const refs = s.references || [];
    const parentRef = refs.find(r => r.refType === 'CHILD_OF');
    return {
      span_id: s.spanID,
      operation: s.operationName,
      kind: kind.toUpperCase(),
      duration_us: typeof s.duration === 'number' ? s.duration : null,
      parent_span_id: parentRef ? parentRef.spanID : null,
      tags: Object.fromEntries(
        (s.tags || [])
          .filter(t => !['internal.span.format', 'otel.library.name',
            'otel.library.version', 'code.filepath', 'code.namespace',
            'code.lineno', 'thread.id', 'thread.name',
            'busy_ns', 'idle_ns'].includes(t.key))
          .map(t => [t.key, t.value])
      ),
    };
  });

  const processes = trace.processes || {};
  const runIds = Object.values(processes).flatMap(p => (p.tags || [])
    .filter(tag => tag.key === 'demo.run_id')
    .map(tag => tag.value));
  const demoRunId = runIds[0] || null;
  const serviceNames = [...new Set(
    Object.values(processes)
      .map(p => p.serviceName)
      .filter(s => s && s !== 'jaeger-query')
  )];

  return {
    trace_id: trace.traceID,
    jaeger_url: `${JAEGER_URL}/trace/${trace.traceID}`,
    span_count: trace.spans.length,
    service_count: serviceNames.length,
    services: serviceNames,
    source,
    demo_run_id: demoRunId,
    has_traceparent: hasTraceparent,
    selected_provider: getTag(routeSpan, 'selected.provider') || 'unknown',
    selected_cluster: getTag(routeSpan, 'selected.cluster') || 'unknown',
    selected_site: getTag(routeSpan, 'selected.site') || null,
    stable_id: getTag(routeSpan, 'selected.stable_id') || null,
    admission_state: getTag(routeSpan, 'routing.admission_state') || null,
    overlay_revision: getTag(routeSpan, 'overlay.revision') || null,
    provider_score: getTag(routeSpan, 'provider.score') ?? null,
    routing_decision: getTag(routeSpan, 'routing.decision') || '',
    routing_policy: getTag(routeSpan, 'routing.policy') || null,
    routing_kind: getTag(routeSpan, 'routing.kind') || null,
    selection_tier: getTag(routeSpan, 'routing.selection_tier') || null,
    duration_us: typeof rootSpan.duration === 'number' ? rootSpan.duration : null,
    timestamp: rootSpan.startTime ? new Date(rootSpan.startTime / 1000).toISOString() : null,
    spans,
  };
}

async function fetchLivePoolState() {
  const traces = await fetchLiveTracesAllServices(10);
  if (traces.length === 0) return null;

  const latest = traces[0];
  const providerMap = new Map();
  for (const t of traces) {
    const id = t.stable_id || t.selected_cluster;
    if (!id || id === 'unknown') continue;
    if (!providerMap.has(id)) {
      providerMap.set(id, {
        name: t.selected_provider || id,
        cluster: t.selected_cluster || 'unknown',
        site: t.selected_site || null,
        stable_id: t.stable_id || null,
        admission_state: t.admission_state || null,
        selection_tier: t.selection_tier || null,
        overlay_revision: t.overlay_revision || null,
        healthy: true,
        score: typeof t.provider_score === 'number' ? t.provider_score : null,
        queue_depth: null,
        kv_cache: null,
        latency_ms: null,
        request_count: 0,
      });
    }
    providerMap.get(id).request_count++;
  }

  const pools = [...providerMap.values()];
  const hasAnyScore = pools.some(p => typeof p.score === 'number');
  const inferredStrategy = hasAnyScore ? 'unknown' : 'noMetrics';
  return { pools, latest_trace: latest, scoring_strategy: inferredStrategy };
}

// ---------------------------------------------------------------------------
// Pressure state classification
// ---------------------------------------------------------------------------

const PRESSURE_THRESHOLDS = [
  { max: 0.50, level: 'normal' },
  { max: 0.80, level: 'elevated' },
  { max: 0.95, level: 'high' },
  { max: Infinity, level: 'critical' },
];

function pressureLevel(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 'unknown';
  for (const t of PRESSURE_THRESHOLDS) {
    if (value < t.max) return t.level;
  }
  return 'critical';
}

function classifyProvider(pool) {
  const activeSignal = typeof pool.queue_depth === 'number' ? pool.queue_depth
    : typeof pool.kv_cache === 'number' ? pool.kv_cache
    : null;
  return {
    pressure_level: activeSignal !== null ? pressureLevel(activeSignal) : 'unknown',
    pressure_value: activeSignal,
    pressure_source: typeof pool.queue_depth === 'number' ? 'queue_depth'
      : typeof pool.kv_cache === 'number' ? 'kv_cache'
      : null,
  };
}

// ---------------------------------------------------------------------------
// Overlay file support
// ---------------------------------------------------------------------------

const OVERLAY_FILE = process.env.OVERLAY_FILE || null;

function loadOverlayFromFile() {
  if (!OVERLAY_FILE) return null;
  try {
    return JSON.parse(readFileSync(OVERLAY_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Demo mode helpers
// ---------------------------------------------------------------------------

function generateDemoTrace(scenario, pools) {
  demoTraceCounter++;
  const scored = scoreAndRankPools(pools);
  const selected = scored.find(p => p.healthy) || scored[0];
  const hex = demoTraceCounter.toString(16).padStart(32, '0');

  const trace = {
    trace_id: hex,
    jaeger_url: `${JAEGER_URL}/trace/${hex}`,
    span_count: 4,
    selected_provider: `llmd-${selected.name}-provider`,
    selected_cluster: selected.name,
    provider_score: selected.score,
    routing_decision: `scored ${scored.filter(p => p.healthy).length} backends, selected ${selected.name} (score=${selected.score.toFixed(2)})`,
    routing_policy: 'scoreFirst',
    duration_us: 15000 + demoTraceCounter * 100,
    timestamp: new Date().toISOString(),
    scenario: scenario,
  };

  demoTraceHistory.unshift(trace);
  if (demoTraceHistory.length > 50) demoTraceHistory.length = 50;

  return trace;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get('/api/status', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode;
  if (currentMode === 'auto') {
    effectiveMode = jaegerUp ? 'live' : 'demo';
  }

  let liveDetail = null;
  if (effectiveMode === 'live' && jaegerUp) {
    const traces = await fetchLiveTracesAllServices(5);
    const hasPraxis = traces.some(t => t.source === 'praxis');
    const hasSynthetic = traces.some(t => t.source === 'synthetic');
    liveDetail = hasPraxis ? 'praxis' : hasSynthetic ? 'synthetic' : 'live';
  }

  const liveVcr = await loadLiveVcrState();
  const vcrEvidenceAvailable = !!VCR_EVIDENCE_DIR && existsSync(VCR_EVIDENCE_DIR);
  const vcrAvailable = !!liveVcr || vcrEvidenceAvailable;
  const sourceLabel = dataSource === 'glb'
    ? (effectiveMode === 'live' ? 'LIVE PRAXIS / GLB' : effectiveMode === 'demo' ? 'MOCK DATA' : 'UNAVAILABLE')
    : dataSource === 'vcr'
    ? (vcrAvailable ? 'LIVE EPP / VCR' : 'UNAVAILABLE')
    : 'COMBINED';

  res.json({
    mode: effectiveMode,
    configured_mode: currentMode,
    jaeger_reachable: jaegerUp,
    jaeger_url: JAEGER_URL,
    live_detail: liveDetail,
    scenario: effectiveMode === 'demo' ? demoScenario : null,
    data_source: dataSource,
    source_label: sourceLabel,
    vcr_available: vcrAvailable,
    vcr_mode: liveVcr ? 'live' : vcrEvidenceAvailable ? 'evidence' : 'unavailable',
  });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['auto', 'live', 'demo'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be auto, live, or demo' });
  }
  currentMode = mode;
  if (mode === 'demo') {
    demoScenario = 'baseline';
    demoTraceHistory.length = 0;
    demoTraceCounter = 0;
  }
  res.json({ mode: currentMode });
});

app.get('/api/pools', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : 'demo') : currentMode;

  if (effectiveMode === 'live' && jaegerUp) {
    const liveState = await fetchLivePoolState();
    if (liveState) {
      const scored = scoreAndRankPools(liveState.pools);
      return res.json({ mode: 'live', pools: scored, latest_trace: liveState.latest_trace });
    }
    effectiveMode = 'demo';
  }

  const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
  const scored = scoreAndRankPools(scenario.pools);
  const trace = generateDemoTrace(demoScenario, scenario.pools);

  res.json({
    mode: effectiveMode === 'live' ? 'unavailable' : 'demo',
    pools: scored,
    latest_trace: trace,
    scenario: { name: demoScenario, ...scenario },
  });
});

app.get('/api/traces', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : 'demo') : currentMode;

  if (effectiveMode === 'live' && jaegerUp) {
    const traces = await fetchLiveTracesAllServices(limit);
    return res.json({ mode: 'live', traces });
  }

  res.json({
    mode: effectiveMode === 'live' ? 'unavailable' : 'demo',
    traces: demoTraceHistory.slice(0, limit),
  });
});

app.post('/api/scenario/:name', (req, res) => {
  const { name } = req.params;
  if (!DEMO_SCENARIOS[name]) {
    return res.status(400).json({ error: `unknown scenario: ${name}`, available: Object.keys(DEMO_SCENARIOS) });
  }
  demoScenario = name;
  const scenario = DEMO_SCENARIOS[name];
  const scored = scoreAndRankPools(scenario.pools);
  const trace = generateDemoTrace(name, scenario.pools);

  res.json({
    scenario: { name, ...scenario },
    pools: scored,
    trace,
  });
});

app.get('/api/trace/:traceId', async (req, res) => {
  const { traceId } = req.params;
  try {
    const result = await jaegerFetch(`/api/traces/${traceId}`);
    if (result.status !== 200 || !result.body.data || result.body.data.length === 0) {
      return res.status(404).json({ error: 'trace not found' });
    }
    const parsed = parseJaegerTrace(result.body.data[0]);
    if (!parsed) return res.status(404).json({ error: 'trace parse failed' });
    res.json(parsed);
  } catch {
    res.status(502).json({ error: 'jaeger unreachable' });
  }
});

app.get('/api/overlay', (_req, res) => {
  const overlay = loadOverlayFromFile();
  if (!overlay) {
    return res.json({ available: false, source: null, overlay: null });
  }
  res.json({ available: true, source: OVERLAY_FILE, overlay });
});

app.get('/api/providers', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : 'demo') : currentMode;

  if (effectiveMode === 'live' && jaegerUp) {
    const liveState = await fetchLivePoolState();
    if (liveState) {
      const overlay = loadOverlayFromFile();
      const candidateMap = new Map();
      if (overlay?.overlay?.candidates) {
        for (const c of overlay.overlay.candidates) {
          candidateMap.set(c.stable_id, c);
        }
      }

      const providers = liveState.pools.map(p => {
        const overlayCandidate = candidateMap.get(p.stable_id) || null;
        return {
          ...p,
          selection_tier: p.selection_tier || overlayCandidate?.selection_tier || null,
          score: typeof p.score === 'number' ? p.score
            : (typeof overlayCandidate?.score === 'number' ? overlayCandidate.score : null),
          rank: overlayCandidate?.rank ?? null,
          score_breakdown: overlayCandidate?.score_breakdown || null,
          ...classifyProvider(p),
        };
      });

      const scoringStrategy = liveState.scoring_strategy !== 'unknown'
        ? liveState.scoring_strategy
        : (overlay ? 'noMetrics' : 'unknown');

      return res.json({
        mode: 'live',
        scoring_strategy: scoringStrategy,
        providers,
        latest_trace: liveState.latest_trace,
        overlay_revision: overlay?.revision?.value || null,
      });
    }
  }

  const overlay = loadOverlayFromFile();
  if (overlay?.overlay?.candidates) {
    const providers = overlay.overlay.candidates.map(c => ({
      name: c.name,
      cluster: c.cluster,
      site: c.site,
      stable_id: c.stable_id,
      admission_state: c.admission_state,
      selection_tier: c.selection_tier,
      healthy: c.fresh !== false,
      score: typeof c.score === 'number' ? c.score : null,
      rank: typeof c.rank === 'number' ? c.rank : null,
      score_breakdown: c.score_breakdown || null,
      queue_depth: null,
      kv_cache: null,
      latency_ms: null,
      request_count: 0,
      ...classifyProvider({ queue_depth: null, kv_cache: null }),
    }));
    return res.json({
      mode: 'overlay',
      scoring_strategy: 'noMetrics',
      providers,
      overlay_revision: overlay.revision?.value || null,
      generated_at: overlay.overlay?.generated_at || null,
    });
  }

  const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
  const scored = scoreAndRankPools(scenario.pools);
  res.json({
    mode: 'demo',
    scoring_strategy: 'demo',
    providers: scored.map(p => ({ ...p, ...classifyProvider(p) })),
    scenario: { name: demoScenario, ...scenario },
  });
});

app.get('/api/timeline', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : 'demo') : currentMode;

  if (effectiveMode === 'live' && jaegerUp) {
    const traces = await fetchLiveTracesAllServices(50);
    const events = buildTimelineFromTraces(traces);
    return res.json({ mode: 'live', events });
  }

  res.json({ mode: effectiveMode === 'live' ? 'unavailable' : 'demo', events: buildDemoTimeline() });
});

function buildTimelineFromTraces(traces) {
  if (!traces.length) return [];
  const noMetricsView = traces.every(trace => trace.provider_score === null || trace.provider_score === undefined);
  const events = [];
  const sorted = [...traces].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let prevProvider = null;
  let prevCluster = null;
  let prevEdge = null;

  for (const t of sorted) {
    const ts = t.timestamp ? new Date(t.timestamp) : null;
    const timeLabel = ts ? ts.toLocaleTimeString() : '—';
    const cluster = t.selected_cluster || 'unknown';
    const provider = t.selected_provider || 'unknown';
    const edge = (t.services || []).find(service => service.endsWith('-edge')) || null;
    const edgeLabel = edge ? edge.replace(/^praxis-/, '') : 'edge unavailable';
    const providerLabel = cluster;

    if (prevCluster && cluster !== prevCluster) {
      const previousEdgeLabel = prevEdge ? prevEdge.replace(/^praxis-/, '') : 'edge unavailable';
      const previousProviderLabel = prevCluster;
      events.push({
        time: timeLabel,
        type: 'route_change',
        label: noMetricsView
          ? `Observed path changed: ${previousEdgeLabel}/${previousProviderLabel} → ${edgeLabel}/${providerLabel}`
          : `Route changed: ${prevCluster} → ${cluster}`,
        detail: noMetricsView
          ? `Observed path: ${(t.services || []).map(service => service.replace(/^praxis-/, '')).join(' → ') || 'service path unavailable'}; no pressure signal in this view (trace ${t.trace_id.substring(0, 16)})`
          : `Trace ${t.trace_id.substring(0, 16)}`,
        severity: 'warning',
      });
    }

    if (!prevProvider) {
      events.push({
        time: timeLabel,
        type: 'baseline',
        label: `Baseline: ${cluster} selected`,
        detail: `Provider ${provider}, stable_id ${t.stable_id || '—'}`,
        severity: 'info',
      });
    }

    prevProvider = provider;
    prevCluster = cluster;
    prevEdge = edge;
  }

  const attribution = {};
  for (const t of sorted) {
    const c = t.selected_cluster || 'unknown';
    attribution[c] = (attribution[c] || 0) + 1;
  }
  events.push({
    time: 'summary',
    type: 'attribution',
    label: noMetricsView ? 'Observed trace attribution' : 'Request attribution',
    detail: Object.entries(attribution).map(([k, v]) => `${k}: ${v}`).join(', '),
    severity: 'info',
  });

  return events;
}

function buildDemoTimeline() {
  return [
    { time: '00:00', type: 'baseline', label: 'Baseline: pool-a preferred', detail: 'Local advantage, low queue depth', severity: 'info' },
    { time: '00:12', type: 'load_started', label: 'Stress generator started', detail: 'Demo scenario: pressure', severity: 'info' },
    { time: '00:21', type: 'threshold_crossed', label: 'Queue depth increased', detail: '0.10 → 0.95', severity: 'warning' },
    { time: '00:27', type: 'threshold_crossed', label: 'Pressure crossed CRITICAL', detail: 'queue_depth ≥ 0.95', severity: 'critical' },
    { time: '00:32', type: 'route_change', label: 'Route changed: pool-a → pool-b', detail: 'Score gap inverted', severity: 'warning' },
    { time: '01:10', type: 'load_stopped', label: 'Stress stopped', detail: 'Demo scenario: recovery', severity: 'info' },
    { time: '01:29', type: 'baseline', label: 'pool-a restored as preferred', detail: 'Queue drained below threshold', severity: 'info' },
  ];
}

app.get('/api/scenarios', (_req, res) => {
  const scenarios = Object.entries(DEMO_SCENARIOS).map(([key, val]) => ({
    key,
    label: val.label,
    description: val.description,
  }));
  res.json({ scenarios });
});

// ---------------------------------------------------------------------------
// Data source selector
// ---------------------------------------------------------------------------

app.get('/api/source', (_req, res) => {
  res.json({
    source: dataSource,
    available: {
      glb: true,
      vcr: !!VCR_EVIDENCE_DIR && existsSync(VCR_EVIDENCE_DIR),
      combined: true,
    },
  });
});

app.post('/api/source', (req, res) => {
  const { source } = req.body;
  if (!['glb', 'vcr', 'combined'].includes(source)) {
    return res.status(400).json({ error: 'source must be glb, vcr, or combined' });
  }
  dataSource = source;
  res.json({ source: dataSource });
});

// ---------------------------------------------------------------------------
// Live GLB request generator
// ---------------------------------------------------------------------------

app.get('/api/generate/status', (_req, res) => {
  res.json({
    available: dataSource === 'glb' && currentMode !== 'demo',
    job: requestJob,
  });
});

app.post('/api/generate', async (req, res) => {
  if (dataSource !== 'glb' || currentMode === 'demo') {
    return res.status(409).json({ error: 'Request generation is available only for live GLB data' });
  }
  if (requestJob?.running) {
    return res.status(409).json({ error: 'A request generation job is already running', job: requestJob });
  }

  const count = Math.min(100, Math.max(1, Number.parseInt(req.body?.count ?? 10, 10) || 10));
  const rate = Math.min(20, Math.max(0.1, Number(req.body?.rate ?? 1) || 1));
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
    ? req.body.prompt.trim().slice(0, 500)
    : 'dashboard observability request';

  try {
    const ip = await getGlbGatewayIp();
    requestJob = {
      id: `glb-${Date.now()}`,
      running: true,
      count,
      rate_per_second: rate,
      interval_ms: Math.round(1000 / rate),
      prompt,
      gateway_ip: ip,
      completed: 0,
      succeeded: 0,
      failed: 0,
      last_status: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    runRequestJob(requestJob, ip).catch((error) => {
      requestJob.running = false;
      requestJob.error = error.message;
      requestJob.finished_at = new Date().toISOString();
    });
    return res.status(202).json({ job: requestJob });
  } catch (error) {
    return res.status(503).json({ error: `Unable to find the GLB gateway: ${error.message}` });
  }
});

app.post('/api/generate/cancel', (_req, res) => {
  if (requestJob?.running) requestJob.cancelled = true;
  res.json({ job: requestJob });
});

app.get('/api/attribution', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  if (!jaegerUp) return res.json({ available: false, sample_size: 0, providers: {} });
  const allTraces = await fetchLiveTracesAllServices(100);
  const praxisTraces = allTraces.filter(trace => trace.source === 'praxis' && trace.demo_run_id);
  const currentRunId = praxisTraces.map(trace => trace.demo_run_id).sort().at(-1) || null;
  const traces = currentRunId
    ? praxisTraces.filter(trace => trace.demo_run_id === currentRunId)
    : allTraces.filter(trace => trace.source === 'praxis');
  const providers = {};
  for (const trace of traces) {
    const provider = trace.selected_cluster;
    if (provider && provider !== 'unknown') providers[provider] = (providers[provider] || 0) + 1;
  }
  res.json({ available: true, run_id: currentRunId, sample_size: traces.length, providers });
});

// ---------------------------------------------------------------------------
// VCR evidence loader
// ---------------------------------------------------------------------------

async function kubectlRaw(context, path) {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', context,
    'get', '--raw', path,
  ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function kubectlConfigMap(context) {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', context,
    '-n', VCR_NAMESPACE,
    'get', 'configmap', VCR_OVERLAY_CONFIGMAP,
    '-o', 'json',
  ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function parsePrometheusGauge(metrics, metricName, poolName) {
  const line = metrics.split('\n').find(candidate =>
    candidate.startsWith(`${metricName}{`) && candidate.includes(`name="${poolName}"`));
  if (!line) return null;
  const value = Number.parseFloat(line.slice(line.lastIndexOf('}') + 1).trim());
  return Number.isFinite(value) ? value : null;
}

async function loadLiveVcrState() {
  if (!VCR_LIVE_ENABLED) return null;
  if (liveVcrCache.expires > Date.now()) return liveVcrCache.value;

  try {
    const pools = [];
    for (const context of VCR_CONTEXTS) {
      const [metrics, configMap] = await Promise.all([
        kubectlRaw(context, `/api/v1/namespaces/${VCR_NAMESPACE}/services/http:llmd-epp-metrics:9090/proxy/metrics`),
        kubectlConfigMap(context),
      ]);
      const overlay = JSON.parse(configMap.data['routing-overlay.json']);
      pools.push({ context, metrics, overlay });
    }

    // Use the first consumer's overlay as the dashboard perspective. It
    // contains both local and remote candidates and their current scores.
    const primary = pools[0];
    const candidates = primary.overlay?.overlay?.candidates || [];
    const metricsByPool = new Map();
    for (const { metrics } of pools) {
      const queue = metrics.match(/inference_pool_average_queue_size\{name="([^"]+)"\}\s+([\d.eE+-]+)/);
      const kv = metrics.match(/inference_pool_average_kv_cache_utilization\{name="([^"]+)"\}\s+([\d.eE+-]+)/);
      if (queue) metricsByPool.set(queue[1], {
        queue: Number.parseFloat(queue[2]),
        kv: kv && kv[1] === queue[1] ? Number.parseFloat(kv[2]) : null,
      });
    }

    const providers = candidates.map(candidate => {
      const signal = metricsByPool.get(candidate.site);
      const queue = signal?.queue ?? null;
      const kv = signal?.kv ?? null;
      const queueRatio = queue === null
        ? null
        : Math.min(1, Math.max(0, queue / VCR_QUEUE_CAPACITY));
      return {
        name: candidate.name,
        cluster: candidate.cluster,
        site: candidate.site,
        stable_id: candidate.stable_id,
        admission_state: candidate.admission_state,
        selection_tier: candidate.selection_tier,
        healthy: candidate.fresh !== false,
        score: typeof candidate.score === 'number' ? candidate.score : null,
        rank: typeof candidate.rank === 'number' ? candidate.rank : null,
        score_breakdown: candidate.score_breakdown || null,
        queue_depth: queueRatio === null ? null : {
          value: queueRatio,
          raw_value: queue,
          capacity: VCR_QUEUE_CAPACITY,
          unit: 'normalized_ratio',
          source: 'inference_pool_average_queue_size',
          fresh: true,
        },
        kv_cache: kv === null ? null : {
          value: kv,
          unit: 'ratio',
          source: 'inference_pool_average_kv_cache_utilization',
          fresh: true,
        },
        ...classifyProvider({ queue_depth: queueRatio, kv_cache: kv }),
      };
    });
    const value = {
      mode: 'live',
      source: 'vcr-epp-live',
      scoring_strategy: 'queueDepth',
      providers,
      overlay_revision: primary.overlay?.revision?.value || null,
      generated_at: primary.overlay?.overlay?.generated_at || null,
      contexts: VCR_CONTEXTS,
    };
    liveVcrCache = { expires: Date.now() + 2000, value };
    return value;
  } catch (error) {
    liveVcrCache = { expires: Date.now() + 2000, value: null };
    return null;
  }
}

function loadVcrEvidence() {
  if (!VCR_EVIDENCE_DIR || !existsSync(VCR_EVIDENCE_DIR)) return null;
  try {
    const dirs = readdirSync(VCR_EVIDENCE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
    if (dirs.length === 0) return null;
    const latest = dirs[0];
    const evidencePath = join(VCR_EVIDENCE_DIR, latest, 'evidence.json');
    if (!existsSync(evidencePath)) return null;
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    data._evidence_dir = latest;
    return data;
  } catch {
    return null;
  }
}

function vcrProvidersFromEvidence(evidence) {
  if (!evidence?.proofs) return [];
  const providerMap = new Map();
  const pattern = /(pool-\w+):\s+queue=([\d.]+(?:\/\d+)?)\s+kv=([\d.]+)\s+score=([\d.]+)\s+rank=(\d+)/;
  const simplePattern = /(?:^|\s)(pool-\w+)\s+queue=([\d.]+(?:\/\d+)?)\s+kv=([\d.]+)\s+score=([\d.]+)\s+rank=(\d+)/;

  for (const [, proof] of Object.entries(evidence.proofs)) {
    if (!proof?.success) continue;
    for (const line of (proof.observations || [])) {
      const match = line.match(pattern) || line.match(simplePattern);
      if (match) {
        const [, name, queueRaw, kv, score, rank] = match;
        const queueVal = parseFloat(queueRaw.split('/')[0]);
        const kvVal = parseFloat(kv);
        providerMap.set(name, {
          name: `llmd-${name}-provider`,
          cluster: name,
          site: name,
          stable_id: name,
          admission_state: 'new_and_existing',
          selection_tier: name === 'pool-a' ? 'same_region' : 'cross_region',
          healthy: true,
          score: parseFloat(score),
          rank: parseInt(rank, 10),
          queue_depth: {
            value: queueVal,
            unit: 'normalized_ratio',
            source: 'llm_d_router_epp_average_queue_size',
            fresh: true,
          },
          kv_cache: {
            value: kvVal,
            unit: 'ratio',
            source: 'llm_d_router_epp_average_kv_cache_utilization',
            fresh: true,
          },
          ...classifyProvider({ queue_depth: queueVal, kv_cache: kvVal }),
          score_breakdown: null,
        });
      }
    }
  }
  return [...providerMap.values()];
}

function vcrTimelineFromEvidence(evidence) {
  if (!evidence?.proofs) return [];
  const events = [];
  const proofs = evidence.proofs;

  if (proofs.baseline?.success) {
    const obs = proofs.baseline.observations || [];
    const attrLine = obs.find(l => l.includes('attribution:'));
    events.push({
      time: '00:00',
      type: 'baseline',
      label: 'Baseline: pool-a preferred',
      detail: attrLine || proofs.baseline.description,
      severity: 'info',
    });
  }

  if (proofs.pressure_and_flip?.success) {
    const obs = proofs.pressure_and_flip.observations || [];
    const flipLine = obs.find(l => l.includes('flip:'));
    const loadLine = obs.find(l => l.includes('load stats:'));
    events.push({
      time: '00:12',
      type: 'load_started',
      label: 'Pressure generator started',
      detail: obs.find(l => l.includes('replicas')) || 'Gateway-routed load',
      severity: 'info',
    });
    if (flipLine) {
      events.push({
        time: '00:20',
        type: 'route_change',
        label: 'Route changed: pool-a → pool-b',
        detail: flipLine,
        severity: 'warning',
      });
    }
    if (loadLine) {
      events.push({
        time: '00:25',
        type: 'attribution',
        label: 'Traffic attribution',
        detail: loadLine,
        severity: 'info',
      });
    }
  }

  if (proofs.recovery?.success) {
    const obs = proofs.recovery.observations || [];
    const recLine = obs.find(l => l.includes('recovery:'));
    events.push({
      time: '01:00',
      type: 'load_stopped',
      label: 'Pressure stopped',
      detail: obs.find(l => l.includes('scaled to 0')) || 'Generator stopped',
      severity: 'info',
    });
    if (recLine) {
      events.push({
        time: '01:15',
        type: 'baseline',
        label: 'pool-a restored as preferred',
        detail: recLine,
        severity: 'info',
      });
    }
  }

  return events;
}

app.get('/api/causal', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : 'demo') : currentMode;

  let providers = [];
  let strategy = 'unknown';
  let route = null;
  let timeline = [];

  if (dataSource === 'vcr' || dataSource === 'combined') {
    const evidence = loadVcrEvidence();
    if (evidence) {
      providers = vcrProvidersFromEvidence(evidence);
      strategy = 'queueDepth';
      timeline = vcrTimelineFromEvidence(evidence);
      const ranked = [...providers].sort((a, b) => (b.score || 0) - (a.score || 0));
      if (ranked.length) {
        route = {
          selected: ranked[0].cluster,
          decision: `scored ${ranked.length} backends, selected ${ranked[0].cluster} (score=${ranked[0].score?.toFixed(2)})`,
          policy: 'scoreFirst',
        };
      }
    }
  }

  if (dataSource === 'glb' || (dataSource === 'combined' && !providers.length)) {
    if (effectiveMode === 'live' && jaegerUp) {
      const liveState = await fetchLivePoolState();
      if (liveState) {
        providers = liveState.pools.map(p => ({ ...p, ...classifyProvider(p) }));
        strategy = liveState.scoring_strategy;
        route = liveState.latest_trace ? {
          selected: liveState.latest_trace.selected_cluster,
          decision: liveState.latest_trace.routing_decision,
          policy: liveState.latest_trace.routing_policy,
        } : null;
        timeline = buildTimelineFromTraces(await fetchLiveTracesAllServices(50));
      }
    } else {
      const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
      const scored = scoreAndRankPools(scenario.pools);
      providers = scored.map(p => ({ ...p, ...classifyProvider(p) }));
      strategy = 'demo';
      route = {
        selected: scored.find(p => p.healthy)?.name || scored[0]?.name,
        decision: `demo scenario: ${demoScenario}`,
        policy: 'scoreFirst',
      };
      timeline = buildDemoTimeline();
    }
  }

  const hasRouteChange = timeline.some(e => e.type === 'route_change');
  const routeEvent = timeline.find(e => e.type === 'route_change');
  const attrEvent = timeline.find(e => e.type === 'attribution');

  const selectedProvider = providers.find(p => (p.cluster || p.name) === route?.selected) || providers[0];
  const maxPressure = providers.reduce((max, p) => {
    const v = p.pressure_value ?? (typeof p.queue_depth === 'number' ? p.queue_depth : null);
    return v !== null && v > (max ?? -1) ? v : max;
  }, null);

  const steps = {
    traffic: {
      state: hasRouteChange ? 'changed' : 'steady',
      provider_count: providers.length,
      detail: hasRouteChange ? (routeEvent?.label || 'Route changed') : 'Steady state',
    },
    metrics: {
      per_provider: providers.map(p => ({
        name: p.cluster || p.name,
        queue_depth: typeof p.queue_depth === 'number' ? p.queue_depth : p.queue_depth?.value ?? null,
        kv_cache: typeof p.kv_cache === 'number' ? p.kv_cache : p.kv_cache?.value ?? null,
        pressure_level: p.pressure_level || 'unknown',
      })),
      max_pressure: maxPressure,
      max_level: selectedProvider?.pressure_level || 'unknown',
    },
    score: {
      strategy,
      weights: { locality: 3.0, queue_depth: 5.0 },
      per_provider: providers.map(p => ({
        name: p.cluster || p.name,
        score: p.score ?? null,
        rank: p.rank ?? null,
      })),
    },
    route: route,
    attribution: attrEvent ? { detail: attrEvent.detail, label: attrEvent.label } : null,
  };

  let narrative = '';
  if (hasRouteChange) {
    narrative = `Route changed due to pressure. ${routeEvent?.label || ''}. `;
  } else {
    narrative = `${route?.selected || 'unknown'} is the preferred provider. `;
  }
  narrative += `Scoring strategy: ${strategy}. `;
  if (strategy === 'noMetrics') narrative += 'All scores are 0.0 — routing by locality tier only.';

  res.json({ data_source: dataSource, mode: effectiveMode, steps, narrative });
});

app.get('/api/timing', (_req, res) => {
  res.json({
    operator: {
      reconcile_interval_secs: 300,
      tls_reconcile_interval_secs: 60,
      metrics_scrape_timeout_secs: 5,
      stale_metrics_secs: 20,
      description: 'Operator reconciles GridNetwork every 300s (60s with TLS metrics). Each reconcile scrapes provider metrics, recalculates scores, and publishes overlay ConfigMap.',
      classification: 'source-derived',
    },
    overlay_sync: {
      delivery: 'k8s_configmap_watch',
      latency: 'event-driven (sub-second after ConfigMap update)',
      reconnect_backoff_max_secs: 30,
      description: 'overlay-sync watches the ConfigMap and pushes updates to the gateway immediately on change.',
      classification: 'source-derived',
    },
    scoring: {
      filter_execution_us: 27,
      filter_execution_label: 'routing.select span duration (filter execution, not end-to-end request latency)',
      strategy_options: ['noMetrics', 'queueDepth', 'kvCachePressure'],
      weights: { locality: 3.0, queue_depth: 5.0 },
      description: 'Score recalculation happens during each operator reconcile. The routing.select span measures filter execution time only.',
      classification: 'runtime-tested',
    },
    tracing: {
      span_injection: 'W3C TraceContext (traceparent/tracestate)',
      collector_protocol: 'OTLP/HTTP (port 4318)',
      exporter: 'opentelemetry-otlp 0.29',
      spans_per_request: 6,
      services_per_trace: 3,
      classification: 'runtime-tested',
    },
    epp_metrics: {
      scrape_endpoint: 'http://llmd-epp-metrics.grid-system.svc.cluster.local:9090/metrics',
      signal_names: {
        queue_depth: 'inference_pool_average_queue_size',
        kv_cache: 'inference_pool_average_kv_cache_utilization',
        healthy_pods: 'inference_pool_ready_pods',
      },
      queue_capacity: 4,
      stale_threshold_secs: 20,
      scrape_timeout_secs: 2,
      classification: 'source-derived',
    },
    vcr_demo: {
      wall_secs: 298.8,
      metrics_transport: 'direct-http',
      proofs: 4,
      model: 'Qwen/Qwen3-0.6B',
      provider_kind: 'vllm-vcr',
      description: 'VCR demo runs baseline → pressure → provenance → recovery in ~5 minutes.',
      classification: 'runtime-tested',
    },
  });
});

app.get('/api/vcr/status', async (_req, res) => {
  const live = await loadLiveVcrState();
  if (live) {
    return res.json({
      available: true,
      mode: 'live',
      source: 'vcr-epp-live',
      scoring_strategy: live.scoring_strategy,
      overlay_revision: live.overlay_revision,
      generated_at: live.generated_at,
      contexts: live.contexts,
    });
  }
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ available: false, mode: 'unavailable' });
  }
  res.json({
    available: true,
    mode: evidence.success ? 'replay' : 'failed',
    started_at: evidence.started_at,
    wall_secs: evidence.wall_secs,
    metrics_transport: evidence.metrics_transport,
    evidence_run: evidence._evidence_dir,
    images: evidence.setup?.images || null,
    scoring_strategy: 'queueDepth',
  });
});

app.get('/api/vcr/providers', async (_req, res) => {
  const live = await loadLiveVcrState();
  if (live) return res.json(live);
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ mode: 'unavailable', source: 'vcr', providers: [] });
  }
  const providers = vcrProvidersFromEvidence(evidence);
  res.json({
    mode: 'replay',
    source: 'vcr-epp',
    scoring_strategy: 'queueDepth',
    providers,
    evidence_run: evidence._evidence_dir,
    started_at: evidence.started_at,
  });
});

app.get('/api/vcr/timeline', async (_req, res) => {
  const live = await loadLiveVcrState();
  if (live) {
    const selected = live.providers.find(provider => provider.rank === 0) || live.providers[0];
    const metrics = live.providers.map(provider => {
      const queue = provider.queue_depth?.value;
      const rawQueue = provider.queue_depth?.raw_value;
      const kv = provider.kv_cache?.value;
      const queueText = typeof queue === 'number'
        ? `${typeof rawQueue === 'number' ? rawQueue.toFixed(1) : '—'} requests (${queue.toFixed(2)} normalized)`
        : '—';
      return `${provider.site}: queue=${queueText}, KV=${typeof kv === 'number' ? kv.toFixed(2) : '—'}, score=${typeof provider.score === 'number' ? provider.score.toFixed(2) : '—'}, rank=${provider.rank ?? '—'}`;
    }).join('; ');
    return res.json({
      mode: 'live',
      source: 'vcr-epp-live',
      events: [{
        time: live.generated_at || new Date().toISOString(),
        type: 'live_metrics',
        label: `Live EPP metrics: ${selected?.site || 'no selected provider'} rank 0`,
        detail: metrics,
        severity: 'info',
      }],
    });
  }
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ mode: 'unavailable', source: 'vcr', events: [] });
  }
  const events = vcrTimelineFromEvidence(evidence);
  res.json({ mode: 'replay', source: 'vcr-epp', events });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`Routing Observability UI running at http://localhost:${PORT}`);
  console.log(`Jaeger endpoint: ${JAEGER_URL}`);
  console.log(`Mode: ${currentMode} (auto-detects Jaeger availability)`);
});

export { app, server };
