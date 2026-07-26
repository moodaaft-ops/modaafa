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
  // Dark is the default theme, so this matches what the boot script applied.
  const [isDark, setIsDark] = useState(true);

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
        'inline-flex items-center gap-2 surface-card text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:bg-surface hover:text-foreground',
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
