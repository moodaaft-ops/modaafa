import { Skeleton, SkeletonCard } from '@/lib/ui/skeleton';

export default function OnboardingLoading() {
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6" dir="rtl">
      <div className="mx-auto max-w-4xl">
        <SkeletonCard className="h-24" />
        <Skeleton className="mt-8 h-8 w-64" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_300px]">
          <SkeletonCard className="h-[420px]" />
          <SkeletonCard className="h-64" />
        </div>
      </div>
    </main>
  );
}
