import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { EMPTY_FACTS } from '../lib/lifecycle/types';
import { formatDateAr, formatMoney, formatNumber } from '../lib/lifecycle/format';
import {
  FOOTER_LEGAL,
  FOOTER_PREFS_LABEL,
  FOOTER_PREFS_LEAD,
  FOOTER_STOP_LABEL,
  FOOTER_STOP_LEAD,
  FOOTER_WHY,
  WORDMARK,
} from '../lib/messaging/render';
import { renderTemplate } from '../lib/messaging/render';
import { FIXTURE_USER, WEEKLY_FACTS, statCopy, transactionalCopy } from './support/email-fixtures';
import { withEnv } from './support/with-env';

const ROOT = path.resolve(__dirname, '..');

/** Every file of this delivery layer that carries Arabic text a person reads. */
const FILES = [
  'lib/lifecycle/format.ts',
  'lib/messaging/render.ts',
  'lib/messaging/prefs.ts',
  'lib/messaging/links.ts',
  'lib/messaging/templates.ts',
  'lib/messaging/welcome.ts',
  'lib/messaging/opt-out.ts',
  'lib/messaging/send.ts',
  'lib/notifications/email.ts',
  'app/email-preferences/page.tsx',
  'app/api/messages/opt-out/route.ts',
  'app/api/messages/preferences/route.ts',
  'app/api/webhooks/resend/route.ts',
  'app/m/c/route.ts',
];

const ARABIC = /[؀-ۿ]/;
const DASHES = /[—–]/; // em dash, en dash
const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/;
const LATIN_COMMA_IN_ARABIC = /[؀-ۿ]\s*,|,\s*[؀-ۿ]/;

/** Quoted strings and template literals of a TypeScript file (heuristic, line-local for '...' and "..."). */
function stringLiterals(source: string) {
  const found: string[] = [];
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? match[2] ?? match[3] ?? '');
  return found;
}

test('no em dash or en dash anywhere in the delivery files, code, comments and strings alike', () => {
  for (const file of FILES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      assert.doesNotMatch(line, DASHES, `${file}:${index + 1} has a long dash`);
    });
  }
});

test('Arabic strings use the Arabic comma and Latin digits', () => {
  let checked = 0;
  for (const file of FILES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const literal of stringLiterals(source)) {
      if (!ARABIC.test(literal)) continue;
      checked += 1;
      assert.doesNotMatch(literal, LATIN_COMMA_IN_ARABIC, `${file}: Latin comma in "${literal.slice(0, 60)}"`);
      assert.doesNotMatch(literal, ARABIC_INDIC_DIGIT, `${file}: Arabic-Indic digit in "${literal.slice(0, 60)}"`);
    }
  }
  assert.ok(checked > 40, `only ${checked} Arabic strings were found, the scan is probably not reading the files`);
});

test('the fixed footer and wordmark strings are clean', () => {
  const fixed = [
    WORDMARK,
    FOOTER_PREFS_LEAD,
    FOOTER_PREFS_LABEL,
    FOOTER_STOP_LEAD,
    FOOTER_STOP_LABEL,
    FOOTER_LEGAL,
    ...Object.values(FOOTER_WHY),
  ];
  assert.ok(fixed.length >= 8);
  for (const text of fixed) {
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, DASHES, text);
    assert.doesNotMatch(text, LATIN_COMMA_IN_ARABIC, text);
    assert.doesNotMatch(text, ARABIC_INDIC_DIGIT, text);
  }
});

test('everything the renderer produces for the sample copies is clean, in html, text, subject and preheader', () =>
  withEnv({ UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' }, () => {
    const outputs = [
      renderTemplate({ copy: statCopy, templateKey: 'weekly_report', user: FIXTURE_USER, facts: WEEKLY_FACTS }),
      renderTemplate({ copy: transactionalCopy, templateKey: 'tx_payment_failed', user: FIXTURE_USER, facts: { ...EMPTY_FACTS, firstName: 'سارة' } }),
      renderTemplate({ copy: EMAIL_COPY.registered_1d, templateKey: 'registered_1d', user: FIXTURE_USER, facts: { ...EMPTY_FACTS, firstName: 'سارة' } }),
    ];
    for (const out of outputs) {
      assert.ok(out);
      // Visible text only: strip tags and the url-encoded query strings that carry no prose.
      const visible = out.html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
      for (const piece of [visible, out.text, out.subject]) {
        assert.doesNotMatch(piece, DASHES);
        assert.doesNotMatch(piece, ARABIC_INDIC_DIGIT);
        assert.doesNotMatch(piece, LATIN_COMMA_IN_ARABIC);
      }
    }
  }));

test('formatters never produce Arabic-Indic digits, an Arabic percent sign or a long dash', () => {
  const samples = [
    formatNumber(1234567),
    formatNumber(0.5, { decimals: 1 }),
    formatMoney(1250, 'SAR'),
    formatMoney(99.5, 'USD'),
    formatDateAr('2026-10-14T10:00:00Z'),
    formatDateAr('2026-10-14T10:00:00Z', { year: false }),
  ];
  for (const sample of samples) {
    assert.doesNotMatch(sample, ARABIC_INDIC_DIGIT, sample);
    assert.doesNotMatch(sample, DASHES, sample);
    assert.doesNotMatch(sample, /٪|٫|٬/, sample);
  }
});
