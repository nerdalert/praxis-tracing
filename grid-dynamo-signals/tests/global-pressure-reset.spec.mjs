import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.env.DEMO_PLAYWRIGHT_EVIDENCE_DIR || path.join(root, 'evidence/playwright'));
const recoverablePhases = ['starting', 'applied', 'recovering', 'recovery-pending', 'failed'];

test.afterEach(async ({ page }) => {
  const response = await page.request.get('/api/state', { timeout: 15_000 }).catch(() => null);
  if (!response?.ok()) return;
  const current = await response.json();
  if (current.traffic?.running) {
    await page.request.post('/api/traffic/stop', { timeout: 90_000 }).catch(() => null);
  }
  if (current.pressure?.activeTargets?.length) {
    await page.request.post('/api/pressure/stop', { timeout: 120_000 }).catch(() => null);
  }
});

async function readState(page) {
  const response = await page.request.get('/api/state', { timeout: 15_000 });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('global Reset pressure releases every pool, including auto-recovering runs', async ({ page }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(evidence, { recursive: true });
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => browserErrors.push(`page: ${error.message}`));
  page.on('requestfailed', request => browserErrors.push(`network: ${request.url()} · ${request.failure()?.errorText || 'failed'}`));

  await page.goto('/');
  await expect(page.getByTestId('live-badge')).toContainText('3/3 POOLS LIVE', { timeout: 90_000 });
  const resetButton = page.getByTestId('reset-pressure');
  await expect(resetButton).toBeVisible();
  const initial = await readState(page);
  let targets = Object.entries(initial.pressure.runsByPool || {})
    .filter(([, run]) => recoverablePhases.includes(run.phase))
    .map(([poolId]) => poolId);

  if (initial.traffic.running) {
    await page.getByTestId('stop-traffic').click();
    await expect.poll(async () => (await readState(page)).traffic.running, { timeout: 90_000 }).toBe(false);
  }

  let startSampler = false;
  const pressureDurationsSeconds = {};
  if (targets.length === 0) {
    await page.getByTestId('reset-baseline').click();
    await expect(page.getByTestId('pressure-state')).toContainText('BASELINE', { timeout: 120_000 });
    for (const poolId of ['pool-b', 'site-pool']) {
      await page.getByTestId(`pool-pressure-${poolId}`).click();
      await expect.poll(async () => (await readState(page)).pressure.runsByPool?.[poolId]?.phase, { timeout: 100_000 })
        .toBe('applied');
    }
    targets = ['pool-b', 'site-pool'];
    const pressureState = await readState(page);
    for (const poolId of targets) {
      const run = pressureState.pressure.runsByPool[poolId];
      const durationSeconds = (Date.parse(run.endsAt) - Date.parse(run.startedAt)) / 1000;
      expect(durationSeconds, `${poolId} pressure deadline must be five minutes`).toBeGreaterThanOrEqual(299);
      expect(durationSeconds, `${poolId} pressure deadline must be five minutes`).toBeLessThanOrEqual(301);
      pressureDurationsSeconds[poolId] = durationSeconds;
    }
    startSampler = true;
  }

  if (startSampler) {
    await page.getByTestId('traffic-count').fill('12');
    await page.getByTestId('generate-traffic').click();
    await expect.poll(async () => {
      const current = await readState(page);
      return current.traffic.running && current.traffic.completed > 0;
    }, { timeout: 60_000, message: 'the Site Gateway sample must be active before resetting pressure' }).toBe(true);
  }

  expect(targets.length).toBeGreaterThan(0);
  for (const poolId of targets.filter(id => initial.pressure.runsByPool?.[id]?.phase === 'recovering')) {
    await expect(page.getByTestId(`pool-pressure-${poolId}`)).toBeDisabled();
  }
  await expect(resetButton).toBeEnabled();
  if (startSampler) await expect(page.getByTestId('traffic-state')).toHaveText('GENERATING');
  await page.screenshot({ path: path.join(evidence, 'global-pressure-reset-before.png') });
  await resetButton.click();

  await expect.poll(async () => {
    const current = await readState(page);
    return targets.every(poolId => current.pressure.runsByPool?.[poolId]?.phase === 'recovered') &&
      current.pressure.activeTargets.length === 0 &&
      current.pools.every(pool => pool.activeRequests.status === 'LIVE' && pool.activeRequests.value === 0) &&
      current.overlay.converged && current.overlay.published.revision === current.overlay.consumed.revision &&
      current.peer.signals.status === 'LIVE' && current.peer.signals.value === true;
  }, { timeout: 120_000, message: 'global reset must complete pressure recovery for every target' }).toBe(true);
  if (startSampler) {
    await expect.poll(async () => (await readState(page)).traffic.running, { timeout: 90_000 }).toBe(false);
    const completedSample = await readState(page);
    expect(completedSample.traffic.phase).toBe('completed');
    expect(completedSample.traffic.failed).toBe(0);
    expect(completedSample.traffic.completed).toBe(12);
  }
  await expect(resetButton).toBeDisabled();
  await page.screenshot({ path: path.join(evidence, 'global-pressure-reset-after.png') });
  expect(browserErrors).toEqual([]);

  const final = await readState(page);
  fs.writeFileSync(path.join(evidence, 'global-pressure-reset-summary.json'), JSON.stringify({
    runId: final.runId,
    targets,
    recoveredPhases: Object.fromEntries(targets.map(poolId => [poolId, final.pressure.runsByPool[poolId].phase])),
    pressureDurationsSeconds,
    activeRequests: Object.fromEntries(final.pools.map(pool => [pool.id, pool.activeRequests.value])),
    overlayPublishedRevision: final.overlay.published.revision,
    overlayConsumedRevision: final.overlay.consumed.revision,
    peerSignals: final.peer.signals.value,
    browserErrors,
  }, null, 2) + '\n');
});
