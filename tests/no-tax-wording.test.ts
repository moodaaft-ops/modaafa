import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Owner decision (18 Oct 2026): no tax is added to the plan prices, so public
// pages must not say "before tax" or mention VAT next to the prices.
const PUBLIC_FILES = ['app/page.tsx', 'app/about/page.tsx', 'public/llms.txt', 'lib/seo/site.ts', 'lib/faq/data.ts'];

test('public pages and llms.txt never say prices are before tax', () => {
  for (const file of PUBLIC_FILES) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/قبل\s+(ال)?ضريب/.test(text), `Arabic tax wording in ${file}`);
    assert.ok(!/ضريبة\s+القيمة\s+المضافة/.test(text), `VAT wording in ${file}`);
    assert.ok(!/before\s+(tax|vat)/i.test(text.replace(/Never write "before tax"/g, '')), `English tax wording in ${file}`);
  }
});
