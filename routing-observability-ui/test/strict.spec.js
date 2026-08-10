import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18084';

test.describe('Strict evidence mode', () => {
  test.beforeAll(async () => {
    const { spawn } = await import('child_process');
    const server = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: '18084', JAEGER_URL: 'http://localhost:19999', ALLOW_SIMULATION: 'false' },
      stdio: 'pipe',
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    globalThis.__strictServer = server;
  });

  test.afterAll(async () => {
    globalThis.__strictServer?.kill();
  });

  test('shows unavailable instead of fabricated telemetry', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1800);
    await expect(page.locator('#evidence-badge')).toHaveText('UNAVAILABLE');
    await expect(page.locator('#request-body')).toContainText('No request evidence');
    await expect(page.locator('#request-summary-strip')).toContainText('0');
    await expect(page.locator('.path-note')).toContainText('Trace one request');
  });

  test('keeps controls visible but explains unavailable live generation', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1200);
    await expect(page.locator('#request-generator')).toBeVisible();
    await expect(page.locator('.request-generator-header p')).toContainText('gateway is not reachable');
    await expect(page.locator('#capability-summary')).toContainText('GENERATION UNAVAILABLE');
  });

  test('does not allow switching into simulation', async ({ page }) => {
    await page.goto(BASE_URL);
    const response = await page.request.post(`${BASE_URL}/api/mode`, { data: { mode: 'demo' } });
    expect(response.status()).toBe(403);
    await expect(page.locator('#evidence-badge')).not.toHaveText('SIMULATION ENABLED');
  });

  test('all evidence-dependent APIs report unavailable or empty', async ({ page }) => {
    await page.goto(BASE_URL);
    const [capabilities, requests, providers, timeline, causal] = await Promise.all([
      page.request.get(`${BASE_URL}/api/v1/capabilities`),
      page.request.get(`${BASE_URL}/api/v1/requests?limit=10`),
      page.request.get(`${BASE_URL}/api/providers`),
      page.request.get(`${BASE_URL}/api/timeline`),
      page.request.get(`${BASE_URL}/api/causal`),
    ]);
    expect((await capabilities.json()).environment.mode).toBe('partial');
    expect((await requests.json()).items).toHaveLength(0);
    expect((await providers.json()).mode).toBe('unavailable');
    expect((await timeline.json()).events).toHaveLength(0);
    expect((await causal.json()).mode).toBe('unavailable');
  });

  test('does not permit synthetic replay without explicit simulation', async ({ page }) => {
    await page.goto(BASE_URL);
    const response = await page.request.post(`${BASE_URL}/api/v1/replays`, { data: { request_id: 'not-real' } });
    expect(response.status()).toBe(403);
  });
});
