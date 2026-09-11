import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18085';
let server;

test.describe('token-rate-limit fixture UI', () => {
  test.beforeAll(async () => {
    const { spawn } = await import('child_process');
    server = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: '18085', JAEGER_URL: 'http://localhost:19999', ALLOW_SIMULATION: 'false', TRACING_UI_TOKEN_RATE_LIMIT: 'true', TRACING_UI_FIXTURE_MODE: 'token-rate-limit' },
      stdio: 'pipe',
    });
    await new Promise(resolve => setTimeout(resolve, 700));
  });

  test.afterAll(() => server?.kill());

  test('shows shared quota, admitted routing, and denied no-hop evidence', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('#token-rate-limit-panel')).toBeVisible();
    await expect(page.locator('#token-rate-limit-source')).toHaveText('SYNTHETIC FIXTURE');
    await expect(page.locator('#token-rate-limit-summary')).toContainText('alice/canonical-model');
    await expect(page.locator('#token-rate-limit-requests')).toContainText('HTTP 429');
    await expect(page.locator('#token-rate-limit-requests')).toContainText('no provider hop');
  });

  test('switches to exhausted state without changing the existing UI shell', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('[data-token-state="exhausted"]').click();
    await expect(page.locator('#token-rate-limit-source')).toHaveText('SYNTHETIC FIXTURE');
    await expect(page.locator('#token-rate-limit-requests')).toContainText('HTTP 429');
    await expect(page.locator('#token-rate-limit-requests')).toContainText('no provider hop');
    await expect(page.locator('#request-explorer')).toBeVisible();
  });
});
