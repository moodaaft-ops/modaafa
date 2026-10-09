import assert from 'node:assert/strict';
import test from 'node:test';

import { runConnectJob, startConnectJob, type ConnectJobDeps } from '../lib/onboarding/connect-job';
import { pickSelectedAdsAccount } from '../lib/accounts/selection';
import { encodeGoogleAdsOAuthStates } from '../lib/auth/google-ads-oauth-state';
import { validateGoogleAdsOAuthState } from '../lib/auth/oauth-state-validation';

/**
 * In-memory stand-in for the database. The RPC bodies mirror the SQL in
 * db/migrations/20261009_connect_job_fencing.sql (the SQL itself was exercised
 * against a real Postgres with concurrent sessions). JS is single threaded, so
 * interleavings are forced with explicit gates instead of timers.
 */
function makeDb(userId = 'u1', businessId = 'b1') {
  const jobs = new Map<string, any>();
  const accounts = new Map<string, any>();
  const business = { id: businessId, user_id: userId, selected_google_ads_customer_id: null as string | null };
  let seq = 0;
  const live = (jobId: string, uid: string) => {
    const j = jobs.get(jobId);
    return Boolean(j && j.user_id === uid && j.status === 'running');
  };
  const rpc = async (name: string, a: any) => {
    if (name === 'connect_job_start') {
      const at = a.p_consent_at as string | null;
      const mine = [...jobs.values()].filter((j) => j.user_id === a.p_user_id);
      if (at) {
        if (mine.some((j) => j.details.consent_at && j.details.consent_at > at)) {
          return { data: { status: 'stale' }, error: null };
        }
      } else if (mine.some((j) => Date.now() - j.startedAtMs < 60 * 60 * 1000)) {
        return { data: { status: 'untrusted_time' }, error: null };
      }
      for (const j of mine) {
        if (j.status === 'running') {
          j.status = 'failed';
          j.error_message = 'superseded: a newer Google Ads consent started';
        }
      }
      const id = `job${++seq}`;
      jobs.set(id, { id, user_id: a.p_user_id, status: 'running', startedAtMs: Date.now(), details: { stage: 'discover', consent_at: at ?? null } });
      return { data: { status: 'started', id }, error: null };
    }
    if (name === 'connect_job_link') {
      if (!live(a.p_job_id, a.p_user_id)) return { data: { status: 'superseded' }, error: null };
      if (a.p_business_id !== business.id || a.p_user_id !== business.user_id) {
        return { data: { status: 'forbidden' }, error: null };
      }
      const rows = a.p_rows.map((r: any) => {
        const key = `${r.business_id}:${r.customer_id}`;
        const prev = accounts.get(key);
        const row = { ...r, id: prev?.id ?? `acc${++seq}` };
        accounts.set(key, row);
        return { id: row.id, customer_id: row.customer_id, manager_id: row.manager_id ?? null, currency_code: row.currency_code ?? null };
      });
      return { data: { status: 'linked', rows }, error: null };
    }
    if (name === 'connect_job_select_account') {
      if (!live(a.p_job_id, a.p_user_id)) return { data: 'superseded', error: null };
      if (business.selected_google_ads_customer_id === null) {
        business.selected_google_ads_customer_id = a.p_customer_id;
        return { data: 'selected', error: null };
      }
      return { data: 'kept', error: null };
    }
    if (name === 'connect_job_set_manager') {
      if (!live(a.p_job_id, a.p_user_id)) return { data: 'superseded', error: null };
      for (const r of accounts.values()) if (r.id === a.p_account_id) r.manager_id = a.p_manager_id;
      return { data: 'updated', error: null };
    }
    return { data: null, error: { code: 'unknown_rpc' } };
  };
  const from = (table: string) => {
    const state: any = { table, patch: null as any, filters: [] as Array<[string, any]> };
    const builder: any = {
      update(patch: any) { state.patch = patch; return builder; },
      select() { return builder; },
      eq(col: string, val: any) { state.filters.push([col, val]); return builder; },
      order() { return builder; },
      range() { return builder; },
      then(resolve: any, reject: any) {
        try {
          if (table === 'job_runs' && state.patch) {
            const hit = [...jobs.values()].filter((j) => state.filters.every(([c, v]: any) => j[c] === v));
            hit.forEach((j) => Object.assign(j, state.patch));
            return resolve({ data: hit.map((j) => ({ id: j.id })), error: null });
          }
          if (table === 'google_ads_accounts') {
            const bid = state.filters.find(([c]: any) => c === 'business_id')?.[1];
            const data = [...accounts.values()].filter((r) => r.business_id === bid);
            return resolve({ data, error: null });
          }
          return resolve({ data: [], error: null });
        } catch (e) { return reject(e); }
      },
    };
    return builder;
  };
  return { admin: { rpc, from }, jobs, accounts, business };
}

const ACCOUNT = {
  customer_id: '1234567890',
  customer_name: 'حساب تجريبي',
  currency_code: 'SAR',
  time_zone: 'Asia/Riyadh',
  is_manager: false,
  manager_id: null,
};

const T1 = '2026-10-09T00:00:00.000Z';
const T2 = '2026-10-09T00:05:00.000Z';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

function deps(over: Partial<ConnectJobDeps> & { accounts?: any[] } = {}): ConnectJobDeps {
  return {
    discover: (async () => over.accounts ?? [ACCOUNT]) as any,
    syncCache: (async () => ({ loginCustomerId: null })) as any,
    readSpend: async () => ({}),
    ...over,
  };
}

async function launch(db: ReturnType<typeof makeDb>, token: string, d: ConnectJobDeps, consentAt?: string) {
  const started = await startConnectJob(db.admin, 'u1', consentAt);
  assert.equal(started.ok, true);
  const job = started as Extract<typeof started, { ok: true }>;
  const done = runConnectJob({
    admin: db.admin, job, userId: 'u1',
    business: { id: 'b1', selected_google_ads_customer_id: null },
    refreshToken: `plain-${token}`, encryptedRefreshToken: `enc-${token}`, deps: d,
  });
  return { job, done };
}

const tokenOf = (db: ReturnType<typeof makeDb>) => [...db.accounts.values()][0]?.refresh_token_encrypted ?? null;

test('an older job that wakes up after a newer consent writes nothing and is never restored to success', async () => {
  const db = makeDb();
  const hold = gate();
  const a = await launch(db, 'OLD', deps({ discover: (async () => { await hold.promise; return [ACCOUNT]; }) as any }), T1);
  const b = await launch(db, 'NEW', deps(), T2);
  await b.done;
  assert.equal(tokenOf(db), 'enc-NEW');
  assert.equal(db.business.selected_google_ads_customer_id, '1234567890');

  hold.open();
  await a.done;
  assert.equal(tokenOf(db), 'enc-NEW', 'old token must never land');
  assert.equal(db.jobs.get(a.job.id).status, 'failed', 'superseded job stays failed');
  assert.equal(db.jobs.get(b.job.id).status, 'success');
});

test('an older job that already linked cannot select, set a manager or finish after being superseded', async () => {
  const db = makeDb();
  const hold = gate();
  const a = await launch(db, 'OLD', deps({
    syncCache: (async () => { await hold.promise; return { loginCustomerId: '999' }; }) as any,
  }), T1);
  // let A reach the sync stage (it has linked and auto-selected by then)
  await new Promise((r) => setImmediate(r));
  assert.equal(tokenOf(db), 'enc-OLD');
  db.business.selected_google_ads_customer_id = null;

  const b = await launch(db, 'NEW', deps(), T2);
  await b.done;
  const selectedByNew = db.business.selected_google_ads_customer_id;
  const managerBefore = [...db.accounts.values()][0].manager_id;

  hold.open();
  await a.done;
  assert.equal(tokenOf(db), 'enc-NEW');
  assert.equal(db.business.selected_google_ads_customer_id, selectedByNew);
  assert.equal([...db.accounts.values()][0].manager_id, managerBefore, 'old job cannot overwrite manager_id');
  assert.equal(db.jobs.get(a.job.id).status, 'failed');
  assert.equal(db.jobs.get(b.job.id).status, 'success');
});

test('a job closed by the timeout sweep is not resurrected as success', async () => {
  const db = makeDb();
  const hold = gate();
  const a = await launch(db, 'SLOW', deps({ discover: (async () => { await hold.promise; return [ACCOUNT]; }) as any }));
  const row = db.jobs.get(a.job.id);
  row.status = 'failed';
  row.error_message = 'timeout';
  hold.open();
  await a.done;
  assert.equal(row.status, 'failed');
  assert.equal(row.error_message, 'timeout');
  assert.equal(tokenOf(db), null);
});

test('the user choice made on the chooser is kept by a later job', async () => {
  const db = makeDb();
  db.business.selected_google_ads_customer_id = '5550001111';
  const a = await launch(db, 'T', deps());
  await a.done;
  assert.equal(db.business.selected_google_ads_customer_id, '5550001111');
  assert.equal(db.jobs.get(a.job.id).status, 'success');
});

test('two accounts: nothing is preselected and the job still succeeds', async () => {
  const db = makeDb();
  const second = { ...ACCOUNT, customer_id: '9876543210', customer_name: 'حساب ثاني' };
  const a = await launch(db, 'T', deps({ accounts: [ACCOUNT, second] }));
  await a.done;
  assert.equal(db.business.selected_google_ads_customer_id, null);
  assert.equal(db.jobs.get(a.job.id).details.next !== undefined, true);
});

test('empty discovery and a database error end as clear failures, with no token in any log', async () => {
  const logs: string[] = [];
  const orig = { w: console.warn, e: console.error };
  console.warn = (...x: unknown[]) => logs.push(JSON.stringify(x));
  console.error = (...x: unknown[]) => logs.push(JSON.stringify(x));
  try {
    const empty = makeDb();
    const e = await launch(empty, 'SECRETTOKEN', deps({ accounts: [] }));
    await e.done;
    assert.equal(empty.jobs.get(e.job.id).details.error, 'no_accounts');

    const broken = makeDb();
    const realRpc = broken.admin.rpc;
    broken.admin.rpc = async (name: string, a: any) =>
      name === 'connect_job_link' ? { data: null, error: { code: '57014' } } : realRpc(name, a);
    const b = await launch(broken, 'SECRETTOKEN', deps());
    await b.done;
    assert.equal(broken.jobs.get(b.job.id).details.error, 'db_error');
    assert.equal(tokenOf(broken), null);
  } finally {
    console.warn = orig.w;
    console.error = orig.e;
  }
  assert.equal(logs.some((l) => l.includes('SECRETTOKEN')), false);
});

test('start fails loudly when the database refuses to open the job', async () => {
  const admin = { rpc: async () => ({ data: null, error: { code: '42501' } }) };
  await assert.rejects(() => startConnectJob(admin, 'u1'), /Failed to record Google Ads connect job/);
});

test('selected account cookie: existing user keeps the cookie choice, new user falls back to the stored one', () => {
  const accounts = [{ customer_id: '1111111111' }, { customer_id: '2222222222' }];
  assert.equal(pickSelectedAdsAccount(accounts, '2222222222', '1111111111')?.customer_id, '2222222222');
  assert.equal(pickSelectedAdsAccount(accounts, '', '2222222222')?.customer_id, '2222222222');
  assert.equal(pickSelectedAdsAccount(accounts, null, null)?.customer_id, '1111111111');
  assert.equal(pickSelectedAdsAccount(accounts, '9999999999', '2222222222')?.customer_id, '2222222222');
});

test('OAuth state: replay, wrong user and storage failure without a cookie are all rejected', () => {
  const cookieValue = encodeGoogleAdsOAuthStates(['state-a']);
  const replay = validateGoogleAdsOAuthState({ serverResult: 'not_found', cookieValue, returnedState: 'state-a' });
  assert.deepEqual(replay, { accepted: false, error: 'state_mismatch' });
  const wrongUser = validateGoogleAdsOAuthState({ serverResult: 'user_mismatch', cookieValue, returnedState: 'state-a' });
  assert.deepEqual(wrongUser, { accepted: false, error: 'state_user_mismatch' });
  const noCookie = validateGoogleAdsOAuthState({ serverResult: 'unavailable', cookieValue: undefined, returnedState: 'state-a' });
  assert.equal(noCookie.accepted, false);
  const wrongState = validateGoogleAdsOAuthState({ serverResult: 'unavailable', cookieValue, returnedState: 'state-b' });
  assert.equal(wrongState.accepted, false);
});

test('a callback that reaches the server late for an OLDER consent is refused and writes nothing', async () => {
  const db = makeDb();
  const older = '2026-10-09T00:00:00.000Z';
  const newer = '2026-10-09T00:05:00.000Z';
  // The newer consent finishes first (its callback arrived first).
  const b = await launch(db, 'NEW', deps(), newer);
  await b.done;
  assert.equal(tokenOf(db), 'enc-NEW');
  // The older consent's callback arrives afterwards: it must not even open a job.
  const jobsBefore = db.jobs.size;
  const late = await startConnectJob(db.admin, 'u1', older);
  assert.deepEqual(late, { ok: false, reason: 'stale' });
  assert.equal(db.jobs.size, jobsBefore);
  assert.equal(db.jobs.get(b.job.id).status, 'success', 'the newer job is not superseded by the late one');
  assert.equal(tokenOf(db), 'enc-NEW');
});

test('a late older callback also loses while the newer job is still running', async () => {
  const db = makeDb();
  const hold = gate();
  const b = await launch(db, 'NEW', deps({ discover: (async () => { await hold.promise; return [ACCOUNT]; }) as any }), '2026-10-09T00:05:00.000Z');
  const late = await startConnectJob(db.admin, 'u1', '2026-10-09T00:00:00.000Z');
  assert.deepEqual(late, { ok: false, reason: 'stale' });
  hold.open();
  await b.done;
  assert.equal(db.jobs.get(b.job.id).status, 'success');
  assert.equal(tokenOf(db), 'enc-NEW');
});

test('without a trusted consent time the start fails closed when a recent job exists', async () => {
  const db = makeDb();
  const first = await launch(db, 'FIRST', deps());
  await first.done;
  const second = await startConnectJob(db.admin, 'u1', null);
  assert.deepEqual(second, { ok: false, reason: 'untrusted_time' });
  assert.equal(db.jobs.size, 1, 'no job is opened');
  assert.equal(tokenOf(db), 'enc-FIRST', 'the existing link is untouched');
  assert.equal(db.jobs.get(first.job.id).status, 'success');
});

test('without a trusted consent time a first connect, or one after the state lifetime, still works', async () => {
  const db = makeDb();
  const first = await launch(db, 'FIRST', deps());
  await first.done;
  db.jobs.get(first.job.id).startedAtMs = Date.now() - 61 * 60 * 1000;
  const again = await startConnectJob(db.admin, 'u1', null);
  assert.equal(again.ok, true);
});

test('a trusted consent time still wins over an untrusted earlier job', async () => {
  const db = makeDb();
  const first = await launch(db, 'FIRST', deps());
  await first.done;
  const next = await launch(db, 'SECOND', deps(), '2026-10-09T01:00:00.000Z');
  await next.done;
  assert.equal(tokenOf(db), 'enc-SECOND');
});
