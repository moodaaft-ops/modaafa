import { Skeleton, SkeletonCard, SkeletonRows } from '@/lib/ui/skeleton';

export default function OptimizerLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-card px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-5">
            <Skeleton className="h-5 w-48" />
          </div>
          <SkeletonRows rows={4} />
        </div>
        <SkeletonCard className="h-56" />
      </div>
    </div>
  );
}
