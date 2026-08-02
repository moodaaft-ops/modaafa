import { Skeleton, SkeletonCard } from '@/lib/ui/skeleton';

export default function SettingsLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SkeletonCard className="h-40" />
        <SkeletonCard className="h-64" />
        <SkeletonCard className="h-40" />
      </div>
    </div>
  );
}
