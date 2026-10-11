import { MessagesSquare } from 'lucide-react';
import { DashboardChrome } from '../../(dashboard)/dashboard-chrome';
import { PageHeader } from '@/lib/ui/page-header';
import { StartClient } from '../../(dashboard)/start/start-client';

const acct = { id: 'a1', customer_id: '1112223334', customer_name: 'متجر تجريبي', currency_code: 'SAR', google_status: 'ENABLED' };

export default async function Page({ searchParams }: { searchParams?: Promise<{ approved?: string; executed?: string }> }) {
  const p = await searchParams;
  const notice = p?.executed ? 'executed' : p?.approved ? 'approved' : null;
  return (
    <DashboardChrome
      brandName="متجر تجريبي"
      userEmail="demo@example.test"
      accounts={[acct as any]}
      revokedAccounts={[]}
      pausedAccounts={[]}
      selectedCustomerId="1112223334"
      isOperator={false}
      chatFirst
    >
      <PageHeader icon={MessagesSquare} title="ابدأ بمحادثة" description="اسألني عن حسابك الإعلاني بكلامك العادي." account={{ name: 'متجر تجريبي', customerId: '1112223334' }} />
      <div className="p-3 sm:p-6 lg:p-8">
        <StartClient customerId="1112223334" notice={notice} voiceEnabled={false} />
      </div>
    </DashboardChrome>
  );
}
