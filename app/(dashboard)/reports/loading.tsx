import { Skeleton } from '@/lib/ui/skeleton';
import { CalmPage } from '../calm-page';

export default function ReportsLoading() {
  return (
    <div dir="rtl">
      <CalmPage>
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="mt-3 h-4 w-64 max-w-full rounded-full" />
        <Skeleton className="mt-8 h-[300px] rounded-[18px]" />
        <Skeleton className="mt-10 h-5 w-32 rounded-full" />
        <Skeleton className="mt-3 h-40 rounded-[18px]" />
      </CalmPage>
    </div>
  );
}
