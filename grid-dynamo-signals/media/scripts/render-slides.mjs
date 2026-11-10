import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deckPath = path.join(moduleDir, 'media/slides/deck.html');
const outputDir = path.resolve(process.argv[2] || path.join(moduleDir, 'media/slides/rendered'));

await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(deckPath).href);
  const slides = page.locator('section.slide');
  const count = await slides.count();
  if (count !== 5) throw new Error('Expected exactly five introduction slides');

  for (let index = 0; index < count; index += 1) {
    await page.addStyleTag({ content: 'html,body{width:1920px;height:1080px;margin:0!important;padding:0!important;display:block!important;overflow:hidden!important}.slide{position:absolute!important;left:0!important;top:0!important;width:1600px!important;height:900px!important;transform:scale(1.2)!important;transform-origin:top left!important;margin:0!important;box-shadow:none!important}' });
    await page.evaluate((chosen) => {
      document.querySelectorAll('section.slide').forEach((slide, index) => {
        slide.style.display = index === chosen ? 'block' : 'none';
      });
    }, index);
    const target = path.join(outputDir, `slide-${String(index + 1).padStart(2, '0')}.png`);
    await slides.nth(index).screenshot({ path: target, animations: 'disabled' });
    console.log(target);
  }
} finally {
  await browser.close();
}
