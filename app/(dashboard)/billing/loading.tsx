import { Skeleton, SkeletonCard } from '@/lib/ui/skeleton';

export default function BillingLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-card px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SkeletonCard className="h-32" />
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <SkeletonCard key={item} className="h-72" />
          ))}
        </div>
        <SkeletonCard className="h-48" />
      </div>
    </div>
  );
}
