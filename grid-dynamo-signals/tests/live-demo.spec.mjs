import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.env.DEMO_PLAYWRIGHT_EVIDENCE_DIR || path.join(root, 'evidence/playwright'));

async function state(page) {
  const response = await page.request.get('/api/state', { timeout: 15_000 });
  expect(response.ok(), 'live state API must return successfully').toBeTruthy();
  return response.json();
}

async function sendFreshProbe(page, kind, control, stateBefore) {
  const previousRequestIds = new Set(stateBefore.probes.map(probe => probe.requestId));
  await page.getByTestId(control).click();

  let freshProbe;
  await expect.poll(async () => {
    const current = await state(page);
    freshProbe = [...current.probes].reverse().find(probe =>
      probe.kind === kind && !previousRequestIds.has(probe.requestId) && probe.completedAt,
    );
    return freshProbe?.requestId || null;
  }, { timeout: 60_000, message: `${kind} probe must complete with a new request ID` }).not.toBeNull();

  await expect(probeResultRow(page, freshProbe.requestId)).toContainText('Valid Mocker response');
  return freshProbe;
}

function gatewayRequestCounters(stateValue) {
  const requests = stateValue.gatewayMetrics?.crossSite?.requests;
  expect(requests?.status, 'Site Gateway request counters must be live').toBe('LIVE');
  return Object.fromEntries(['pool-a', 'pool-b', 'site-pool'].map(id => {
    const readings = (requests.counts || []).filter(item => item.cluster === id);
    expect(readings.length, `${id} must have an actual Site Gateway counter series`).toBeGreaterThan(0);
    expect(readings.every(item => Number.isFinite(item.value) && item.value >= 0), `${id} counter samples must be valid`).toBeTruthy();
    return [id, readings.reduce((sum, item) => sum + item.value, 0)];
  }));
}

async function expectPoolCounterAtLeast(page, poolId, minimum) {
  const counter = page.getByTestId(`pool-request-counter-${poolId}`);
  await expect.poll(async () => {
    const value = Number(await counter.textContent());
    return Number.isSafeInteger(value) ? value : -1;
  }, { message: `${poolId} displayed Gateway request counter must reach the captured live value` })
    .toBeGreaterThanOrEqual(minimum);
}

async function generateTrafficSample(page, count, previousRunId = null) {
  await page.getByTestId('traffic-count').fill(String(count));
  await page.getByTestId('generate-traffic').click();
  let completed;
  await expect.poll(async () => {
    const current = await state(page);
    const sample = current.traffic;
    if (sample?.phase === 'completed' && sample.running === false && sample.id !== previousRunId) {
      completed = current;
      return sample.id;
    }
    return null;
  }, { timeout: 90_000, message: 'bounded Site Gateway request sample must complete' }).not.toBeNull();
  await expect(page.getByTestId('traffic-state')).toHaveText('COMPLETED');
  return completed;
}

async function qualifyPressureTarget(page, targetId, evidence) {
  await expect(page.getByTestId(`pool-pressure-${targetId}`), `${targetId} must have fresh route and Frontend sources`).toBeEnabled({ timeout: 90_000 });
  const before = await state(page);
  await page.getByTestId(`pool-pressure-${targetId}`).click();
  await expect(page.getByTestId('pressure-state')).toContainText('PRESSURE OBSERVED', { timeout: 100_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.pressure.runsByPool?.[targetId]?.phase === 'applied';
  }, { timeout: 20_000 }).toBeTruthy();

  const pressured = await state(page);
  const run = pressured.pressure.runsByPool[targetId];
  expect(run.target.id).toBe(targetId);
  expect(run.workerCount).toBe(4);
  expect(run.gate.targetPool).toBe(targetId);
  const active = pool(pressured, targetId).activeRequests;
  expect(active.status).toBe('LIVE');
  expect(active.value).toBeGreaterThanOrEqual(pool(pressured, targetId).capacity);
  const siteCandidate = pressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === targetId);
  expect(siteCandidate.scoreStatus).toBe('LIVE');
  expect(siteCandidate.rho).toBeGreaterThanOrEqual(1);
  expect(siteCandidate.scoreOrder).toBeGreaterThan(1);
  if (targetId === 'site-pool') {
    expect(run.routeScope).toBe('site-grid-site-route-snapshot');
    expect(run.gate.publishedRevision).toBeNull();
  } else {
    expect(run.routeScope).toBe('hub-local-pressure-overlay');
    expect(pressured.overlay.published.revision).not.toBe(run.baselineRevision);
    expect(pressured.overlay.consumed.revision).toBe(pressured.overlay.published.revision);
    expect(pressured.overlay.converged).toBeTruthy();
  }

  const pressureCountersBefore = gatewayRequestCounters(await state(page));
  await expect(page.getByTestId('generate-traffic'), 'sample waits until the Site Gateway observes this selected pool under pressure')
    .toBeEnabled({ timeout: 45_000 });
  const pressureTrafficState = await generateTrafficSample(page, 12, before.traffic?.id || null);
  const pressureTraffic = pressureTrafficState.traffic;
  expect(pressureTraffic.completed).toBe(12);
  expect(pressureTraffic.succeeded).toBe(12);
  expect(pressureTraffic.failed).toBe(0);
  expect(pressureTraffic.attributed).toBe(12);
  expect(pressureTraffic.unattributed).toBe(0);
  expect(pressureTraffic.countsByPool[targetId], `${targetId} must receive no request during its observed pressure sample`).toBe(0);
  expect(Object.entries(pressureTraffic.countsByPool).filter(([id]) => id !== targetId)
    .reduce((sum, [, count]) => sum + count, 0)).toBe(12);
  const pressureCountersAfter = gatewayRequestCounters(pressureTrafficState);
  expect(pressureCountersAfter[targetId]).toBe(pressureCountersBefore[targetId]);
  expect(Object.entries(pressureCountersAfter).filter(([id]) => id !== targetId)
    .reduce((sum, [id, count]) => sum + count - pressureCountersBefore[id], 0)).toBeGreaterThan(0);
  await expect(page.getByTestId(`pool-${targetId}`).locator('.pool-request-counter small')).toHaveText('0 routed this sample');
  expect(pressureTraffic.results).toHaveLength(12);
  for (const result of pressureTraffic.results) {
    expect(result.status).toBe(200);
    expect(result.validResponse).toBeTruthy();
    expect(result.poolId).not.toBe(targetId);
    expect(['pool-a', 'pool-b', 'site-pool']).toContain(result.poolId);
    expect(result.attribution.backend).toBe(result.poolId);
    expect(result.attribution.site).toBe(pool(before, result.poolId).site);
  }
  await page.screenshot({ path: path.join(evidence, `desktop-pressure-${targetId}-request-sample.png`) });

  await page.getByTestId(`pool-pressure-${targetId}`).click();
  await expect(page.getByTestId(`pool-pressure-state-${targetId}`)).toContainText('RECOVERED', { timeout: 120_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.pressure.runsByPool?.[targetId]?.phase === 'recovered' && current.pools.every(item =>
      item.activeRequests.status === 'LIVE' && item.activeRequests.value === 0);
  }, { timeout: 30_000 }).toBeTruthy();
  const recovered = await state(page);
  expect(recovered.pressure.runsByPool[targetId].target.id).toBe(targetId);
  if (targetId === 'site-pool') {
    const candidate = recovered.gatewayMetrics.crossSite.candidates.find(item => item.cluster === targetId);
    expect(candidate.scoreStatus).toBe('LIVE');
    expect(candidate.rho).toBeLessThan(1);
    expect(candidate.sampleAgeSeconds).toBeLessThanOrEqual(recovered.gatewayMetrics.crossSite.freshnessWindowMs / 1000);
  } else {
    expect(recovered.overlay.converged).toBeTruthy();
    expect(recovered.overlay.consumed.revision).toBe(recovered.overlay.published.revision);
    expect(recovered.overlay.published.candidates.find(item => item.cluster === 'pool-a').rank)
      .toBeLessThan(recovered.overlay.published.candidates.find(item => item.cluster === 'pool-b').rank);
  }

  const recoveryCountersBefore = gatewayRequestCounters(recovered);
  const recoveryTrafficState = await generateTrafficSample(page, 24, pressureTraffic.id);
  const recoveryTraffic = recoveryTrafficState.traffic;
  expect(recoveryTraffic.completed).toBe(24);
  expect(recoveryTraffic.succeeded).toBe(24);
  expect(recoveryTraffic.failed).toBe(0);
  expect(recoveryTraffic.attributed).toBe(24);
  expect(recoveryTraffic.unattributed).toBe(0);
  expect(recoveryTraffic.countsByPool[targetId], `${targetId} must receive traffic again after recovery`).toBeGreaterThan(0);
  const recoveryCountersAfter = gatewayRequestCounters(recoveryTrafficState);
  expect(recoveryCountersAfter[targetId]).toBeGreaterThan(recoveryCountersBefore[targetId]);
  await expect(page.getByTestId(`pool-${targetId}`).locator('.pool-request-counter small'))
    .toHaveText(`${recoveryTraffic.countsByPool[targetId]} routed this sample`);
  await page.screenshot({ path: path.join(evidence, `desktop-recovery-${targetId}-request-sample.png`) });
  return {
    targetId,
    baselineRevision: before.overlay.published.revision,
    pressureRevision: pressured.overlay.published.revision,
    pressureActiveRequests: active.value,
    pressureCountsByPool: pressureTraffic.countsByPool,
    recoveryCountsByPool: recoveryTraffic.countsByPool,
  };
}

function pool(stateValue, id) {
  const result = stateValue.pools.find(item => item.id === id);
  expect(result, `pool ${id} must be configured`).toBeTruthy();
  return result;
}

function probeResultRow(page, requestId) {
  return page.locator(`[data-testid="probe-result"] td[title="${requestId}"]`).locator('xpath=..');
}

function watchPage(page, errors, label = 'desktop') {
  page.on('console', message => { if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`${label} page: ${error.name}`));
  page.on('requestfailed', request => errors.push(`${label} request: ${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText || ''}`));
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${label} HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
  });
}

test.afterEach(async ({ request }) => {
  const stateResponse = await request.get('/api/state', { timeout: 15_000 }).catch(() => null);
  if (!stateResponse?.ok()) return;
  const current = await stateResponse.json();
  if (current.traffic?.running) {
    const stopped = await request.post('/api/traffic/stop', { timeout: 60_000 });
    expect(stopped.ok(), 'failed test cleanup must stop run-owned Site Gateway sample traffic').toBeTruthy();
  }
  if ((current.pressure?.activeTargets || []).length > 0 || ['starting', 'applied', 'recovering', 'recovery-pending', 'failed'].includes(current.pressure?.phase)) {
    const recovered = await request.post('/api/pressure/stop', { timeout: 120_000 });
    expect(recovered.ok(), 'failed test cleanup must stop run-owned direct pressure').toBeTruthy();
  }
  if (current.peer?.signals?.value === false || ['interrupted', 'interrupting', 'interruption-pending'].includes(current.interruption?.phase)) {
    const restored = await request.post('/api/peer/restore', { timeout: 120_000 });
    expect(restored.ok(), 'failed test cleanup must restore the run-owned peer signal endpoint').toBeTruthy();
  }
});

test('live Grid/Dynamo signal flow, per-pool pressure, routing, recovery, and peer interruption', async ({ page, browser }) => {
  test.setTimeout(720_000);
  fs.mkdirSync(evidence, { recursive: true });
  const browserErrors = [];
  watchPage(page, browserErrors);

  await page.goto('/');
  await expect(page.locator('.weighted-dashboard')).toBeVisible();
  await expect(page.locator('.topology-panel')).toContainText('Hub Gateway');
  await expect(page.locator('.topology-panel')).toContainText('Secure peer signals');
  await expect(page.getByRole('heading', { name: 'Grid · Dynamo Signals' })).toBeVisible();
  await expect(page.getByText('Queue depth', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('live-badge')).toContainText('3/3 POOLS LIVE', { timeout: 90_000 });
  await expect(page.getByTestId('pool-pool-a')).toBeVisible();
  await expect(page.getByTestId('pool-pool-b')).toBeVisible();
  await expect(page.getByTestId('pool-site-pool')).toBeVisible();
  await expect(page.getByTestId('pool-pool-a').locator('h2')).toHaveText('Dynamo · Pool A');
  await expect(page.getByTestId('pool-pool-b').locator('h2')).toHaveText('Dynamo · Pool B');
  await expect(page.getByTestId('pool-site-pool').locator('h2')).toHaveText('Dynamo · Remote Pool');
  await expect(page.getByTestId('pool-pool-a')).toContainText('LOCAL KIND CLUSTER · grid-sig-demo-local-site');
  await expect(page.getByTestId('pool-pool-a')).toContainText('pool-a · Pod dynamo-pool-a · Frontend + Mocker');
  await expect(page.getByTestId('pool-pool-a')).toContainText('kind-grid-sig-demo-hub');
  await expect(page.getByTestId('pool-pool-b')).toContainText('pool-b · Pod dynamo-pool-b · Frontend + Mocker');
  await expect(page.getByTestId('pool-pool-b')).toContainText('kind-grid-sig-demo-hub');
  await expect(page.getByTestId('pool-site-pool')).toContainText('REMOTE KIND CLUSTER · grid-sig-demo-remote-site');
  await expect(page.getByTestId('pool-site-pool')).toContainText('site-pool · Pod dynamo-remote-pool · Frontend + Mocker');
  await expect(page.getByTestId('pool-site-pool')).toContainText('kind-grid-sig-demo-site');
  await expect(page.locator('.dynamo-section-heading')).toContainText('Dynamo · Pool A and Dynamo · Pool B are independent Frontend + Mocker Pods in the local Kind cluster');
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    await expect(page.getByTestId(`pool-pressure-${id}`)).toBeVisible();
    await expect(page.getByTestId(`pool-pressure-${id}`)).toContainText('Generate pressure');
  }
  await expect(page.getByTestId('reset-counters')).toBeEnabled();
  await expect(page.getByTestId('revision-state')).toContainText('LIVE');
  const captionSafe = await page.locator('.caption-safe').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { height: bounds.height, top: bounds.top, bottom: bounds.bottom, viewportHeight: innerHeight };
  });
  expect(captionSafe.height).toBeGreaterThanOrEqual(80);
  expect(captionSafe.top).toBeGreaterThanOrEqual(780);
  expect(captionSafe.bottom).toBeLessThanOrEqual(captionSafe.viewportHeight);

  const baseline = await state(page);
  expect(baseline.identity.gridCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(baseline.identity.gridSourceStateSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(baseline.identity.dynamoImage).toContain('sha256:');
  expect(baseline.identity.architecture).toBe('linux/amd64');
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    const candidatePool = pool(baseline, id);
    expect(candidatePool.label).toBe({
      'pool-a': 'Dynamo · Pool A',
      'pool-b': 'Dynamo · Pool B',
      'site-pool': 'Dynamo · Remote Pool',
    }[id]);
    expect(candidatePool.source.status, `${id} Frontend scrape must be live`).toBe('LIVE');
    expect(candidatePool.source.ageSeconds).toBeLessThanOrEqual(5);
    expect(candidatePool.modelReady.status).toBe('LIVE');
    expect(candidatePool.modelReady.value).toBe(1);
    expect(candidatePool.activeRequests.status).toBe('LIVE');
    expect(Number.isFinite(candidatePool.activeRequests.value)).toBeTruthy();
    expect(candidatePool.activeRequests.value).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId(`active-requests-${id}`)).toHaveText(String(candidatePool.activeRequests.value));
    await expect(page.getByTestId(`pool-${id}`).locator('progress')).toHaveCount(0);
    expect(candidatePool.profile).toBe('dynamo-mocker-bounded-4-v1');
    expect(candidatePool.capacity).toBe(4);
  }
  expect(baseline.profile.id).toBe('dynamo-mocker-bounded-4-v1');
  expect(baseline.profile.capacity).toBe(4);
  expect(baseline.overlay.published.status).toBe('LIVE');
  expect(baseline.overlay.consumed.status).toBe('LIVE');
  expect(baseline.overlay.converged).toBeTruthy();
  expect(baseline.overlay.published.revision).toBeTruthy();
  expect(baseline.overlay.consumed.revision).toBe(baseline.overlay.published.revision);
  expect(baseline.overlay.published.candidates.length).toBeGreaterThanOrEqual(2);
  expect(baseline.overlay.published.candidates.map(item => item.cluster).sort()).toEqual(['pool-a', 'pool-b']);
  expect(baseline.gatewayMetrics.crossSite.status).toBe('LIVE');
  expect(baseline.gatewayMetrics.crossSite.candidates).toHaveLength(3);
  expect(baseline.gatewayMetrics.crossSite.candidates.every(item => item.sampleAgeSeconds <= 10)).toBeTruthy();
  await expect(page.getByTestId('local-candidate-scope')).toContainText('Pool A and Pool B only');
  await expect(page.getByTestId('local-candidate-scope')).toContainText('Remote Pool has a separate Site Gateway ranking');
  await expect(page.getByTestId('local-candidate-table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('site-ranking-jump')).toHaveAttribute('href', '#siteGatewayCandidates');
  await expect(page.getByTestId('site-candidate-table')).toBeVisible();
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    const candidate = baseline.gatewayMetrics.crossSite.candidates.find(item => item.cluster === id);
    expect(candidate.scoreStatus).toBe('LIVE');
    await expect(page.getByTestId(`site-candidate-${id}`)).toBeVisible();
    await expect(page.getByTestId(`site-candidate-order-${id}`)).toHaveText(String(candidate.scoreOrder));
  }
  await expect(page.getByTestId('site-candidate-site-pool')).toContainText('Dynamo · Remote Pool');
  const baselineRevision = baseline.overlay.published.revision;
  const baselineRankA = baseline.overlay.published.candidates.find(item => item.cluster === 'pool-a')?.rank;
  const baselineRankB = baseline.overlay.published.candidates.find(item => item.cluster === 'pool-b')?.rank;
  expect(Number.isInteger(baselineRankA) && Number.isInteger(baselineRankB)).toBeTruthy();
  await expect(page.getByTestId('candidate-pool-a').locator('.rank-badge')).toHaveText(String(baselineRankA));
  await expect(page.getByTestId('candidate-pool-b').locator('.rank-badge')).toHaveText(String(baselineRankB));
  expect(await page.getByTestId('candidate-site-pool').count()).toBe(0);
  await page.screenshot({ path: path.join(evidence, 'desktop-baseline.png') });

  await page.getByTestId('site-ranking-jump').click();
  await expect(page.getByTestId('site-candidate-site-pool')).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.getByTestId('reset-counters').click();
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    await expect(page.getByTestId(`pool-request-counter-${id}`)).toHaveText('0');
  }
  await page.screenshot({ path: path.join(evidence, 'desktop-counters-reset.png') });
  const baselineCountersBefore = gatewayRequestCounters(await state(page));
  const baselineTrafficState = await generateTrafficSample(page, 24, baseline.traffic?.id || null);
  const baselineTraffic = baselineTrafficState.traffic;
  expect(baselineTraffic.requested).toBe(24);
  expect(baselineTraffic.completed).toBe(24);
  expect(baselineTraffic.succeeded).toBe(24);
  expect(baselineTraffic.failed).toBe(0);
  expect(baselineTraffic.attributed).toBe(24);
  expect(baselineTraffic.unattributed).toBe(0);
  const baselineCountersAfter = gatewayRequestCounters(baselineTrafficState);
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    const sampled = baselineTraffic.countsByPool[id];
    expect(Number.isSafeInteger(sampled) && sampled > 0, `${id} must receive real baseline Site Gateway requests`).toBeTruthy();
    expect(baselineCountersAfter[id]).toBeGreaterThan(baselineCountersBefore[id]);
    await expectPoolCounterAtLeast(page, id, baselineCountersAfter[id] - baselineCountersBefore[id]);
    await expect(page.getByTestId(`pool-${id}`).locator('.pool-request-counter small')).toHaveText(`${sampled} routed this sample`);
  }
  expect(baselineTraffic.results).toHaveLength(24);
  for (const result of baselineTraffic.results) {
    expect(result.status).toBe(200);
    expect(result.validResponse).toBeTruthy();
    expect(['pool-a', 'pool-b', 'site-pool']).toContain(result.poolId);
    expect(result.attribution.backend).toBe(result.poolId);
    expect(result.attribution.site).toBe(pool(baseline, result.poolId).site);
  }
  await page.screenshot({ path: path.join(evidence, 'desktop-baseline-request-sample.png') });

  await expect(page.getByTestId('pool-pressure-pool-a'), 'Pool A pressure is enabled after its live Frontend gauge returns to zero').toBeEnabled({ timeout: 45_000 });
  await page.getByTestId('pool-pressure-pool-a').click();
  await expect(page.getByTestId('pressure-state')).toContainText('PRESSURE OBSERVED', { timeout: 100_000 });
  await expect.poll(async () => {
    const current = await state(page);
    const poolA = pool(current, 'pool-a');
    const run = current.pressure.runsByPool?.['pool-a'];
    return run?.phase === 'applied' && run.completed > 0 && run.valid > 0 &&
      poolA.activeRequests.status === 'LIVE' && poolA.activeRequests.value > 0;
  }, { timeout: 45_000 }).toBeTruthy();
  const pressured = await state(page);
  const poolAPressure = pressured.pressure.runsByPool['pool-a'];
  expect(poolAPressure.target.id).toBe('pool-a');
  expect(poolAPressure.routeScope).toBe('hub-local-pressure-overlay');
  const active = pool(pressured, 'pool-a').activeRequests;
  expect(active.status).toBe('LIVE');
  expect(active.value).toBeGreaterThanOrEqual(pool(pressured, 'pool-a').capacity);
  const pressureRankA = pressured.overlay.published.candidates.find(item => item.cluster === 'pool-a')?.rank;
  const pressureRankB = pressured.overlay.published.candidates.find(item => item.cluster === 'pool-b')?.rank;
  expect(pressureRankA).toBeGreaterThan(pressureRankB);
  expect(pressured.overlay.published.revision).not.toBe(poolAPressure.baselineRevision);
  expect(pressured.overlay.consumed.revision).toBe(pressured.overlay.published.revision);
  expect(pressured.overlay.converged).toBeTruthy();
  expect(poolAPressure.workerCount).toBe(4);
  expect(poolAPressure.completed).toBeGreaterThan(0);
  expect(poolAPressure.valid).toBeGreaterThan(0);
  expect(poolAPressure.gate.activeRequests).toBeGreaterThan(0);
  const activeSamples = page.locator('.pressure-chart-disclosure');
  await activeSamples.locator('summary').click();
  await expect(activeSamples).toHaveJSProperty('open', true);
  await expect.poll(async () => (await page.locator('.active-line').getAttribute('points'))?.trim() || '').not.toBe('');
  await page.screenshot({ path: path.join(evidence, 'desktop-pressure-observed.png') });

  const pressureProbe = await sendFreshProbe(page, 'local', 'probe-gateway', pressured);
  expect(pressureProbe.validResponse).toBeTruthy();
  expect(pressureProbe.status).toBe(200);
  expect(pressureProbe.requestId).toContain('probe-');
  expect(pressureProbe.attribution.site).toBeNull();
  expect(pressureProbe.attribution.backend).toBeNull();
  expect(pressureProbe.attribution.providerSite).toBeNull();
  expect(pressureProbe.attribution.siteContract).toBe('not emitted by this route');
  expect(pressureProbe.attribution.backendContract).toBe('not emitted by this route');
  expect(pressureProbe.attribution.providerSiteContract).toBe('not emitted by this route');
  expect(pressureProbe.frontendSample.find(item => item.id === 'pool-a')?.activeRequests).toBeGreaterThan(0);
  expect(pressureProbe.frontendSample.find(item => item.id === 'pool-a')?.modelReady.value).toBe(1);
  expect(pressureProbe.routingEvidence.scope).toBe('hub-local-pressure-overlay');
  expect(pressureProbe.routingEvidence.gatewayRequestDelta.status).toBe('LIVE');
  expect(pressureProbe.routingEvidence.gatewayRequestDelta.total).toBe(1);
  expect(pressureProbe.routingEvidence.gatewayRequestDelta.selectedBackend).toBe('pool-b');
  expect(pressureProbe.overlayPublishedBefore).toBe(pressured.overlay.published.revision);
  expect(pressureProbe.overlayConsumedBefore).toBe(pressured.overlay.consumed.revision);
  expect(pressureProbe.gatewayMetricsBefore.status).toBe('LIVE');
  expect(pressureProbe.gatewayMetricsAfter.status).toBe('LIVE');
  expect(pressureProbe.gatewayMetricsBefore.requests.status).toBe('LIVE');
  expect(pressureProbe.gatewayMetricsAfter.requests.status).toBe('LIVE');
  expect(pressureProbe.overlayPublishedAfter).toMatch(/^[0-9a-f]{64}$/);
  expect(pressureProbe.overlayConsumedAfter).toBe(pressureProbe.overlayPublishedAfter);
  expect(pressureProbe.overlayPublishedAfter).not.toBe(poolAPressure.baselineRevision);
  const pressureProbeRow = probeResultRow(page, pressureProbe.requestId);
  await expect(pressureProbeRow).toContainText('Not emitted by this route');
  await expect(pressureProbeRow).toContainText('pool-b');
  await expect(pressureProbeRow).toContainText('one Gateway request counter increment');

  await page.getByTestId('reset-counters').click();
  for (const id of ['pool-a', 'pool-b', 'site-pool']) {
    await expect(page.getByTestId(`pool-request-counter-${id}`)).toHaveText('0');
  }
  const pressuredCountersBefore = gatewayRequestCounters(await state(page));
  await expect(page.getByTestId('pool-pressure-pool-b'), 'Pool B can be pressured while Pool A pressure remains active')
    .toBeEnabled({ timeout: 90_000 });
  await page.getByTestId('pool-pressure-pool-b').click();
  await expect(page.getByTestId('pressure-state')).toContainText('2 POOLS', { timeout: 100_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.pressure.runsByPool?.['pool-a']?.phase === 'applied' &&
      current.pressure.runsByPool?.['pool-b']?.phase === 'applied';
  }, { timeout: 30_000 }).toBeTruthy();
  await expect.poll(async () => {
    const current = await state(page);
    return ['pool-a', 'pool-b'].every(id => current.pressure.runsByPool?.[id]?.valid > 0);
  }, { timeout: 45_000, message: 'both independent Frontend+Mocker pressure runs must complete valid direct requests' }).toBeTruthy();
  const bothPressured = await state(page);
  const poolBPressure = bothPressured.pressure.runsByPool['pool-b'];
  for (const id of ['pool-a', 'pool-b']) {
    const frontend = pool(bothPressured, id);
    const run = bothPressured.pressure.runsByPool[id];
    expect(run.phase).toBe('applied');
    expect(run.valid).toBeGreaterThan(0);
    expect(frontend.activeRequests.status).toBe('LIVE');
    expect(frontend.activeRequests.value).toBeGreaterThanOrEqual(frontend.capacity);
    expect(bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === id)?.rho).toBeGreaterThanOrEqual(1);
  }
  expect(bothPressured.overlay.converged).toBeTruthy();
  expect(bothPressured.overlay.consumed.revision).toBe(bothPressured.overlay.published.revision);
  expect(bothPressured.overlay.published.revision).not.toBe(poolBPressure.baselineRevision);
  const remoteSiteCandidate = bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'site-pool');
  expect(remoteSiteCandidate.scoreStatus).toBe('LIVE');
  expect(remoteSiteCandidate.rho).toBeLessThan(1);
  expect(remoteSiteCandidate.scoreOrder).toBeLessThan(bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'pool-a').scoreOrder);
  expect(remoteSiteCandidate.scoreOrder).toBeLessThan(bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'pool-b').scoreOrder);
  await expect(page.getByTestId('site-candidate-order-site-pool')).toHaveText(String(remoteSiteCandidate.scoreOrder));
  await expect(page.getByTestId('site-candidate-order-pool-a')).toHaveText(String(bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'pool-a').scoreOrder));
  await expect(page.getByTestId('site-candidate-order-pool-b')).toHaveText(String(bothPressured.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'pool-b').scoreOrder));
  await page.getByTestId('site-candidate-table').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'desktop-site-gateway-candidates-under-local-pressure.png') });
  await page.screenshot({ path: path.join(evidence, 'desktop-pool-a-and-b-pressured.png') });

  await expect(page.getByTestId('generate-traffic'), 'sampler must wait until the Site Gateway observes both local pools under pressure')
    .toBeEnabled({ timeout: 45_000 });
  const pressuredTrafficState = await generateTrafficSample(page, 24, baselineTraffic.id);
  const pressuredTraffic = pressuredTrafficState.traffic;
  expect(pressuredTraffic.requested).toBe(24);
  expect(pressuredTraffic.completed).toBe(24);
  expect(pressuredTraffic.succeeded).toBe(24);
  expect(pressuredTraffic.failed).toBe(0);
  expect(pressuredTraffic.attributed).toBe(24);
  expect(pressuredTraffic.unattributed).toBe(0);
  expect(pressuredTraffic.countsByPool['pool-a'], 'no new Site Gateway sample request may enter pressured Pool A').toBe(0);
  expect(pressuredTraffic.countsByPool['pool-b'], 'no new Site Gateway sample request may enter pressured Pool B').toBe(0);
  expect(pressuredTraffic.countsByPool['site-pool'], 'the unpressured remote pool must receive the new sample').toBe(24);
  const pressuredCountersAfter = gatewayRequestCounters(pressuredTrafficState);
  expect(pressuredCountersAfter['pool-a'], 'Pool A Site Gateway counter must not increment during the combined pressure sample')
    .toBe(pressuredCountersBefore['pool-a']);
  expect(pressuredCountersAfter['pool-b'], 'Pool B Site Gateway counter must not increment during the combined pressure sample')
    .toBe(pressuredCountersBefore['pool-b']);
  expect(pressuredCountersAfter['site-pool']).toBeGreaterThan(pressuredCountersBefore['site-pool']);
  await expectPoolCounterAtLeast(page, 'site-pool', pressuredTraffic.countsByPool['site-pool']);
  await expect(page.getByTestId('pool-request-counter-pool-a')).toHaveText('0');
  await expect(page.getByTestId('pool-request-counter-pool-b')).toHaveText('0');
  await expect(page.getByTestId('pool-request-counter-site-pool')).toHaveText('24');
  await expect(page.getByTestId('pool-pool-a').locator('.pool-request-counter small')).toHaveText('0 routed this sample');
  await expect(page.getByTestId('pool-pool-b').locator('.pool-request-counter small')).toHaveText('0 routed this sample');
  for (const result of pressuredTraffic.results) {
    expect(result.status).toBe(200);
    expect(result.validResponse).toBeTruthy();
    expect(result.poolId).toBe('site-pool');
    expect(result.attribution.site).toBe(pool(bothPressured, 'site-pool').site);
    expect(result.attribution.backend).toBe('site-pool');
  }
  await page.screenshot({ path: path.join(evidence, 'desktop-pressure-a-b-remote-request-sample.png') });

  await page.getByTestId('release-pressure').click();
  await expect(page.getByTestId('pressure-state')).toContainText('RECOVERED', { timeout: 120_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.pressure.runsByPool?.['pool-a']?.phase === 'recovered' &&
      current.pressure.runsByPool?.['pool-b']?.phase === 'recovered' &&
      current.pools.every(item => item.activeRequests.status === 'LIVE' && item.activeRequests.value === 0);
  }, { timeout: 120_000 }).toBeTruthy();
  const recovered = await state(page);
  expect(recovered.pressure.activeTargets).toEqual([]);
  expect(recovered.overlay.published.revision).not.toBe(bothPressured.overlay.published.revision);
  expect(recovered.overlay.consumed.revision).toBe(recovered.overlay.published.revision);
  expect(recovered.overlay.converged).toBeTruthy();
  for (const id of ['pool-a', 'pool-b']) {
    const candidate = recovered.gatewayMetrics.crossSite.candidates.find(item => item.cluster === id);
    expect(candidate.scoreStatus).toBe('LIVE');
    expect(candidate.rho).toBeLessThan(1);
  }
  await page.screenshot({ path: path.join(evidence, 'desktop-pool-a-and-b-recovered.png') });

  const recoveryCountersBefore = gatewayRequestCounters(recovered);
  const recoveryTrafficState = await generateTrafficSample(page, 24, pressuredTraffic.id);
  const recoveryTraffic = recoveryTrafficState.traffic;
  expect(recoveryTraffic.completed).toBe(24);
  expect(recoveryTraffic.succeeded).toBe(24);
  expect(recoveryTraffic.failed).toBe(0);
  expect(recoveryTraffic.attributed).toBe(24);
  expect(recoveryTraffic.unattributed).toBe(0);
  expect(recoveryTraffic.countsByPool['pool-a'] + recoveryTraffic.countsByPool['pool-b'], 'at least one recovered local pool must receive real Site Gateway requests again').toBeGreaterThan(0);
  const recoveryCountersAfter = gatewayRequestCounters(recoveryTrafficState);
  expect(recoveryCountersAfter['pool-a'] + recoveryCountersAfter['pool-b']).toBeGreaterThan(recoveryCountersBefore['pool-a'] + recoveryCountersBefore['pool-b']);
  await page.screenshot({ path: path.join(evidence, 'desktop-recovery-request-sample.png') });

  const recoveryProbe = await sendFreshProbe(page, 'local', 'probe-gateway', recovered);
  expect(recoveryProbe.validResponse).toBeTruthy();
  expect(recoveryProbe.status).toBe(200);
  expect(recoveryProbe.attribution.site).toBeNull();
  expect(recoveryProbe.attribution.backend).toBeNull();
  expect(recoveryProbe.attribution.providerSite).toBeNull();
  expect(recoveryProbe.routingEvidence.gatewayRequestDelta.status).toBe('LIVE');
  expect(recoveryProbe.routingEvidence.gatewayRequestDelta.total).toBe(1);
  expect(['pool-a', 'pool-b']).toContain(recoveryProbe.routingEvidence.gatewayRequestDelta.selectedBackend);
  expect(recoveryProbe.frontendSample.find(item => item.id === 'pool-a')?.activeRequests).toBe(0);

  const alternatePoolPressure = {
    targets: ['pool-a', 'pool-b'],
    pressureActiveRequests: {
      'pool-a': pool(bothPressured, 'pool-a').activeRequests.value,
      'pool-b': pool(bothPressured, 'pool-b').activeRequests.value,
    },
    pressureCountsByPool: pressuredTraffic.countsByPool,
    recoveryCountsByPool: recoveryTraffic.countsByPool,
  };
  const remotePoolPressure = await qualifyPressureTarget(page, 'site-pool', evidence);

  await page.getByTestId('peer-controls-link').click();
  await expect(page.getByTestId('peer-controls')).toBeInViewport();
  await page.locator('.peer-details summary').click();
  await expect(page.getByTestId('peer-candidate-site-pool')).toBeVisible();
  await expect(page.locator('#peerCandidateState')).toHaveText('LIVE ROUTE METRICS');
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('interrupt-peer').click();
  await expect(page.locator('#peerState')).toHaveText('INTERRUPTED', { timeout: 60_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.interruption.phase === 'interrupted' && current.interruption.providerGatewayReachable === true;
  }, { timeout: 30_000, message: 'interruption action must finish and confirm the provider Gateway stayed reachable' }).toBeTruthy();
  let interrupted = await state(page);
  expect(interrupted.interruption.phase).toBe('interrupted');
  expect(interrupted.interruption.providerGatewayReachable).toBeTruthy();
  expect(interrupted.peer.gatewayAddress).toBe(interrupted.peer.configuredGatewayAddress);
  expect(interrupted.peer.signals.value).toBe(false);
  expect(interrupted.gatewayMetrics.crossSite.status).toBe('LIVE');
  const routeFreshnessWindowSeconds = interrupted.gatewayMetrics.crossSite.freshnessWindowMs / 1000;
  expect(Number.isFinite(routeFreshnessWindowSeconds) && routeFreshnessWindowSeconds > 0).toBeTruthy();
  const signalUnavailableAt = Date.parse(interrupted.peer.signals.observedAt);
  expect(Number.isFinite(signalUnavailableAt)).toBeTruthy();
  await expect.poll(async () => {
    const current = await state(page);
    const candidates = current.gatewayMetrics.crossSite.candidates;
    const hubCandidates = candidates.filter(item => item.site === pool(current, 'pool-a').site);
    const siteCandidate = candidates.find(item => item.cluster === 'site-pool' && item.site === pool(current, 'site-pool').site);
    return hubCandidates.length === 2 &&
      hubCandidates.every(item => item.scoreStatus === 'UNAVAILABLE' && !Number.isFinite(item.score)) &&
      Number.isFinite(siteCandidate?.score) && Number.isFinite(siteCandidate?.sampleAgeSeconds) &&
      siteCandidate.sampleAgeSeconds <= routeFreshnessWindowSeconds &&
      (Date.now() - signalUnavailableAt) / 1000 > routeFreshnessWindowSeconds + 5;
  }, { timeout: 45_000 }).toBeTruthy();
  interrupted = await state(page);
  expect(interrupted.peer.signals.value).toBe(false);
  expect(interrupted.gatewayMetrics.crossSite.candidates.filter(item => item.site === pool(interrupted, 'pool-a').site)
    .every(item => item.scoreStatus === 'UNAVAILABLE' && !Number.isFinite(item.score))).toBeTruthy();
  expect(interrupted.gatewayMetrics.crossSite.candidates.find(item => item.cluster === 'site-pool')?.sampleAgeSeconds)
    .toBeLessThanOrEqual(routeFreshnessWindowSeconds);
  await expect(page.locator('#peerCandidateState')).toHaveText('STALE');
  await expect(page.getByTestId('probe-peer')).toBeEnabled();
  await expect(page.getByTestId('probe-peer')).toHaveText('Probe local fallback');
  await expect(page.getByTestId('peer-candidate-site-pool')).toBeVisible();
  await expect(page.getByTestId('peer-candidate-pool-a')).toHaveClass(/candidate-unavailable/);
  await expect(page.getByTestId('peer-candidate-site-pool').locator('.rank-badge')).toHaveCount(0);
  await page.screenshot({ path: path.join(evidence, 'desktop-signal-endpoint-interruption.png') });

  const beforeFallbackProbe = await state(page);
  const fallbackProbe = await sendFreshProbe(page, 'crossSite', 'probe-peer', beforeFallbackProbe);
  expect(fallbackProbe.kind).toBe('crossSite');
  expect(fallbackProbe.validResponse).toBeTruthy();
  expect(fallbackProbe.attribution.site).toBe('grid-sig-demo-remote-site');
  expect(fallbackProbe.attribution.backend).toBe('site-pool');
  expect(fallbackProbe.attribution.providerSite).toBeNull();
  expect(fallbackProbe.attribution.providerSiteContract).toBe('not emitted by this route');
  expect(fallbackProbe.routingEvidence.scope).toBe('site-grid-site-route-snapshot');
  expect(fallbackProbe.routingEvidence.peerSignals.reachable).toBe(false);
  expect(fallbackProbe.routingEvidence.gatewayRequestDelta.status).toBe('LIVE');
  expect(fallbackProbe.routingEvidence.gatewayRequestDelta.total).toBe(1);
  expect(fallbackProbe.routingEvidence.gatewayRequestDelta.selectedBackend).toBe('site-pool');
  expect(fallbackProbe.overlayPublishedBefore).toBeNull();

  await page.getByTestId('restore-peer').click();
  await expect(page.locator('#peerState')).toHaveText('LIVE', { timeout: 90_000 });
  await expect.poll(async () => {
    const current = await state(page);
    return current.interruption.phase === 'restored' &&
      current.peer.signals.value === true &&
      current.peer.providerGatewayReady === true;
  }, { timeout: 30_000, message: 'peer restoration must finish after fresh signals report LIVE' }).toBeTruthy();
  const restored = await state(page);
  expect(restored.interruption.phase).toBe('restored');
  expect(restored.peer.signals.value).toBe(true);
  expect(restored.peer.providerGatewayReady).toBeTruthy();
  await expect.poll(async () => {
    const current = await state(page);
    return current.gatewayMetrics.crossSite.candidates.length === 3 &&
      current.gatewayMetrics.crossSite.candidates.every(item => item.sampleAgeSeconds <= 10);
  }, { timeout: 30_000 }).toBeTruthy();
  await expect(page.locator('#peerCandidateState')).toHaveText('LIVE ROUTE METRICS');
  const beforeRestoredProbe = await state(page);
  const restoredProbe = await sendFreshProbe(page, 'crossSite', 'probe-peer', beforeRestoredProbe);
  expect(restoredProbe.validResponse).toBeTruthy();
  expect(restoredProbe.routingEvidence.scope).toBe('site-grid-site-route-snapshot');
  expect(restoredProbe.routingEvidence.peerSignals.reachable).toBe(true);
  expect(restoredProbe.routingEvidence.candidates).toHaveLength(3);
  expect(restoredProbe.routingEvidence.candidates.every(item => item.scoreStatus === 'LIVE' && item.sampleAgeSeconds <= 10)).toBeTruthy();
  expect(restoredProbe.routingEvidence.gatewayRequestDelta.status).toBe('LIVE');
  expect(restoredProbe.routingEvidence.gatewayRequestDelta.total).toBe(1);
  const restoredBackend = restoredProbe.routingEvidence.gatewayRequestDelta.selectedBackend;
  expect(['pool-a', 'pool-b', 'site-pool']).toContain(restoredBackend);
  expect(restoredProbe.attribution.backend).toBe(restoredBackend);
  expect(restoredProbe.attribution.site).toBe(pool(baseline, restoredBackend).site);
  expect(restoredProbe.attribution.siteContract).toBe('emitted');
  expect(restoredProbe.attribution.backendContract).toBe('emitted');
  if (restoredProbe.attribution.providerSite) {
    expect([pool(baseline, 'pool-a').site, pool(baseline, 'site-pool').site]).toContain(restoredProbe.attribution.providerSite);
    expect(restoredProbe.attribution.providerSiteContract).toBe('emitted');
  } else {
    expect(restoredProbe.attribution.providerSiteContract).toBe('not emitted by this route');
  }
  expect(restoredProbe.overlayPublishedBefore).toBeNull();

  const beforeReset = await state(page);
  const previousResetProbeIds = new Set(beforeReset.probes.map(probe => probe.requestId));
  await page.getByTestId('reset-baseline').click();
  await expect(page.getByTestId('pressure-state')).toContainText('BASELINE', { timeout: 90_000 });
  await expect(page.locator('#peerState')).toHaveText('LIVE', { timeout: 60_000 });
  const reset = await state(page);
  expect(pool(reset, 'pool-a').activeRequests.value).toBe(0);
  expect(reset.overlay.converged).toBeTruthy();
  expect(reset.peer.signals.value).toBe(true);
  const resetProbe = reset.probes.at(-1);
  expect(resetProbe.requestId).toBeTruthy();
  expect(previousResetProbeIds.has(resetProbe.requestId)).toBeFalsy();
  expect(resetProbe.validResponse).toBeTruthy();
  expect(resetProbe.status).toBe(200);
  expect(resetProbe.routingEvidence.gatewayRequestDelta.total).toBe(1);
  expect(['pool-a', 'pool-b']).toContain(resetProbe.routingEvidence.gatewayRequestDelta.selectedBackend);
  await page.screenshot({ path: path.join(evidence, 'desktop-reset-baseline.png') });

  const small = await browser.newPage({ viewport: { width: 900, height: 768 } });
  watchPage(small, browserErrors, 'small viewport');
  await small.goto('/');
  await expect(small.getByTestId('live-badge')).toContainText('3/3 POOLS LIVE', { timeout: 45_000 });
  const dimensions = await small.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  await small.screenshot({ path: path.join(evidence, 'small-viewport-900x768.png'), fullPage: true });
  await small.close();

  expect(browserErrors, 'browser console, page, and network errors must be absent').toEqual([]);
  fs.writeFileSync(path.join(evidence, 'qualification-summary.json'), JSON.stringify({
    result: 'PASS',
    runId: reset.runId,
    gridSourceStateSha256: reset.identity.gridSourceStateSha256,
    baselineRevision,
    pressureRevision: pressured.overlay.published.revision,
    pressureActiveRequests: active.value,
    baselineSiteGatewaySample: { requested: baselineTraffic.requested, countsByPool: baselineTraffic.countsByPool },
    pressureSiteGatewaySample: { requested: pressuredTraffic.requested, countsByPool: pressuredTraffic.countsByPool, countersBefore: pressuredCountersBefore, countersAfter: pressuredCountersAfter },
    recoverySiteGatewaySample: { requested: recoveryTraffic.requested, countsByPool: recoveryTraffic.countsByPool },
    concurrentLocalPressure: alternatePoolPressure,
    remotePoolPressure,
    pressureProbe: { requestId: pressureProbe.requestId, responseHeaders: pressureProbe.attribution, metricBackend: pressureProbe.routingEvidence.gatewayRequestDelta.selectedBackend },
    recoveryProbe: { requestId: recoveryProbe.requestId, responseHeaders: recoveryProbe.attribution, metricBackend: recoveryProbe.routingEvidence.gatewayRequestDelta.selectedBackend },
    fallbackProbe: { requestId: fallbackProbe.requestId, attribution: fallbackProbe.attribution },
    restoredProbe: { requestId: restoredProbe.requestId, site: restoredProbe.attribution.site, providerSite: restoredProbe.attribution.providerSite, backend: restoredProbe.attribution.backend },
    finalState: { active: pool(reset, 'pool-a').activeRequests.value, overlayConverged: reset.overlay.converged, peerReachable: reset.peer.signals.value },
    browserErrors,
    viewports: [{ width: 1440, height: 900 }, { width: 900, height: 768 }],
  }, null, 2));
});
