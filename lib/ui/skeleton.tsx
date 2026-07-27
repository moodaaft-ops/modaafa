import { cn } from '@/lib/utils';

/** Base placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

/** A card-shaped skeleton matching the real panel treatment. */
export function SkeletonCard({ className }: { className?: string }) {
  return <div className={cn('surface-card animate-pulse', className)} />;
}

/** Skeleton rows for table loading states. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-border', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3.5 w-16" />
          {/* ms-auto (logical) so the third bar sits on the far edge in both
              directions; ml-auto pinned it to the wrong side in RTL. */}
          <Skeleton className="ms-auto h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

/** KPI row placeholder that matches MetricCard's footprint. */
export function SkeletonMetrics({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="surface-card p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-7 w-24" />
          <Skeleton className="mt-3 h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
