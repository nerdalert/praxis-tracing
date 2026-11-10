import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(process.env.DEMO_PLAYWRIGHT_EVIDENCE_DIR || path.join(root, 'evidence/playwright'));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 360_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: path.join(evidenceDir, 'results.json') }]],
  outputDir: path.join(evidenceDir, 'test-results'),
  use: {
    baseURL: process.env.DEMO_BASE_URL || 'http://127.0.0.1:4177',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    headless: true,
  },
});
