// Smoke test: load Google Maps in a real browser, run the published userscript, and
// check that one search produces hubs with places inside their radius.
//
//   npm i -D playwright && npx playwright install chromium
//   node test/smoke.mjs                 # tests ./gmaps-layers.user.js
//   CHROME=/path/to/chrome node test/smoke.mjs   # use an existing Chrome/Chromium
//
// The script is evaluated through the DevTools protocol, which is not subject to the
// page's CSP, so it takes its fetch() path instead of GM_xmlhttpRequest. One run is
// about 30 requests to Maps; don't loop it, or Google starts answering with 429s.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const src = readFileSync(new URL('../gmaps-layers.user.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1040, height: 907 } });
try {
  // a small town with a few Superchargers keeps the run short
  await page.goto('https://www.google.com/maps/@37.0083,-121.5683,14z?hl=en');
  await page.waitForTimeout(3000);
  await page.evaluate(src);
  await page.waitForSelector('.gl-bar');
  await page.evaluate(() => {
    Object.assign(window.__gmLayers.S.cfg, { anchor: 'tesla supercharger', finds: ['coffee'], radius: 0.5,
                                             openWithin: -1, minStars: 0, minReviews: 0 });
    return window.__gmLayers.run();
  });
  const r = await page.evaluate(() => {
    const res = window.__gmLayers.S.res;
    return { hubs: res.hubs.length, near: Object.values(res.near).map((a) => a.length) };
  });
  console.log(JSON.stringify(r));
  if (!r.hubs || !r.near.some((n) => n > 0)) throw new Error('no hubs or no places in range');
  await page.screenshot({ path: 'docs/screenshot.png' });
  console.log('PASS');
} finally {
  await browser.close();
}
