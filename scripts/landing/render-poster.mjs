// Renders the hero still. Usage: node scripts/landing/render-poster.mjs <abs html> <abs png>
import { chromium } from '@playwright/test';

const [, , src, out] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('file://' + src);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
await browser.close();
