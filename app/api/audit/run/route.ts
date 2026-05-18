import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getCustomer } from '@/lib/google-ads/client';
import { gatherAccountSnapshot } from '@/lib/google-ads/audit-queries';
import { runAudit } from '@/lib/ai/audit-agent';
import { decrypt } from '@/lib/crypto';

/**
 * POST /api/audit/run
 * Body: { customerId: string }
 *
 * Runs a full audit on the given Google Ads customer:
 * 1. Fetch a complete account snapshot via GAQL
 * 2. Pass it to Claude (Audit Agent)
 * 3. Persist the audit + recommendations rows
 */
export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { customerId } = await req.json();
  if (!customerId) {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  }

  // Look up the linked account (RLS ensures it belongs to this user)
  const { data: account, error: accountErr } = await supabase
    .from('google_ads_accounts')
    .select('id, refresh_token_encrypted')
    .eq('customer_id', customerId)
    .single();

  if (accountErr || !account) {
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }

  const startTime = Date.now();

  try {
    // 1. Get a Customer client
    const refreshToken = decrypt(account.refresh_token_encrypted);
    const customer = getCustomer(customerId, refreshToken);

    // 2. Gather snapshot
    const snapshot = await gatherAccountSnapshot(customer);

    // 3. Run audit via Claude
    const result = await runAudit(snapshot);

    const duration = Date.now() - startTime;

    // 4. Persist audit
    const { data: audit, error: auditErr } = await supabase
      .from('audits')
      .insert({
        account_id: account.id,
        health_score: result.health_score,
        category_scores: result.category_scores,
        findings: result.findings,
        metrics_snapshot: snapshot.accountInfo,
        estimated_monthly_waste: result.estimated_monthly_waste_sar,
        duration_ms: duration,
      })
      .select('id')
      .single();

    if (auditErr) throw auditErr;

    // 5. Persist recommendations
    const recRows = result.findings.map((f) => ({
      audit_id: audit.id,
      account_id: account.id,
      category: f.category,
      severity: f.severity,
      title: f.title_ar,
      description: f.description_ar,
      expected_impact: f.expected_impact,
      action_payload: f.action_payload,
      status: 'pending',
    }));

    const { error: recErr } = await supabase.from('recommendations').insert(recRows);
    if (recErr) console.error('Failed to insert recommendations', recErr);

    return NextResponse.json({
      success: true,
      audit_id: audit.id,
      health_score: result.health_score,
      findings_count: result.findings.length,
      duration_ms: duration,
    });
  } catch (err: any) {
    // Detailed logging: the wrapped Anthropic SDK "Connection error" hides
    // the actual underlying cause (auth, network, model, etc.). Surface it.
    console.error('Audit failed', {
      message: err?.message,
      name: err?.name,
      status: err?.status,
      cause: err?.cause?.message ?? err?.cause,
      causeCode: err?.cause?.code,
      causeName: err?.cause?.name,
      anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.slice(0, 12) + '…',
      anthropicKeyLen: process.env.ANTHROPIC_API_KEY?.length,
    });
    return NextResponse.json(
      {
        error: 'audit_failed',
        message: err instanceof Error ? err.message : String(err),
        cause: err?.cause?.message,
      },
      { status: 500 }
    );
  }
}
