import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18083';

test.describe('Visual validation', () => {
  test.beforeAll(async () => {
    const { spawn } = await import('child_process');
    const server = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: '18083', JAEGER_URL: 'http://localhost:19999', ALLOW_SIMULATION: 'true' },
      stdio: 'pipe',
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    globalThis.__server = server;
  });

  test.afterAll(async () => {
    if (globalThis.__server) {
      globalThis.__server.kill();
    }
  });

  test('page loads and shows title', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toHaveText('Grid Routing Observability');
  });

  test('request detail contains the selected request flow', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    await page.locator('.request-open').first().click();
    await expect(page.locator('#request-detail')).toBeVisible();
    const nodes = page.locator('.request-flow-node');
    const count = await nodes.count();
    expect(count).toBeGreaterThan(0);
  });


  test('evidence status is visible without mode jargon', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1000);
    const badge = page.locator('#evidence-badge');
    await expect(badge).toBeVisible();
    const text = await badge.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('request detail labels boundary and traced flow nodes', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    await page.locator('.request-open').first().click();
    await expect(page.locator('#request-detail')).toBeVisible();
    await expect(page.locator('.request-flow-node').first()).toBeVisible({ timeout: 5000 });
    const statuses = page.locator('.request-flow-node small');
    const count = await statuses.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = await statuses.nth(i).textContent();
      expect(['traced', 'boundary']).toContain(text.trim());
    }
  });

  test('responsive at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    await expect(page.locator('#request-explorer')).toBeVisible();
    expect(await page.locator('.request-table').count()).toBe(1);
  });

  test('source selector buttons are visible', async ({ page }) => {
    await page.goto(BASE_URL);
    const glbBtn = page.locator('#btn-src-glb');
    const vcrBtn = page.locator('#btn-src-vcr');
    const combinedBtn = page.locator('#btn-src-combined');
    await expect(glbBtn).toBeVisible();
    await expect(vcrBtn).toBeVisible();
    await expect(combinedBtn).toBeVisible();
    await expect(glbBtn).toHaveClass(/active/);
  });

  test('source badge shows GLB by default', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1000);
    const badge = page.locator('#source-badge');
    await expect(badge).toBeVisible();
    const text = await badge.textContent();
    expect(text.trim()).toBe('GLB');
  });

  test('request explorer is the common primary view', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    await expect(page.locator('#request-explorer')).toBeVisible();
    await expect(page.locator('#request-table')).toBeVisible();
    await expect(page.locator('#request-summary-strip')).toContainText('requests in window');
    await expect(page.locator('#generator-start')).toBeVisible();
    await expect(page.locator('#request-detail')).toBeHidden();
  });

  test('primary view stays focused on request paths', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('#request-explorer')).toBeVisible();
    await expect(page.locator('.path-note')).toContainText('Trace one request');
    await expect(page.locator('.pools-section')).toHaveCount(0);
    await expect(page.locator('.causal-section')).toHaveCount(0);
    await expect(page.locator('.scores-section')).toHaveCount(0);
    await expect(page.locator('.timeline-section')).toHaveCount(0);
  });

  test('generation shows a starting transition before running', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1800);
    await page.route('**/generate', async route => {
      if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.locator('#generator-count').fill('1');
    await page.locator('#generator-rate').fill('20');
    await page.locator('#generator-start').click();
    await expect(page.locator('#generator-status')).toHaveText('Starting');
    await expect(page.locator('#generator-progress')).toContainText('Starting request generation');
    await expect(page.locator('#generator-start')).toBeDisabled();
    await page.locator('#generator-cancel').click();
  });

  test('demo generation populates request rows and request detail', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1800);
    await page.locator('#generator-count').fill('3');
    await page.locator('#generator-rate').fill('20');
    await page.locator('#generator-start').click();
    await expect(page.locator('.request-row').first()).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.generated-result')).toHaveCount(3, { timeout: 8000 });
    await expect(page.locator('#generator-results')).toContainText('Generated request results');
    await expect(page.locator('#generator-results')).toContainText(/SIMULATED|LIVE/);
    await expect(page.locator('.generated-result-main').first()).toContainText('→');
    await expect(page.locator('.experience-pill').first()).toContainText(/excellent|good|degraded|poor/);
    await page.locator('.request-open').first().click();
    await expect(page.locator('#request-detail')).toBeVisible();
    await expect(page.locator('#request-detail-content')).toContainText('Why this experience score?');
    await expect(page.locator('#request-detail-content')).toContainText('Replay safe synthetic request');
    await page.locator('#generator-clear').click();
    await expect(page.locator('#generator-results')).toContainText('No generated job results yet');
    await expect(page.locator('.request-row').first()).toBeVisible();
  });

  test('history scrubber changes the visible request window', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1500);
    await page.locator('#generator-count').fill('6');
    await page.locator('#generator-rate').fill('20');
    await page.locator('#generator-start').click();
    await expect(page.locator('.request-row').first()).toBeVisible({ timeout: 8000 });
    const before = await page.locator('.request-row').count();
    await page.locator('#history-scrubber').fill('10');
    const after = await page.locator('.request-row').count();
    expect(after).toBeLessThanOrEqual(before);
    await expect(page.locator('#history-scrubber-label')).toHaveText('Newest 10%');
  });

  test('visual replay can play and step through loaded evidence', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1400);
    await page.locator('#generator-count').fill('4');
    await page.locator('#generator-rate').fill('20');
    await page.locator('#generator-start').click();
    await expect(page.locator('.request-row').first()).toBeVisible({ timeout: 8000 });
    await page.locator('#history-scrubber').fill('40');
    await expect(page.locator('#history-scrubber-label')).toHaveText('Newest 40%');
    await page.locator('#replay-play').click();
    await expect(page.locator('#replay-play')).toHaveText('Pause');
    await page.waitForTimeout(800);
    await page.locator('#replay-play').click();
    await expect(page.locator('#replay-play')).toHaveText('Play');
  });

  test('all four demo scenarios update the visible evidence', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1500);
    for (const scenario of ['baseline', 'pressure', 'recovery', 'degraded']) {
      await page.locator(`.scenario-btn[data-scenario="${scenario}"]`).click();
      await expect(page.locator('.scenario-btn.active')).toHaveAttribute('data-scenario', scenario);
      await expect(page.locator('#request-table')).toBeVisible();
      await expect(page.locator('#request-summary-strip')).toContainText('requests in window');
    }
  });

  test('GLB, llm-d/EPP, and Combined share the same request-first view', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1400);
    for (const source of ['glb', 'vcr', 'combined']) {
      await page.locator(`#btn-src-${source}`).click();
      await expect(page.locator('#request-explorer')).toBeVisible();
      await expect(page.locator('#request-table')).toBeVisible();
      await expect(page.locator('#source-badge')).toHaveText(source === 'glb' ? 'GLB' : source === 'vcr' ? 'llm-d/EPP' : 'COMBINED');
      await expect(page.locator('#evidence-badge')).toHaveText(/SIMULATION ENABLED|LIVE EVIDENCE|UNAVAILABLE/);
    }
  });

  test('request explorer remains usable at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);
    await page.waitForTimeout(1800);
    await expect(page.locator('#request-explorer')).toBeVisible();
    const toolbar = await page.locator('.request-toolbar').boundingBox();
    expect(toolbar).not.toBeNull();
    expect(toolbar.width).toBeLessThanOrEqual(375);
  });
});
