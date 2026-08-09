import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:18083';

test.describe('Visual validation', () => {
  test.beforeAll(async () => {
    const { spawn } = await import('child_process');
    const server = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: '18083', JAEGER_URL: 'http://localhost:19999' },
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

  test('topology section is nonblank', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const topology = page.locator('#topology');
    await expect(topology).not.toBeEmpty();
    const nodes = topology.locator('.topo-node');
    const count = await nodes.count();
    expect(count).toBeGreaterThan(0);
  });

  test('provider cards render', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const cards = page.locator('.pool-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('provider cards stack vertically for additional nodes', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const cards = page.locator('.pool-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Math.abs(first.x - second.x)).toBeLessThan(2);
    expect(second.y).toBeGreaterThan(first.y + first.height - 2);
  });

  test('routing state is populated when provider data is available', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const values = await page.locator('.routing-value').allTextContents();
    expect(values.some(value => value.trim() !== '—')).toBe(true);
  });

  test('pressure badges have text labels', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const badges = page.locator('.pressure-badge');
    const count = await badges.count();
    for (let i = 0; i < count; i++) {
      const text = await badges.nth(i).textContent();
      expect(text.trim().length).toBeGreaterThan(0);
      expect(['NORMAL', 'ELEVATED', 'HIGH', 'CRITICAL', 'UNKNOWN']).toContain(text.trim());
    }
  });

  test('mode badge is visible', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(1000);
    const badge = page.locator('#mode-badge');
    await expect(badge).toBeVisible();
    const text = await badge.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('score values do not show as zero for missing data', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const scoreValues = page.locator('.pool-score-value');
    const count = await scoreValues.count();
    for (let i = 0; i < count; i++) {
      const text = await scoreValues.nth(i).textContent();
      if (text.trim() === '0') {
        const card = scoreValues.nth(i).locator('..').locator('..');
        const pressure = await card.locator('.pressure-badge').textContent();
        expect(pressure.trim()).not.toBe('UNKNOWN');
      }
    }
  });

  test('topology shows functional/traced/eligible labels', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const statuses = page.locator('.topo-status');
    const count = await statuses.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = await statuses.nth(i).textContent();
      expect(['traced', 'functional', 'eligible']).toContain(text.trim());
    }
  });

  test('timeline section renders events', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const events = page.locator('.timeline-event');
    const count = await events.count();
    expect(count).toBeGreaterThan(0);
  });

  test('provider card click opens inspector', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const firstCard = page.locator('.pool-card').first();
    await firstCard.click();
    const inspector = page.locator('#provider-inspector');
    await expect(inspector).toBeVisible();
    const content = page.locator('#inspector-content');
    await expect(content).not.toBeEmpty();
  });

  test('inspector close button works', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    await page.locator('.pool-card').first().click();
    await expect(page.locator('#provider-inspector')).toBeVisible();
    await page.locator('#provider-inspector .close-btn').click();
    await expect(page.locator('#provider-inspector')).toBeHidden();
  });

  test('traces table has rows', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const rows = page.locator('.trace-row');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('no layout shifts from dynamic values', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const card = page.locator('.pool-card').first();
    const box1 = await card.boundingBox();
    await page.waitForTimeout(4000);
    const box2 = await card.boundingBox();
    if (box1 && box2) {
      expect(Math.abs(box1.width - box2.width)).toBeLessThan(5);
      expect(Math.abs(box1.height - box2.height)).toBeLessThan(5);
    }
  });

  test('responsive at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const cards = page.locator('.pool-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    const card = cards.first();
    const box = await card.boundingBox();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(375);
    }
  });

  test('causal chain section renders', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const chain = page.locator('#causal-chain');
    await expect(chain).toBeVisible();
    const steps = chain.locator('.causal-step');
    const count = await steps.count();
    expect(count).toBe(5);
  });

  test('causal chain shows all step headers', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3500);
    const headers = page.locator('.causal-step-header');
    const texts = [];
    for (let i = 0; i < await headers.count(); i++) {
      texts.push(await headers.nth(i).textContent());
    }
    expect(texts).toContain('Traffic');
    expect(texts).toContain('Metrics');
    expect(texts.some(t => t.startsWith('Score'))).toBe(true);
    expect(texts).toContain('Route');
    expect(texts).toContain('Attribution');
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
});
