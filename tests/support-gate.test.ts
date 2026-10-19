import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportWidgetGate } from '../lib/support/support-widget-gate';

test('with the flag off the gate renders nothing, so every WhatsApp button stays as it was', () => {
  const saved = process.env.SUPPORT_BOT_ENABLED;
  try {
    delete process.env.SUPPORT_BOT_ENABLED;
    assert.equal(renderToStaticMarkup(createElement(SupportWidgetGate)), '');
    process.env.SUPPORT_BOT_ENABLED = 'false';
    assert.equal(renderToStaticMarkup(createElement(SupportWidgetGate)), '');
  } finally {
    if (saved === undefined) delete process.env.SUPPORT_BOT_ENABLED;
    else process.env.SUPPORT_BOT_ENABLED = saved;
  }
});

test('the bubble is mounted once in the root layout, not per section', async () => {
  const { readFileSync } = await import('node:fs');
  const root = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const chrome = readFileSync(new URL('../lib/ui/site-chrome.tsx', import.meta.url), 'utf8');
  const dash = readFileSync(new URL('../app/(dashboard)/layout.tsx', import.meta.url), 'utf8');
  assert.match(root, /<SupportWidgetGate \/>/);
  assert.doesNotMatch(chrome, /<SupportWidgetGate/);
  assert.doesNotMatch(dash, /<SupportWidgetGate/);
});

test('the dashboard sidebar help button no longer names WhatsApp', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/(dashboard)/simple-chrome.tsx', import.meta.url), 'utf8');
  assert.match(src, /تحتاج مساعدة؟/);
  assert.doesNotMatch(src, /على الواتساب/);
});
