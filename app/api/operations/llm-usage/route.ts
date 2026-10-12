import { NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { PRICING_VERSION } from '@/lib/ai/pricing';
import { summarizeLlmUsage, type LlmUsageRow } from '@/lib/ai/usage-report';
import { utcMonthStart } from '@/lib/ai/usage';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 1000;
/** Hard ceiling on rows read per request; the response says when it was hit. */
const MAX_PAGES = 50;

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });

/**
 * Operator-only: this month's (UTC) LLM spend grouped by user and feature.
 * Everyone else, signed in or not, gets a plain 404.
 */
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isModaafaOperator(user.email)) return notFound();

  const since = utcMonthStart(new Date());
  const admin = createAdminClient();
  const rows: LlmUsageRow[] = [];
  let truncated = false;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const { data, error } = await admin
      .from('llm_usage')
      .select('user_id, feature, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, priced')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) {
      console.error('llm usage report read failed', { code: error.code ?? null });
      return NextResponse.json({ error: 'usage_unavailable' }, { status: 503 });
    }
    rows.push(...((data ?? []) as LlmUsageRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const summary = summarizeLlmUsage(rows);
  return NextResponse.json(
    {
      month: since.toISOString().slice(0, 7),
      since: since.toISOString(),
      pricingVersion: PRICING_VERSION,
      truncated,
      ...summary,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
