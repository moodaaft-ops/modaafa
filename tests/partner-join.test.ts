import assert from 'node:assert/strict';
import test from 'node:test';

import { candidateCodes, cleanPhone, joinPartnerProgram, slugFromEmail } from '../lib/partners/join';

type Row = { id: string; user_id: string | null; code: string; email: string; [k: string]: unknown };

/** A tiny in-memory partners table that enforces the same unique keys as the real one. */
function fakeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let n = 0;
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return builder; },
      is: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return builder; },
      maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
      insert: async (row: Row) => {
        if (table !== 'partners') throw new Error('unexpected table');
        if (rows.some((r) => r.code === row.code || r.email === row.email || (row.user_id && r.user_id === row.user_id))) {
          return { error: { code: '23505' } };
        }
        rows.push({ ...row, id: `p${++n}` });
        return { error: null };
      },
    };
    return builder;
  };
  return { rows, db: { from: query } };
}

const base = { displayName: 'Sara', phone: '+966 55 123 4567', acceptTerms: true };
const user = { id: 'u1', email: 'Sara.Ahmed@Example.com' };

test('join: creates an active partner linked to the account, code from the email', async () => {
  const { rows, db } = fakeDb();
  const r = await joinPartnerProgram(db, user, base);
  assert.deepEqual(r, { ok: true, created: true, code: 'sara-ahmed' });
  assert.equal(rows[0].user_id, 'u1');
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].email, 'sara.ahmed@example.com');
  assert.equal(rows[0].phone, '+966551234567');
  assert.equal(rows[0].commission_rate, undefined, 'a self-serve partner never carries a custom rate');
});

test('join: a second call returns the same partner and adds nothing', async () => {
  const { rows, db } = fakeDb();
  await joinPartnerProgram(db, user, base);
  const again = await joinPartnerProgram(db, user, base);
  assert.deepEqual(again, { ok: true, created: false, code: 'sara-ahmed' });
  assert.equal(rows.length, 1);
});

test('join: terms, name and phone are required', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await joinPartnerProgram(db, user, { ...base, acceptTerms: false }), { ok: false, error: 'terms_required' });
  assert.deepEqual(await joinPartnerProgram(db, user, { ...base, acceptTerms: 'true' }), { ok: false, error: 'terms_required' });
  assert.deepEqual(await joinPartnerProgram(db, user, { ...base, displayName: ' x ' }), { ok: false, error: 'bad_name' });
  assert.deepEqual(await joinPartnerProgram(db, user, { ...base, phone: '123' }), { ok: false, error: 'bad_phone' });
  assert.deepEqual(await joinPartnerProgram(db, { id: 'u1', email: null }, base), { ok: false, error: 'email_required' });
});

test('join: a taken auto code gets a random tail, a taken chosen code is refused', async () => {
  const { rows, db } = fakeDb([{ id: 'x', user_id: 'other', code: 'sara-ahmed', email: 'o@x.co' }]);
  const auto = await joinPartnerProgram(db, user, base, () => 0.5);
  assert.equal(auto.ok, true);
  assert.match((auto as { code: string }).code, /^sara-ahmed-[a-z0-9]{4}$/);
  assert.equal(rows.length, 2);
  const mine = fakeDb([{ id: 'x', user_id: 'other', code: 'sara', email: 'o@x.co' }]);
  assert.deepEqual(await joinPartnerProgram(mine.db, user, { ...base, code: 'Sara' }), { ok: false, error: 'code_taken' });
});

test('join: our own name and look-alike official words cannot be a code', async () => {
  const { db } = fakeDb();
  for (const code of ['modaafa', 'mudaafa-team', 'official-ads', 'ads-support', 'admin1']) {
    assert.deepEqual(await joinPartnerProgram(db, user, { ...base, code }), { ok: false, error: 'reserved_code' }, code);
  }
  assert.deepEqual(await joinPartnerProgram(db, user, { ...base, code: 'سارة' }), { ok: false, error: 'bad_code' });
  // An email that would give a reserved code falls back to a neutral one.
  const codes = candidateCodes('modaafa.ali@x.co', () => 0.1);
  assert.ok(codes.every((c) => !/modaafa/.test(c)), codes.join());
});

test('join: an email already held by another account is refused', async () => {
  const taken = fakeDb([{ id: 'x', user_id: 'other', code: 'zed', email: 'sara.ahmed@example.com' }]);
  assert.deepEqual(await joinPartnerProgram(taken.db, user, base), { ok: false, error: 'email_taken' });
});

test('helpers: phone and slug shapes', () => {
  assert.equal(cleanPhone('0551234567'), '0551234567');
  assert.equal(cleanPhone('+966 (55) 123-4567'), '+966551234567');
  for (const bad of ['', '12', 'abc', '+966 55 12', 42, null]) assert.equal(cleanPhone(bad), null, String(bad));
  assert.equal(slugFromEmail('Sara.Ahmed+x@e.co'), 'sara-ahmed-x');
  assert.equal(slugFromEmail('ab@e.co'), '');
});
