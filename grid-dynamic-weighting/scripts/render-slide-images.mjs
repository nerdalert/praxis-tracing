import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const output=process.env.OUTPUT_DIR||path.join(root,'media','rendered-slides');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
for(let n=1;n<=7;n+=1){const page=await browser.newPage({viewport:{width:1920,height:1080}});await page.goto(`${pathToFileURL(path.join(root,'slides','deck.html')).href}?slide=${n}`);await page.screenshot({path:path.join(output,`slide-${String(n).padStart(2,'0')}.png`)});await page.close();}
await browser.close();
