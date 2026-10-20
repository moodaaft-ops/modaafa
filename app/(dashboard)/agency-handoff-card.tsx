import { MessageCircle } from 'lucide-react';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { evaluateStoredHandoff, type HandoffRow } from '@/lib/handoff/read';
import { HANDOFF_CARD_COPY, handoffWhatsappUrl } from '@/lib/handoff/rules';
import { AgencyHandoffLink } from './agency-handoff-link';

/**
 * "خلّ فريق مُضاعفة يمسكه". Shown only with AGENCY_HANDOFF_ENABLED, and only
 * when a rule fires. The tap opens WhatsApp with a summary already written and
 * tells us the merchant asked (so the operator sees it).
 */
export async function AgencyHandoffCard({
  supabase,
  account,
  suspended,
}: {
  supabase: any;
  account: { id: string; customer_id: string; customer_name?: string | null; status?: string | null; google_status?: string | null } | null;
  suspended: boolean;
}) {
  if (!account) return null;
  const { data, error } = await supabase
    .from('agency_handoffs')
    .select('account_id, reasons, spend_30d_sar, policy_flagged_ads, evaluated_at, asked_at, handled_at')
    .eq('account_id', account.id)
    .maybeSingle();
  if (error) return null;

  const status = typeof account.google_status === 'string' ? account.google_status.toUpperCase() : null;
  const verdict = evaluateStoredHandoff(data as HandoffRow | null, {
    suspended,
    googleDisabled: Boolean(status && !['ENABLED', 'UNKNOWN', 'UNSPECIFIED'].includes(status)),
  });
  if (!verdict.needed) return null;

  const href = handoffWhatsappUrl({
    accountName: googleAdsAccountDisplayName(account as any),
    customerId: account.customer_id,
    reasons: verdict.reasons,
    spend30dSar: verdict.spend30dSar,
  });

  return (
    <section
      aria-label={HANDOFF_CARD_COPY.title}
      className="mx-4 mt-4 rounded-lg border border-border bg-card px-4 py-3 sm:mx-6 lg:mx-8"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MessageCircle className="h-4 w-4" aria-hidden />
        {HANDOFF_CARD_COPY.title}
      </h2>
      <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{HANDOFF_CARD_COPY.body}</p>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-[13px] leading-6 text-foreground">
        {verdict.reasons.map((reason) => (
          <li key={reason.code}>{reason.text_ar}</li>
        ))}
      </ul>
      <AgencyHandoffLink href={href} customerId={account.customer_id} label={HANDOFF_CARD_COPY.button} />
    </section>
  );
}
