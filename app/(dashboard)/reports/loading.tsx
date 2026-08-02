import { Skeleton, SkeletonCard, SkeletonRows } from '@/lib/ui/skeleton';

export default function ReportsLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <SkeletonCard key={item} className="h-28" />
          ))}
        </div>
        <div className="surface-card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <Skeleton className="h-5 w-44" />
          </div>
          <SkeletonRows rows={6} />
        </div>
      </div>
    </div>
  );
}
