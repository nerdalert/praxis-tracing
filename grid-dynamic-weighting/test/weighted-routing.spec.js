import { test, expect } from '@playwright/test';

const BASE_URL = process.env.WEIGHTED_BASE_URL || 'http://localhost:3001';

async function weighted(page) {
  const response = await page.request.get(`${BASE_URL}/api/v1/weighted`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function waitForWeights(page, expected) {
  await expect.poll(async () => {
    const state = await weighted(page);
    if (state.action?.status !== 'complete') return 'transitioning';
    return state.providers
      .slice()
      .sort((a, b) => String(a.site).localeCompare(String(b.site)))
      .map((provider) => provider.traffic_weight)
      .join('/');
  }, { timeout: 300000, intervals: [1000, 2000, 5000] }).toBe(expected);
}

test.describe.serial('live weighted routing dashboard', () => {
  test('renders baseline topology and convergence', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { name: 'Grid Dynamic Weighting', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'pool-a' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'pool-b' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'pool-c' })).toBeVisible();
    await expect(page.getByText('100').first()).toBeVisible();
    await expect(page.getByText('expected new-request share').first()).toBeVisible();
    await expect(page.getByText('33.3%').first()).toBeVisible();
    await expect(page.locator('.weighted-grid .simulator-list > .eyebrow')).toHaveCount(3);
    await expect(page.locator('.convergence-panel').getByText('CONVERGED').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/weighted-baseline-desktop.png', fullPage: true });
  });

  test('applies real pressure and recovers', async ({ page }) => {
    test.setTimeout(300000);
    await page.goto(BASE_URL);
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByLabel('pool-a simulated queue depth').fill('3');
    const pressureResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/weighted/metrics') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Set all queue depths' }).click();
    await expect((await pressureResponse).status()).toBe(202);
    await expect(page.getByRole('status')).toContainText('Updating simulator metric configuration');
    await waitForWeights(page, '34/133/133');
    await expect.poll(async () => page.locator('.weighted-grid').innerText(), { timeout: 15000, intervals: [1000, 2000] }).toContain('Queue utilization\n75%');
    await expect(page.getByText('Source: Grid published overlay candidate traffic_weight').first()).toBeVisible();
    await expect(page.getByText('44.3%').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/weighted-pressure-desktop.png', fullPage: true });
    const recoveryResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/weighted/pressure') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Reset all pools to idle' }).click();
    await expect((await recoveryResponse).status()).toBe(202);
    await expect(page.getByRole('status')).toContainText('Updating simulator metric configuration');
    await waitForWeights(page, '100/100/100');
    await expect(page.getByText('33.3%').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/weighted-recovery-desktop.png', fullPage: true });
    expect(consoleErrors).toEqual([]);
  });

  test('keeps the topology readable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { name: 'pool-a' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'pool-b' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'pool-c' })).toBeVisible();
    await page.screenshot({ path: 'test-results/weighted-baseline-mobile.png', fullPage: true });
  });

  test('runs real traffic through pressure and recovery', async ({ page }) => {
    test.setTimeout(360000);
    await page.goto(BASE_URL);
    await page.getByRole('button', { name: 'Clear request history' }).click();
    await page.getByLabel('Until stopped').check();
    await page.getByRole('button', { name: 'Start routing sampler' }).click();
    await expect.poll(async () => (await (await page.request.get(`${BASE_URL}/api/v1/weighted`)).json()).requests.length,
      { timeout: 30000 }).toBeGreaterThanOrEqual(30);
    await expect(page.getByText('RUNNING', { exact: true }).first()).toBeVisible();

    await page.getByLabel('pool-a simulated queue depth').fill('3');
    const pressureResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/weighted/metrics') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Set all queue depths' }).click();
    await expect((await pressureResponse).status()).toBe(202);
    await expect(page.getByRole('status')).toContainText('Updating simulator metric configuration');
    await waitForWeights(page, '34/133/133');
    await expect.poll(async () => (await (await page.request.get(`${BASE_URL}/api/v1/weighted`)).json()).requests.some((request) => request.phase === 'custom-metrics'),
      { timeout: 30000 }).toBeTruthy();

    const recoveryResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/weighted/pressure') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Reset all pools to idle' }).click();
    await expect((await recoveryResponse).status()).toBe(202);
    await waitForWeights(page, '100/100/100');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(async () => (await (await page.request.get(`${BASE_URL}/api/load/status`)).json()).job.running,
      { timeout: 10000 }).toBeFalsy();
    await expect(page.getByText('STOPPED', { exact: true })).toBeVisible();
  });
});
