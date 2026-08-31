import http from 'node:http';
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18087';
let server;
let upstream;

test.describe('consumer request controls', () => {
  test.beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const consumer = req.headers.host?.includes('18089') ? 'west' : 'east';
      req.resume();
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-ai-demo-provider-gateway': consumer,
          'x-ai-inference-provider': `llm-d-${consumer}-1`,
        });
        res.end(JSON.stringify({ usage: { total_tokens: 10 } }));
      }, consumer === 'east' ? 800 : 50);
    });
    await Promise.all([
      new Promise(resolve => upstream.listen(18088, '127.0.0.1', resolve)),
      new Promise(resolve => {
        const west = http.createServer(upstream.listeners('request')[0]);
        upstream.west = west;
        west.listen(18089, '127.0.0.1', resolve);
      }),
    ]);
    const { spawn } = await import('node:child_process');
    server = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: '18087',
        TRACING_UI_TOKEN_RATE_LIMIT: 'true',
        TRACING_UI_TOKEN_CONSUMER_A_URL: 'http://127.0.0.1:18088',
        TRACING_UI_TOKEN_CONSUMER_B_URL: 'http://127.0.0.1:18089',
        TRACING_UI_TOKEN_PASSWORD: 'test-password',
      },
      stdio: 'pipe',
    });
    await new Promise(resolve => setTimeout(resolve, 700));
  });

  test.afterAll(async () => {
    server?.kill();
    await Promise.all([
      new Promise(resolve => upstream.close(resolve)),
      new Promise(resolve => upstream.west.close(resolve)),
    ]);
  });

  test('keeps East and West independent and inserts completed rows immediately', async ({ page }) => {
    await page.goto(BASE_URL);
    const east = page.locator('#token-request-a');
    const west = page.locator('#token-request-b');
    await expect(east).toBeEnabled();
    await east.click();
    await expect(east).toBeDisabled();
    await expect(west).toBeEnabled();

    await west.click();
    await expect(west).toBeDisabled();
    await expect(page.locator('#token-rate-limit-requests')).toContainText('llm d west 1');
    await expect(west).toBeEnabled();
    await expect(east).toBeDisabled();

    await expect(page.locator('#token-rate-limit-requests tr')).toHaveCount(2);
    await expect(page.locator('#token-rate-limit-requests')).toContainText('llm d east 1');
    await expect(east).toBeEnabled();
  });
});
