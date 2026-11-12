import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deckPath = path.join(moduleDir, 'media/slides/deck.html');
const argIndex = process.argv.indexOf('--output');
const outputDir = path.resolve(argIndex >= 0 && process.argv[argIndex + 1]
  ? process.argv[argIndex + 1]
  : path.join(moduleDir, 'media/generated/slides/1920x1080'));
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(deckPath).href, { waitUntil: 'load' });
  const slides = page.locator('section.slide');
  const count = await slides.count();
  if (count !== 7) throw new Error('Expected six introduction slides and one exit slide; found ' + count);

  const ids = await slides.evaluateAll((items) => items.map((item) => item.getAttribute('data-slide')));
  if (ids.slice(0, 6).join(',') !== '1,2,3,4,5,6' || ids[6] !== 'outro') {
    throw new Error('Deck sections must be data-slide 1–6 followed by data-slide=\"outro\"');
  }
  await page.addStyleTag({
    content: 'html,body{width:1920px!important;height:1080px!important;margin:0!important;padding:0!important;display:block!important;overflow:hidden!important}.slide{position:absolute!important;left:0!important;top:0!important;width:1600px!important;height:900px!important;transform:scale(1.2)!important;transform-origin:top left!important;margin:0!important;box-shadow:none!important}',
  });

  for (let index = 0; index < count; index += 1) {
    await page.evaluate((chosen) => {
      document.querySelectorAll('section.slide').forEach((slide, slideIndex) => {
        slide.style.setProperty('display', slideIndex === chosen ? 'block' : 'none', 'important');
      });
    }, index);
    const name = index === 6 ? 'slide-outro.png' : 'slide-' + String(index + 1).padStart(2, '0') + '.png';
    const target = path.join(outputDir, name);
    await page.screenshot({ path: target, type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    console.log(target);
  }
} finally {
  await browser.close();
}
