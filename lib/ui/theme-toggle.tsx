'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Light/Dark toggle. Persists to localStorage and flips the `dark` class on
 * <html>. A no-FOUC script in the root layout applies the saved theme before
 * paint, so this only needs to keep the toggle in sync after mount.
 */
export function ThemeToggle({ className, showLabel = false }: { className?: string; showLabel?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('modaafa-theme', next ? 'dark' : 'light');
    } catch {}
  }

  const label = isDark ? 'الوضع الفاتح' : 'الوضع الداكن';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border border-border bg-card text-muted-foreground transition hover:text-foreground hover:bg-muted',
        showLabel ? 'px-3 py-2 text-sm font-medium' : 'h-10 w-10 justify-center',
        className
      )}
    >
      {/* Render a neutral icon until mounted to avoid hydration mismatch */}
      {!mounted ? (
        <Sun className="h-[18px] w-[18px]" />
      ) : isDark ? (
        <Sun className="h-[18px] w-[18px]" />
      ) : (
        <Moon className="h-[18px] w-[18px]" />
      )}
      {showLabel && <span>{mounted ? label : 'الثيم'}</span>}
    </button>
  );
}
