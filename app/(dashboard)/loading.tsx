import { Skeleton, SkeletonCard, SkeletonRows } from '@/lib/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-card px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SkeletonCard className="h-44" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <SkeletonCard key={item} className="h-28" />
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-5">
            <Skeleton className="h-5 w-40" />
          </div>
          <SkeletonRows rows={5} />
        </div>
      </div>
    </div>
  );
}
