import { Skeleton, SkeletonRows } from '@/lib/ui/skeleton';

export default function CampaignsLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="surface-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border p-5">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-9 w-32 rounded-lg" />
          </div>
          <SkeletonRows rows={8} />
        </div>
      </div>
    </div>
  );
}
