import Link from 'next/link';
import { CircleDotDashed, MessageCircle } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { isLeadLoopEnabled } from '@/lib/lead-loop/flag';
import { getSettingsByAccount, listRecentLeads, summarizeLeads } from '@/lib/lead-loop/store';
import { buildLinkSnippet, publicLinkUrl } from '@/lib/lead-loop/whatsapp';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { buttonClasses } from '@/lib/ui/button';
import { EmptyState } from '@/lib/ui/empty-state';
import { PageHeader } from '@/lib/ui/page-header';
import { LeadsClient } from './leads-client';

export const metadata = { title: 'ليدز هالأسبوع' };
export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function LeadsPage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/leads');
  // Flag off: the page does not exist.
  if (!isLeadLoopEnabled(process.env, user.email)) notFound();

  const workspace = await getAccountWorkspace(user.id);
  const account = workspace.selectedAccount;
  if (!account) {
    return (
      <>
        <PageHeader icon={MessageCircle} title="ليدز هالأسبوع" description="مين كلمك على واتساب وهل صار زبون." />
        <div className="p-4 sm:p-6 lg:p-8">
          <EmptyState
            icon={CircleDotDashed}
            title="اربط حساب قوقل أدز أول"
            description="نحتاج الحساب عشان نربط الليدز بإعلاناتك."
            action={<Link href="/onboarding/connect" className={buttonClasses()}>ربط Google Ads</Link>}
          />
        </div>
      </>
    );
  }

  // Reads go through the service role scoped to the verified account id (the
  // lead tables have an owner-select policy, but click rows are written by the
  // public redirect, so the page uses one consistent path).
  const db = createAdminClient();
  const [settings, leads] = await Promise.all([
    getSettingsByAccount(db, account.id),
    listRecentLeads(db, account.id, WINDOW_DAYS),
  ]);
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://ai.modaafa.com').replace(/\/+$/, '');

  return (
    <>
      <PageHeader icon={MessageCircle} title="ليدز هالأسبوع" description="كل من ضغط على واتساب من إعلانك. علّم مين صار زبون وقوقل يتعلم منه." />
      <div className="p-4 sm:p-6 lg:p-8">
        <LeadsClient
          customerId={account.customer_id}
          settings={
            settings
              ? {
                  whatsappNumber: settings.whatsapp_number,
                  defaultText: settings.default_text ?? '',
                  link: publicLinkUrl(base, settings.slug),
                  snippet: buildLinkSnippet(base),
                }
              : null
          }
          leads={leads.map((lead) => ({
            id: lead.id,
            refCode: lead.ref_code,
            clickedAt: lead.clicked_at,
            status: lead.status,
            valueSar: lead.value_sar,
            source: lead.utm_source,
            campaign: lead.utm_campaign,
            term: lead.utm_term,
            uploadStatus: lead.upload_status,
            hasClickId: lead.has_click_id,
          }))}
          summary={summarizeLeads(leads)}
          windowDays={WINDOW_DAYS}
        />
      </div>
    </>
  );
}
