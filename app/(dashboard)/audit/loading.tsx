import { Skeleton, SkeletonCard, SkeletonRows } from '@/lib/ui/skeleton';

export default function AuditLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-card px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center gap-6 rounded-lg border border-border bg-card p-6">
          <Skeleton className="h-44 w-44 rounded-full" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-3/4 max-w-sm" />
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-5">
            <Skeleton className="h-5 w-40" />
          </div>
          <SkeletonRows rows={4} />
        </div>
      </div>
    </div>
  );
}
