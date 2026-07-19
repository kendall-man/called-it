import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const outputDir = resolve(process.cwd(), '../../outputs/rumble-logo-social');

const formats = [
  { name: 'rumble-square-1080x1080', width: 1080, height: 1080, fontSize: 190 },
  { name: 'rumble-landscape-1200x628', width: 1200, height: 628, fontSize: 180 },
  { name: 'rumble-wide-1920x1080', width: 1920, height: 1080, fontSize: 260 },
  { name: 'rumble-portrait-1080x1350', width: 1080, height: 1350, fontSize: 190 },
  { name: 'rumble-story-1080x1920', width: 1080, height: 1920, fontSize: 190 },
  { name: 'rumble-header-1500x500', width: 1500, height: 500, fontSize: 170 },
  { name: 'rumble-cover-1584x396', width: 1584, height: 396, fontSize: 150 },
];

const transparentFormats = [
  {
    name: 'rumble-wordmark-light-transparent-2000x500',
    width: 2000,
    height: 500,
    fontSize: 230,
    color: '#eff1f6',
  },
  {
    name: 'rumble-wordmark-dark-transparent-2000x500',
    width: 2000,
    height: 500,
    fontSize: 230,
    color: '#0b0e14',
  },
];

function documentHtml({ color, fontSize, transparent = false }) {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; }
          body {
            display: grid;
            place-items: center;
            overflow: hidden;
            background: ${transparent ? 'transparent' : '#0b0e14'};
            -webkit-font-smoothing: antialiased;
            text-rendering: geometricPrecision;
          }
          .wordmark {
            display: inline-flex;
            align-items: baseline;
            color: ${color};
            font-family: "Avenir Next", "Segoe UI", sans-serif;
            font-size: ${fontSize}px;
            font-weight: 500;
            letter-spacing: 0;
            line-height: 1;
            white-space: nowrap;
          }
          .stop {
            color: #32e875;
            font-weight: 800;
          }
        </style>
      </head>
      <body>
        <div class="wordmark" aria-label="Rumble"><span>Rumble</span><span class="stop">.</span></div>
      </body>
    </html>`;
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();

try {
  for (const format of formats) {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: format.width, height: format.height },
    });
    await page.setContent(documentHtml({ color: '#eff1f6', fontSize: format.fontSize }));
    await page.screenshot({ path: resolve(outputDir, `${format.name}.png`) });
    await page.close();
  }

  for (const format of transparentFormats) {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: format.width, height: format.height },
    });
    await page.setContent(documentHtml({
      color: format.color,
      fontSize: format.fontSize,
      transparent: true,
    }));
    await page.screenshot({
      omitBackground: true,
      path: resolve(outputDir, `${format.name}.png`),
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(outputDir);
