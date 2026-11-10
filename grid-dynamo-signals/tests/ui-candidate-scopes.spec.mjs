import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.env.DEMO_PLAYWRIGHT_EVIDENCE_DIR || path.join(root, 'evidence/playwright'));

test('Hub and Site Gateway candidate scopes make the Remote Pool easy to find', async ({ page }) => {
  fs.mkdirSync(evidence, { recursive: true });
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => browserErrors.push(`page: ${error.message}`));
  page.on('requestfailed', request => browserErrors.push(`network: ${request.url()} · ${request.failure()?.errorText || 'failed'}`));

  await page.goto('/');
  await expect(page.getByTestId('live-badge')).toContainText('3/3 POOLS LIVE', { timeout: 90_000 });
  const response = await page.request.get('/api/state', { timeout: 15_000 });
  expect(response.ok()).toBeTruthy();
  const state = await response.json();
  expect(state.pools.map(pool => pool.id).sort()).toEqual(['pool-a', 'pool-b', 'site-pool']);
  expect(state.gatewayMetrics.crossSite.status).toBe('LIVE');
  expect(state.gatewayMetrics.crossSite.candidates).toHaveLength(3);

  const localTable = page.getByTestId('local-candidate-table');
  await expect(page.getByTestId('local-candidate-scope')).toContainText('Pool A and Pool B only');
  await expect(page.getByTestId('local-candidate-scope')).toContainText('Remote Pool has a separate Site Gateway ranking');
  await expect(localTable.locator('tbody tr')).toHaveCount(2);
  await expect(localTable).not.toContainText('Remote Pool');
  await expect(page.getByTestId('site-candidate-table')).toBeVisible();
  await expect(page.getByTestId('site-candidate-site-pool')).toContainText('Dynamo · Remote Pool');

  const remoteCandidate = state.gatewayMetrics.crossSite.candidates.find(candidate => candidate.cluster === 'site-pool');
  expect(remoteCandidate.scoreStatus).toBe('LIVE');
  await expect(page.getByTestId('site-candidate-order-site-pool')).toHaveText(String(remoteCandidate.scoreOrder));
  await page.screenshot({ path: path.join(evidence, 'candidate-scopes-initial.png') });

  await page.getByTestId('site-ranking-jump').click();
  await expect(page.getByTestId('site-candidate-site-pool')).toBeInViewport();
  await page.screenshot({ path: path.join(evidence, 'remote-pool-ranking-in-view.png') });

  await page.setViewportSize({ width: 900, height: 768 });
  await page.goto('/');
  await expect(page.getByTestId('local-candidate-scope')).toContainText('Remote Pool has a separate Site Gateway ranking');
  await page.getByTestId('site-ranking-jump').click();
  await expect(page.getByTestId('site-candidate-site-pool')).toBeInViewport();
  await page.screenshot({ path: path.join(evidence, 'remote-pool-ranking-small-viewport.png') });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('traffic-count').fill('24');
  await page.getByTestId('generate-traffic').click();
  await expect.poll(async () => {
    const response = await page.request.get('/api/state');
    const current = await response.json();
    return current.traffic?.running === true && current.traffic.completed > 0;
  }, { timeout: 45_000, message: 'real Site Gateway sample must begin before testing baseline reset' }).toBeTruthy();
  await page.getByTestId('stop-traffic').click();
  await expect(page.getByTestId('traffic-state')).toHaveText('STOPPED');
  await page.getByTestId('reset-baseline').click();
  await expect(page.getByTestId('traffic-state')).toHaveText('IDLE', { timeout: 120_000 });
  const resetResponse = await page.request.get('/api/state');
  const resetState = await resetResponse.json();
  expect(resetState.traffic.phase).toBe('idle');
  expect(resetState.pools.every(pool => pool.activeRequests.status === 'LIVE' && pool.activeRequests.value === 0)).toBeTruthy();
  expect(resetState.overlay.converged).toBeTruthy();
  expect(resetState.peer.signals.value).toBe(true);
  expect(browserErrors).toEqual([]);
});
