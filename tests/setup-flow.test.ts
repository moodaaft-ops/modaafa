import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CITY_OPTIONS,
  SETUP_KEYS,
  answerEffects,
  answerLabel,
  budgetChoices,
  cleanUserText,
  keysAnsweredByProfile,
  missingCoreKeys,
  niceAmount,
  normalizeWebsite,
  parseAmount,
  parseAnswer,
  pendingKeys,
  reactionTo,
  type SetupAnswer,
} from '../lib/setup/questions';
import { firstNameFrom, healthWord, resolveSetupStage } from '../lib/setup/stage';
import { saveSetupAnswer } from '../lib/setup/save';
import { isSimpleExperience } from '../lib/setup/mode';
import { ASSISTANT } from '../lib/assistant/persona';

function ok(key: string, raw: unknown): SetupAnswer {
  const parsed = parseAnswer(key, raw);
  assert.equal(parsed.ok, true, `expected ${key} to parse: ${JSON.stringify(parsed)}`);
  return (parsed as { ok: true; answer: SetupAnswer }).answer;
}

test('the assistant has one name everywhere', () => {
  assert.equal(ASSISTANT.name, 'زياد');
});

test('the simple experience follows CHAT_FIRST_ENTRY exactly', () => {
  assert.equal(isSimpleExperience({}, 'a@b.co'), false);
  assert.equal(isSimpleExperience({ CHAT_FIRST_ENTRY: 'true' }, 'a@b.co'), true);
  assert.equal(isSimpleExperience({ CHAT_FIRST_ENTRY: 'operators', MODAAFA_OPERATOR_EMAILS: 'boss@x.co' }, 'boss@x.co'), true);
  assert.equal(isSimpleExperience({ CHAT_FIRST_ENTRY: 'operators', MODAAFA_OPERATOR_EMAILS: 'boss@x.co' }, 'other@x.co'), false);
  assert.equal(
    isSimpleExperience({ CHAT_FIRST_ENTRY: 'operators', CHAT_FIRST_ALLOWLIST: 'pilot@x.co' }, 'Pilot@X.co'),
    true
  );
  assert.equal(isSimpleExperience({ CHAT_FIRST_ENTRY: 'false' }, 'a@b.co'), false);
});

test('unknown keys and choices are refused', () => {
  assert.deepEqual(parseAnswer('salary', { choice: 'x' }), { ok: false, error: 'invalid_key' });
  assert.deepEqual(parseAnswer('goal', { choice: 'world_domination' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAnswer('type', { choice: 'other', text: ' ' }), { ok: false, error: 'text_required' });
  assert.deepEqual(parseAnswer('regions', { choice: 'cities', cities: [] }), { ok: false, error: 'cities_required' });
  assert.deepEqual(parseAnswer('budget', { amount: -5 }), { ok: false, error: 'invalid_amount' });
  assert.deepEqual(parseAnswer('budget', { amount: '12.5' }), { ok: false, error: 'invalid_amount' });
  assert.deepEqual(parseAnswer('website', { choice: 'url', url: 'javascript:alert(1)' }), { ok: false, error: 'invalid_website' });
  assert.deepEqual(parseAnswer('consent', { choice: 'auto_small' }), { ok: false, error: 'invalid_key' });
});

test('a business type writes a stable sector label and a fact with its setup key', () => {
  const effects = answerEffects(ok('type', { choice: 'ecommerce' }));
  assert.equal(effects.business.sector, 'متجر إلكتروني');
  assert.equal(effects.fact?.data.setup_key, 'type');
  assert.equal(effects.fact?.data.choice, 'ecommerce');
  const other = answerEffects(ok('type', { choice: 'other', text: '  ورشة   سيارات <b> ' }));
  assert.equal(other.business.sector, 'ورشة سيارات b');
});

test('goals map onto the existing primary_goal values', () => {
  assert.equal(answerEffects(ok('goal', { choice: 'online_sales' })).business.primary_goal, 'conversions');
  assert.equal(answerEffects(ok('goal', { choice: 'calls' })).business.primary_goal, 'leads');
  assert.equal(answerEffects(ok('goal', { choice: 'store_visits' })).business.primary_goal, 'leads');
  assert.equal(answerEffects(ok('goal', { choice: 'site_visits' })).business.primary_goal, 'traffic');
  assert.equal(answerEffects(ok('goal', { choice: 'awareness' })).business.primary_goal, 'awareness');
});

test('customer value is a margin fact with its range, not a column', () => {
  const effects = answerEffects(ok('value', { choice: '100_500' }));
  assert.deepEqual(effects.business, {});
  assert.equal(effects.fact?.kind, 'margin');
  assert.equal(effects.fact?.data.min_sar, 100);
  assert.equal(effects.fact?.data.max_sar, 500);
});

test('budget accepts Arabic digits and separators, and "ما أدري" changes no column', () => {
  assert.equal(parseAmount('٥٬٠٠٠'.replace('٬', ',')), 5000);
  assert.equal(parseAmount('12,000'), 12000);
  assert.equal(parseAmount(''), null);
  const set = answerEffects(ok('budget', { amount: '7500' }));
  assert.equal(set.business.monthly_budget, 7500);
  assert.match(set.fact?.fact_ar ?? '', /7,500/);
  const unknown = answerEffects(ok('budget', { amount: null }));
  assert.deepEqual(unknown.business, {});
});

test('regions keep known cities, cap custom ones and clean them', () => {
  const answer = ok('regions', {
    choice: 'cities',
    cities: ['الرياض', 'الرياض', 'جدة', 'بريدة<script>', 'a', 'نجران', 'ينبع', 'العلا', 'ضباء'],
  });
  assert.equal(answer.key, 'regions');
  if (answer.key !== 'regions') return;
  assert.deepEqual(answer.cities, ['الرياض', 'جدة', 'بريدةscript', 'نجران', 'ينبع']);
  assert.deepEqual(answerEffects(ok('regions', { choice: 'saudi' })).business.target_regions, ['السعودية']);
  assert.ok((CITY_OPTIONS as readonly string[]).includes('الرياض'));
});

test('websites are normalised and only http(s) hosts with a dot pass', () => {
  assert.equal(normalizeWebsite('mystore.com'), 'https://mystore.com');
  assert.equal(normalizeWebsite('https://www.mystore.com/'), 'https://www.mystore.com');
  assert.equal(normalizeWebsite('mystore'), null);
  assert.equal(normalizeWebsite('ftp://x.com'), null);
  assert.equal(normalizeWebsite('https://user:pass@x.com'), null);
  const effects = answerEffects(ok('website', { choice: 'url', url: 'salla.sa/mystore' }));
  assert.equal(effects.business.website, 'https://salla.sa/mystore');
  assert.deepEqual(answerEffects(ok('website', { choice: 'none' })).business, {});
});

test('free text is cleaned of control and bidi characters', () => {
  assert.equal(cleanUserText('a‮b\u0000c   d', 20), 'a b c d');
  assert.equal(cleanUserText('x'.repeat(50), 10), 'x'.repeat(10));
});

test('budget choices are built around the real 30-day spend in riyals', () => {
  const around = budgetChoices(4320, 'SAR');
  assert.equal(around[0].amount, 4300);
  assert.equal(around[1].amount, 3000);
  assert.equal(around[2].amount, 6500);
  assert.equal(around.at(-1)?.amount, null);
  // Another currency or no spend falls back to bands.
  assert.equal(budgetChoices(4320, 'USD')[0].id, 'b1');
  assert.equal(budgetChoices(null, 'SAR')[0].id, 'b1');
  assert.equal(budgetChoices(120, 'SAR')[0].id, 'b1');
  assert.equal(niceAmount(870), 850);
  assert.equal(niceAmount(12_480), 12_000);
});

test('the old six-field form answers its own questions; a callback business answers none', () => {
  assert.deepEqual(keysAnsweredByProfile({ name: 'ahmed', sector: null, monthly_budget: null, target_regions: [] }), []);
  assert.deepEqual(
    keysAnsweredByProfile({ name: 'متجر', sector: 'ecommerce', monthly_budget: 5000, target_regions: ['الرياض'], website: 'https://x.com' }).sort(),
    ['budget', 'goal', 'name', 'regions', 'type', 'website'].sort()
  );
});

test('pending questions keep the conversation order and consent is asked once', () => {
  assert.deepEqual(pendingKeys({ answered: [], consentAnswered: false }), [...SETUP_KEYS]);
  assert.deepEqual(pendingKeys({ answered: ['type', 'name', 'goal'], consentAnswered: true }), [
    'value',
    'budget',
    'regions',
    'manager',
    'pain',
    'website',
  ]);
  // Edit mode asks every question again but never repeats an answered permission question.
  assert.equal(pendingKeys({ answered: SETUP_KEYS, consentAnswered: true, edit: true }).includes('consent'), false);
  assert.equal(pendingKeys({ answered: SETUP_KEYS, consentAnswered: true, edit: true }).length, SETUP_KEYS.length - 1);
  assert.deepEqual(missingCoreKeys(['type', 'goal']), ['value', 'budget']);
});

test('the stage follows real rows in a fixed order', () => {
  const base = { linkedAccounts: 1, connectRunning: false, needsChoice: false, pending: [] as any[], auditExists: true, edit: false };
  assert.equal(resolveSetupStage({ ...base, connectRunning: true }), 'connecting');
  assert.equal(resolveSetupStage({ ...base, linkedAccounts: 0 }), 'connect');
  assert.equal(resolveSetupStage({ ...base, needsChoice: true }), 'choose');
  assert.equal(resolveSetupStage({ ...base, pending: ['goal'] }), 'questions');
  assert.equal(resolveSetupStage({ ...base, auditExists: false }), 'finishing');
  assert.equal(resolveSetupStage(base), 'done');
  // Editing the profile never runs an audit.
  assert.equal(resolveSetupStage({ ...base, auditExists: false, edit: true }), 'done');
});

test('labels, reactions and small helpers', () => {
  assert.equal(answerLabel(ok('budget', { amount: 6000 })), '6,000 ريال بالشهر');
  assert.equal(answerLabel(ok('website', { choice: 'later' })), 'بكتبه بعدين');
  assert.ok(reactionTo(ok('pain', { choice: 'few_leads' })));
  assert.equal(reactionTo(ok('type', { choice: 'clinic' })), null);
  assert.equal(healthWord(90), 'ممتاز');
  assert.equal(healthWord(40), 'فيه تسريب واضح');
  assert.equal(healthWord(null), null);
  assert.equal(firstNameFrom({ full_name: 'Ayman Amin' }), 'Ayman');
  assert.equal(firstNameFrom({ given_name: 'أيمن' }), 'أيمن');
  assert.equal(firstNameFrom({}), null);
});

function stubClients() {
  const calls: Array<{ client: string; table: string; op: string; payload?: any; filters: Array<[string, unknown]> }> = [];
  const make = (client: string, fail: { update?: boolean; insert?: boolean } = {}) => ({
    from(table: string) {
      const call = { client, table, op: '', payload: undefined as any, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const chain: any = {
        update(payload: any) {
          call.op = 'update';
          call.payload = payload;
          return chain;
        },
        insert(payload: any) {
          call.op = 'insert';
          call.payload = payload;
          return Promise.resolve({ error: fail.insert ? { message: 'x' } : null });
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        then(resolve: (v: any) => void) {
          resolve({ error: call.op === 'update' && fail.update ? { message: 'x' } : null });
        },
      };
      return chain;
    },
  });
  return { calls, make };
}

test('saving an answer writes the column scoped to the owner, then supersedes and inserts the fact', async () => {
  const { calls, make } = stubClients();
  const outcome = await saveSetupAnswer({
    supabase: make('rls'),
    admin: make('admin'),
    userId: 'u1',
    businessId: 'b1',
    accountId: 'a1',
    answer: ok('goal', { choice: 'calls' }),
  });
  assert.deepEqual(outcome, {
    ok: true,
    label: 'يتصلون أو يراسلوني واتساب',
    reaction: 'تمام، كل ريال بحسبه على الاتصالات والواتساب اللي يجيبها.',
    memorySaved: true,
  });
  const [column, supersede, insert] = calls;
  assert.equal(column.client, 'rls');
  assert.equal(column.payload.primary_goal, 'leads');
  assert.deepEqual(column.filters, [
    ['id', 'b1'],
    ['user_id', 'u1'],
  ]);
  assert.equal(supersede.client, 'admin');
  assert.ok(supersede.filters.some(([c, v]) => c === 'data->>setup_key' && v === 'goal'));
  assert.ok(supersede.filters.some(([c, v]) => c === 'business_id' && v === 'b1'));
  assert.equal(insert.payload.source, 'onboarding');
  assert.equal(insert.payload.basis, 'stated');
  assert.equal(insert.payload.data.setup_key, 'goal');
});

test('a failed column write fails the answer; a failed memory write does not', async () => {
  const failing = stubClients();
  const failed = await saveSetupAnswer({
    supabase: failing.make('rls', { update: true }),
    admin: failing.make('admin'),
    userId: 'u1',
    businessId: 'b1',
    accountId: null,
    answer: ok('type', { choice: 'clinic' }),
  });
  assert.deepEqual(failed, { ok: false, error: 'save_failed' });

  const memoryDown = stubClients();
  const kept = await saveSetupAnswer({
    supabase: memoryDown.make('rls'),
    admin: memoryDown.make('admin', { insert: true }),
    userId: 'u1',
    businessId: 'b1',
    accountId: null,
    answer: ok('type', { choice: 'clinic' }),
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.ok && kept.memorySaved, false);

  const noAdmin = await saveSetupAnswer({
    supabase: stubClients().make('rls'),
    admin: null,
    userId: 'u1',
    businessId: 'b1',
    accountId: null,
    answer: ok('manager', { choice: 'self' }),
  });
  assert.equal(noAdmin.ok, true);
});
