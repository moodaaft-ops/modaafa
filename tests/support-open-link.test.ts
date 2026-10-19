import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportLink } from '../lib/support/open-support';

test('SupportLink renders as the plain WhatsApp link, so the flag off or no script changes nothing', () => {
  const html = renderToStaticMarkup(
    createElement(SupportLink, { href: 'https://wa.me/966500000000?text=hi', className: 'x', support: { faqId: 'a' } }, 'واتساب')
  );
  assert.match(html, /<a href="https:\/\/wa\.me\/966500000000\?text=hi"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(!html.includes('faqId'));
});
