import { Skeleton } from '@/lib/ui/skeleton';
import { CalmPage } from '../calm-page';

export default function CampaignsLoading() {
  return (
    <div dir="rtl">
      <CalmPage wide>
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full rounded-full" />
        <div className="mt-6 flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-9 w-28 rounded-full" />
          ))}
        </div>
        <Skeleton className="mt-8 h-[360px] rounded-[18px]" />
      </CalmPage>
    </div>
  );
}
