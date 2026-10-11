import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LogoMark } from '@/lib/ui/logo';

// Video-production harness only. Renders real platform components with
// synthetic data. Never reachable unless GUIDE_HARNESS=1 is set.
export default function HarnessLayout({ children }: { children: React.ReactNode }) {
  if (process.env.GUIDE_HARNESS !== '1') notFound();
  return <>{children}</>;
}

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark size={32} alt="" />
            <span className="text-[15px] font-bold text-foreground">مُضاعِف</span>
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
