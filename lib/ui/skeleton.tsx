import { cn } from '@/lib/utils';

/** Base shimmering placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-muted', className)} />;
}

/** A card-shaped skeleton with a border, matching real panels. */
export function SkeletonCard({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg border border-border bg-card', className)} />;
}

/** Skeleton rows for table loading states. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-border', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-6 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="ms-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
