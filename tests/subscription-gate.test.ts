import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { accessRefusal, checkProductAccess, hasProductAccess } from '../lib/billing/access-gate';
import { PLAN_LIMITS } from '../lib/billing/entitlements';
import { voiceEntitlement } from '../lib/ai/voice-route-deps';
import { answerWithJarvis } from '../lib/jarvis/turn';

/**
 * The owner rule: nobody costs model or voice money until they at least start
 * the subscription. This file pins the one predicate every gate shares, the
 * entitlement it hands the voice routes, the brain's own lock, and where the
 * gate sits in each route that can spend.
 */

const FUTURE = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

/** Just enough of the Supabase client for getSubscriptionAccess (subscriptions + overrides). */
function database({
  subscriptions = [],
  overrides = [],
  subscriptionsError = null,
}: {
  subscriptions?: Array<Record<string, unknown>>;
  overrides?: Array<Record<string, unknown>>;
  subscriptionsError?: unknown;
}) {
  return {
    from(table: string) {
      const rows = table === 'subscriptions' ? subscriptions : overrides;
      const error = table === 'subscriptions' ? subscriptionsError : null;
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject),
      };
      return chain;
    },
  };
}

function subscriptionRow(overrides: Record<string, unknown>) {
  return {
    plan: 'starter',
    status: 'active',
    trial_ends_at: null,
    current_period_start: PAST,
    current_period_end: FUTURE,
    created_at: PAST,
    ...overrides,
  };
}

async function gate(db: ReturnType<typeof database>, email: string | null = 'customer@example.com') {
  return checkProductAccess({ supabase: db, userId: 'user-1', userEmail: email });
}

function withOperators<T>(emails: string, fn: () => Promise<T>) {
  const saved = process.env.MODAAFA_OPERATOR_EMAILS;
  process.env.MODAAFA_OPERATOR_EMAILS = emails;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.MODAAFA_OPERATOR_EMAILS;
    else process.env.MODAAFA_OPERATOR_EMAILS = saved;
  });
}

// ------------------------------------------------------------------ the predicate

test('hasProductAccess is true only for an active, planned, unsuspended account', () => {
  assert.equal(hasProductAccess({ active: true, plan: 'starter', suspended: false }), true);
  assert.equal(hasProductAccess({ active: true, plan: 'pro' }), true);
  assert.equal(hasProductAccess({ active: false, plan: 'pro', suspended: false }), false);
  assert.equal(hasProductAccess({ active: true, plan: null, suspended: false }), false);
  assert.equal(hasProductAccess({ active: true, plan: 'pro', suspended: true }), false);
});

test('accessRefusal keeps the existing error shapes: 402 subscription_required, 403 account_suspended', () => {
  assert.deepEqual(accessRefusal({ active: true, plan: 'pro' }), null);
  assert.deepEqual(accessRefusal({ active: false, plan: null }), { status: 402, body: { error: 'subscription_required' } });
  const suspended = accessRefusal({ active: true, plan: 'pro', suspended: true });
  assert.equal(suspended?.status, 403);
  assert.equal((suspended?.body as { error: string }).error, 'account_suspended');
});

// ------------------------------------------------------------------ the real access rules under it

test('no subscription row: 402 subscription_required', async () => {
  const result = await gate(database({}));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 402);
  assert.deepEqual(!result.ok && result.body, { error: 'subscription_required' });
});

test('a live trial (card on file, Stripe trialing) passes', async () => {
  const result = await gate(database({ subscriptions: [subscriptionRow({ status: 'trialing', trial_ends_at: FUTURE })] }));
  assert.equal(result.ok, true);
  assert.equal(result.access.status, 'trialing');
});

test('an active subscription passes', async () => {
  const result = await gate(database({ subscriptions: [subscriptionRow({ plan: 'growth', status: 'active' })] }));
  assert.equal(result.ok, true);
});

test('an expired trial, a canceled subscription and an ended period are all 402', async () => {
  for (const row of [
    subscriptionRow({ status: 'trialing', trial_ends_at: PAST }),
    subscriptionRow({ status: 'canceled' }),
    subscriptionRow({ status: 'active', current_period_end: PAST }),
    subscriptionRow({ status: 'incomplete' }),
  ]) {
    const result = await gate(database({ subscriptions: [row] }));
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.equal(!result.ok && result.status, 402, JSON.stringify(row));
  }
});

test('a suspended account is blocked even with an active subscription', async () => {
  const result = await gate(
    database({
      subscriptions: [subscriptionRow({ plan: 'pro', status: 'active' })],
      overrides: [{ kind: 'suspension', plan: null, expires_at: null, created_at: PAST, revoked_at: null }],
    })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 403);
  assert.equal(!result.ok && (result.body as { error: string }).error, 'account_suspended');
});

test('an operator free-plan grant counts as access with no Stripe row at all', async () => {
  const result = await gate(
    database({ overrides: [{ kind: 'plan_grant', plan: 'growth', expires_at: null, created_at: PAST, revoked_at: null }] })
  );
  assert.equal(result.ok, true);
  assert.equal(result.access.status, 'comp');
});

test('an operator passes with no subscription, a non-operator email does not', async () => {
  await withOperators('boss@modaafa.example', async () => {
    const operator = await gate(database({}), 'boss@modaafa.example');
    assert.equal(operator.ok, true);
    assert.equal(operator.access.status, 'internal');
    const other = await gate(database({}), 'someone@example.com');
    assert.equal(other.ok, false);
  });
});

test('a failed read closes the door instead of opening it', async () => {
  const brokenQuery = await gate(database({ subscriptionsError: { message: 'db down' } }));
  assert.equal(brokenQuery.ok, false);
  assert.equal(!brokenQuery.ok && brokenQuery.status, 402);

  const thrown = await checkProductAccess({
    supabase: {},
    userId: 'user-1',
    userEmail: 'x@example.com',
    getAccess: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(!thrown.ok && thrown.status, 402);
});

// ------------------------------------------------------------------ voice entitlement

test('voice has no free tier: no access means a null limit and no tier, access means the plan limit', () => {
  const none = { active: false, plan: null, status: null, suspended: false };
  assert.deepEqual(voiceEntitlement(none), { planAssistantDailyLimit: null, tier: null });
  assert.deepEqual(voiceEntitlement({ active: false, plan: 'pro', status: 'canceled', suspended: false }), { planAssistantDailyLimit: null, tier: null });
  assert.deepEqual(voiceEntitlement({ active: true, plan: 'pro', status: 'active', suspended: true }), { planAssistantDailyLimit: null, tier: null });

  // A trial runs on Starter limits whatever plan it picked.
  assert.deepEqual(voiceEntitlement({ active: true, plan: 'pro', status: 'trialing', suspended: false }), {
    planAssistantDailyLimit: PLAN_LIMITS.starter.assistant.limit,
    tier: 'paid',
  });
  assert.deepEqual(voiceEntitlement({ active: true, plan: 'growth', status: 'active', suspended: false }), {
    planAssistantDailyLimit: PLAN_LIMITS.growth.assistant.limit,
    tier: 'paid',
  });
  assert.deepEqual(voiceEntitlement({ active: true, plan: 'pro', status: 'internal', suspended: false }), {
    planAssistantDailyLimit: PLAN_LIMITS.pro.assistant.limit,
    tier: 'paid',
  });
});

test('voice config has no free-turn allowance left to configure', () => {
  const session = readFileSync('lib/ai/voice-session.ts', 'utf8');
  const route = readFileSync('lib/ai/voice-route-deps.ts', 'utf8');
  const env = readFileSync('.env.example', 'utf8');
  assert.ok(!session.includes('freeDailyTurns') && !session.includes('VOICE_FREE_DAILY_TURNS'));
  assert.ok(!route.includes("'free'"));
  assert.ok(!env.includes('VOICE_FREE_DAILY_TURNS'));
});

// ------------------------------------------------------------------ the brain's own lock

test('answerWithJarvis refuses before any model or database work when the caller has no access', async () => {
  const reads: string[] = [];
  const base = database({});
  const supabase = {
    from(table: string) {
      reads.push(table);
      return base.from(table);
    },
  };
  await assert.rejects(
    () =>
      answerWithJarvis({
        supabase,
        user: { id: 'user-1', email: 'customer@example.com' },
        accountId: 'acc-1',
        state: {
          accountLinked: true,
          accountName: null,
          customerId: '1234567890',
          latestAudit: null,
          recommendations: [],
          subscriptionActive: false,
        } as any,
        message: 'كيف حسابي؟',
        channel: 'text',
        sessionId: null,
      }),
    /subscription_required/
  );
  // Only the two access reads happened: nothing about the business, memory or history.
  assert.deepEqual([...new Set(reads)].sort(), ['account_access_overrides', 'subscriptions']);
});

// ------------------------------------------------------------------ where the gates sit

const read = (path: string) => readFileSync(path, 'utf8');

test('/api/chat/start answers 402 before it reads the body, loads the account or calls any model', () => {
  const route = read('app/api/chat/start/route.ts');
  const post = route.slice(route.indexOf('export async function POST'));
  const gateAt = post.indexOf('checkProductAccess(');
  assert.ok(gateAt > -1, 'POST calls the shared gate');
  assert.ok(post.indexOf('authed(req)') > -1 && post.indexOf('authed(req)') < gateAt, 'sign-in, origin and rate limit come first');
  for (const later of ['req.json()', 'loadChatState(', 'verifyChatVoiceTicket(', 'resolveLanguage(', 'answerWithJarvis(']) {
    const at = post.indexOf(later);
    assert.ok(at > gateAt, `${later} must come after the access gate`);
  }
  assert.match(post, /if \(!gate\.ok\) return NextResponse\.json\(gate\.body, \{ status: gate\.status \}\)/);
  // The history read stays open: it costs no model money.
  assert.ok(route.indexOf('export async function GET') > -1);
});

test('every voice route that reaches a provider goes through the entitlement-aware handlers', () => {
  const expectations: Array<[string, string]> = [
    ['app/api/voice/session/route.ts', 'startVoiceSession'],
    ['app/api/voice/transcribe/route.ts', 'transcribeVoiceTurn'],
    ['app/api/voice/speak/route.ts', 'speakVoiceTurn'],
  ];
  for (const [file, handler] of expectations) {
    const source = read(file);
    assert.ok(source.includes('buildVoiceDeps(req)'), `${file} builds its entitlement from the caller's access`);
    assert.ok(source.includes(`${handler}(deps`), `${file} calls ${handler} with those deps`);
  }
  const server = read('lib/ai/voice-server.ts');
  for (const name of ['startVoiceSession', 'transcribeVoiceTurn', 'speakVoiceTurn']) {
    const body = server.slice(server.indexOf(`export async function ${name}`));
    const closed = body.indexOf("fail(402, 'subscription_required')");
    const provider = body.search(/deps\.provider\./);
    assert.ok(closed > -1, `${name} refuses with 402 when the limit is null`);
    assert.ok(provider === -1 || closed < provider, `${name} refuses before touching the provider`);
  }
});

test('the legacy assistant and builder routes meter before they call a model (402 via consumeFeatureUsage)', () => {
  for (const file of ['app/api/chat/assistant/route.ts', 'app/api/chat/builder/route.ts']) {
    const source = read(file);
    const meter = source.indexOf('consumeFeatureUsage({');
    const model = source.search(/createMessageForAgent\(|messages\.create\(/);
    assert.ok(meter > -1, `${file} meters`);
    assert.ok(model === -1 || meter < model, `${file} meters before the model call`);
    assert.match(source, /featureAccessStatus\(usage\.reason\)/);
  }
});

test('approving or applying a recommendation checks product access before reading or writing anything', () => {
  const handler = read('lib/recommendations/action-handler.ts');
  const gateAt = handler.indexOf('hasProductAccess(subscriptionAccess)');
  assert.ok(gateAt > -1);
  assert.ok(handler.indexOf("intent !== 'dismiss'") > -1 && handler.indexOf("intent !== 'dismiss'") < gateAt);
  assert.ok(handler.indexOf(".from('recommendations')") > gateAt, 'the recommendation row is read after the gate');
});

test('the implicit memory extractor, the one model call after an answer, is behind product access', () => {
  const turn = read('lib/jarvis/turn.ts');
  const extractor = turn.indexOf('extractAndSaveFacts({');
  const guard = turn.lastIndexOf('hasProductAccess(subscription)', extractor);
  assert.ok(extractor > -1 && guard > -1 && extractor - guard < 400, 'the extractor call sits inside a hasProductAccess guard');
});
