import { after } from 'next/server';
import { createMessageForAgent } from '@/lib/ai/client';
import { probeWriteAccess, type WriteAccess } from '@/lib/ai/execution-preflight';
import { llmBudgetState, type LlmBudgetState } from '@/lib/ai/usage';
import { hasProductAccess } from '@/lib/billing/access-gate';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import type { ChatState } from '@/lib/chat-first/contracts';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import { isModaafaOperator } from '@/lib/platform/operators';
import { createAdminClient } from '@/lib/supabase/server';
import { runJarvisTurn, type JarvisChannel, type JarvisTurnResult } from './brain';
import { loadMemoryFacts } from './db-tools';
import { guardCardLines } from '@/lib/guard/read';
import { extractAndSaveFacts } from './memory-extractor';
import { formatPlaybookResult, loadPlaybookIndex, readPlaybook } from './playbook';
import type { ToolContext } from './tools';

/**
 * Server glue between /api/chat/start and the brain: loads the account, the
 * business, memory, history, playbook index and budget, then runs one turn.
 * Everything account-scoped is read through the caller's RLS client, so a
 * session can only ever see its own business. Throws on model failure; the
 * route then answers with the rule-based planTurn instead.
 */

export type JarvisAnswer =
  | { kind: 'answered'; result: JarvisTurnResult; budget: LlmBudgetState; loadMs: number }
  | { kind: 'budget_exhausted'; budget: LlmBudgetState };

async function loadHistory(supabase: any, sessionId: string | null) {
  if (!sessionId) return [];
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, seq')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(16);
  if (error || !Array.isArray(data)) return [];
  return data
    .reverse()
    .filter((row: any) => row.role === 'user' || row.role === 'assistant')
    .map((row: any) => ({ role: row.role as 'user' | 'assistant', content: String(row.content ?? '') }));
}

const WRITE_PROBE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs work after the response is sent; outside a request (tests, scripts) it just runs detached. */
function runAfter(task: () => Promise<unknown>) {
  const safe = () => task().catch(() => undefined);
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/**
 * write_access arrives with migration 20261012_jarvis_consent_memory. It is
 * read separately so the main account read keeps working before the
 * migration runs; a failed read is simply "unknown".
 */
async function loadWriteAccess(supabase: any, accountId: string) {
  const { data, error } = await supabase
    .from('google_ads_accounts')
    .select('write_access, write_access_checked_at')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return { access: 'unknown' as WriteAccess, checkedAt: null as string | null, available: false };
  const access = ['full', 'read_only'].includes(data.write_access) ? (data.write_access as WriteAccess) : 'unknown';
  return { access, checkedAt: (data.write_access_checked_at as string | null) ?? null, available: true };
}

async function loadConsentPending(supabase: any, accountId: string) {
  // The consent column arrives with migration 20261012_jarvis_consent; before
  // it exists the read errors and the question is simply not asked.
  const { data, error } = await supabase
    .from('autopilot_settings')
    .select('consent')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) return false;
  return !data?.consent?.answer;
}

export async function answerWithJarvis(args: {
  supabase: any;
  user: { id: string; email?: string | null };
  accountId: string | null;
  state: ChatState;
  message: string;
  channel: JarvisChannel;
  sessionId: string | null;
  now?: Date;
}): Promise<JarvisAnswer> {
  const { supabase, user, accountId, state, message, channel, sessionId } = args;
  const now = args.now ?? new Date();
  const isOperator = isModaafaOperator(user.email);
  const loadStartedAt = Date.now();

  const subscription = await getSubscriptionAccess(supabase, user.id, user.email);
  // Closed to anyone without access, whatever called this. /api/chat/start has
  // already refused them; throwing here sends a stray caller to the rule-based
  // answer (planTurn), which costs nothing, before any model or database work.
  if (!hasProductAccess(subscription)) throw new Error('subscription_required');
  const budget = await llmBudgetState({
    userId: user.id,
    // The LLM budget is a share of the plan price; llmBudgetState prices a
    // trial as Starter (effectiveLimitPlan) from the status.
    plan: subscription.plan,
    status: subscription.status,
    subscriptionActive: subscription.active,
    isOperator,
    now,
  });
  if (budget.level === 'exhausted') return { kind: 'budget_exhausted', budget };

  const admin = createAdminClient();
  // Two independent reads, so they wait together instead of one after the other.
  const [accountRes, businessRes] = await Promise.all([
    accountId
      ? supabase
          .from('google_ads_accounts')
          .select('id, business_id, customer_id, customer_name, manager_id, currency_code, time_zone, refresh_token_encrypted')
          .eq('id', accountId)
          .eq('status', 'active')
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('businesses')
      .select('id, name, sector, primary_goal, monthly_budget, target_regions, website')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);
  const accountRow = accountRes.data ?? null;
  const businessRow = businessRes.data ?? null;

  let toolContext: ToolContext | null = null;
  if (accountRow?.refresh_token_encrypted) {
    try {
      const refreshToken = decrypt(accountRow.refresh_token_encrypted);
      const customer = getCustomer(accountRow.customer_id, refreshToken, accountRow.manager_id ?? undefined);
      toolContext = {
        customer,
        accountId: accountRow.id,
        customerId: String(accountRow.customer_id).replace(/\D/g, ''),
        currencyCode: accountRow.currency_code || 'SAR',
        business: businessRow ? { name: businessRow.name ?? null, sector: businessRow.sector ?? null } : null,
        now,
      };
    } catch {
      console.warn('[jarvis] google ads client unavailable for this account');
      toolContext = null;
    }
  }

  const [history, memory, playbook, consentPending, writeAccess, guard] = await Promise.all([
    loadHistory(supabase, sessionId),
    loadMemoryFacts(supabase, businessRow?.id ?? null),
    loadPlaybookIndex(admin),
    accountRow ? loadConsentPending(supabase, accountRow.id) : Promise.resolve(false),
    accountRow ? loadWriteAccess(supabase, accountRow.id) : Promise.resolve(null),
    // [] while GUARD_ENABLED is off for this owner: nothing is read.
    guardCardLines(supabase, accountRow?.id, user.email),
  ]);

  // Weekly validate-only permission probe, after the response, never blocking it.
  const probeCustomer = toolContext?.customer;
  if (
    accountRow &&
    probeCustomer &&
    writeAccess?.available &&
    (!writeAccess.checkedAt || now.getTime() - new Date(writeAccess.checkedAt).getTime() > WRITE_PROBE_EVERY_MS)
  ) {
    runAfter(async () => {
      const access = await probeWriteAccess(probeCustomer);
      await admin
        .from('google_ads_accounts')
        .update({ write_access: access, write_access_checked_at: new Date().toISOString() })
        .eq('id', accountRow.id);
    });
  }

  // Everything up to here is database work the model call waits on; the route logs it as brain_load.
  const loadMs = Date.now() - loadStartedAt;
  const result = await runJarvisTurn({
    message,
    channel,
    history,
    state,
    account: accountRow
      ? {
          id: accountRow.id,
          customerId: String(accountRow.customer_id).replace(/\D/g, ''),
          name: accountRow.customer_name ?? state.accountName ?? null,
          currencyCode: accountRow.currency_code || 'SAR',
          timeZone: accountRow.time_zone ?? null,
          writeAccess: writeAccess?.access ?? 'unknown',
        }
      : null,
    business: businessRow
      ? {
          id: businessRow.id,
          name: businessRow.name ?? null,
          sector: businessRow.sector ?? null,
          primaryGoal: businessRow.primary_goal ?? null,
          monthlyBudget: businessRow.monthly_budget ?? null,
          targetRegions: Array.isArray(businessRow.target_regions) ? businessRow.target_regions : [],
          website: businessRow.website ?? null,
        }
      : null,
    memory,
    guard,
    playbook,
    budgetLevel: budget.level === 'degraded' ? 'degraded' : 'ok',
    userId: user.id,
    sessionId,
    now,
    consentPending,
    deps: {
      callModel: (agent, params, meta) =>
        createMessageForAgent(agent, params, { timeout: channel === 'voice' ? 20_000 : 45_000, maxRetries: 1 }, meta),
      toolContext,
      supabase,
      admin,
      readPlaybook: async (ids) => formatPlaybookResult(await readPlaybook(admin, ids)),
    },
  });
  // Implicit memory: only when the brain did not already save a fact this turn,
  // and only for an account with access. /api/chat/start already refuses anyone
  // without it; this is the second lock on the one background model call that
  // runs after the answer, so it can never be reached from another entry.
  if (
    hasProductAccess(subscription) &&
    businessRow &&
    !result.tools.some((tool) => tool.name === 'save_business_fact')
  ) {
    runAfter(() =>
      extractAndSaveFacts({
        message,
        channel,
        businessId: businessRow.id,
        accountId: accountRow?.id ?? null,
        sessionId,
        userId: user.id,
        admin,
        callModel: (agent, params, meta) => createMessageForAgent(agent, params, { timeout: 20_000, maxRetries: 0 }, meta),
      })
    );
  }
  return { kind: 'answered', result, budget, loadMs };
}
