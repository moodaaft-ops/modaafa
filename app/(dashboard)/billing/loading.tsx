import { Skeleton } from '@/lib/ui/skeleton';
import { CalmPage } from '../calm-page';

export default function BillingLoading() {
  return (
    <div dir="rtl">
      <CalmPage>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="mt-3 h-4 w-64 max-w-full rounded-full" />
        <Skeleton className="mt-6 h-[180px] rounded-[18px]" />
        <Skeleton className="mt-10 h-5 w-32 rounded-full" />
        <Skeleton className="mt-3 h-[420px] rounded-[18px]" />
      </CalmPage>
    </div>
  );
}
