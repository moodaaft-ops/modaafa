import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { ThemeToggle } from '@/lib/ui/theme-toggle';

export const metadata: Metadata = {
  title: 'الإعداد الأول',
};

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo-mark.svg" alt="مُضاعِف" width={34} height={34} className="h-9 w-9 rounded-lg" />
            <span className="font-bold text-foreground">مُضاعِف</span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/dashboard" className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-300">
              لوحة التحكم
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
