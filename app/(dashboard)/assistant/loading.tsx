import { Skeleton, SkeletonCard } from '@/lib/ui/skeleton';

export default function AssistantLoading() {
  return (
    <div dir="rtl">
      <div className="border-b border-border bg-background/70 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-9 w-40 rounded-full" />
          ))}
        </div>
        <SkeletonCard className="h-[420px]" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    </div>
  );
}
