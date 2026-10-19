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
