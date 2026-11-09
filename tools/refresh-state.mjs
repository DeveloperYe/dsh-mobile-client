/**
 * Re-capture the access-gate login for the public origin after the DSH upgrade.
 * usage: node tools/refresh-state.mjs
 */
import { chromium } from 'file:///D:/Users/Administrator/Documents/deepseek-harness/work/doyourweb-review/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';

const ROOT = 'D:/Users/Administrator/Documents/deepseek-harness/work/dsh-mobile-lite';
const SERVER = 'http://36.138.189.24:3080';
const STATE = ROOT + '/recon/traffic.storage.json';
const PASSWORD = process.env.DSH_GATE_PASSWORD || 'Haolin@31';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

await page.goto(SERVER + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(800);
console.log('landed on:', page.url(), '| title:', await page.title());

const hasGate = await page.$('#gate-password, input[type=password]');
if (hasGate) {
  await page.fill('#gate-password, input[type=password]', PASSWORD);
  await page.press('#gate-password, input[type=password]', 'Enter');
  await page.waitForTimeout(2500);
  console.log('after login:', page.url());
}
const cookies = await ctx.cookies();
console.log('cookies:', cookies.map((c) => c.name + '@' + c.domain).join(', '));
await ctx.storageState({ path: STATE });
console.log('saved state ->', STATE);
await browser.close();
