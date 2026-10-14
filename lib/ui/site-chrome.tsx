import Link from 'next/link';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { LogoMark } from '@/lib/ui/logo';
import { buttonClasses } from '@/lib/ui/button';
import { AGENCY_URL, BRAND } from '@/lib/seo/site';

/**
 * Header and footer shared by the legal pages and the public content pages
 * (/about, /google-ads-audit). Both are server components; the only client
 * piece is ThemeToggle. The footer carries the internal links that tie the
 * public pages to each other and to the agency site.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:gap-4 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <LogoMark size={38} alt="مُضاعِف" />
          <span className="text-[14px] font-semibold">مُضاعِف</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <Link
            href="/login"
            className="whitespace-nowrap text-xs font-semibold text-primary hover:underline dark:text-primary sm:text-sm"
          >
            تسجيل الدخول
          </Link>
          <Link href="/register" className={`${buttonClasses({ size: 'sm' })} whitespace-nowrap`}>
            {/* Short label on phones so the wordmark keeps its place in the row. */}
            <span className="min-[440px]:hidden">افحص مجاناً</span>
            <span className="hidden min-[440px]:inline">افحص حسابك مجاناً</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border px-4 py-7 text-sm text-muted-foreground sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="عن مُضاعِف">
            <Link href="/about" className="hover:text-foreground">
              عن مُضاعِف
            </Link>
            <Link href="/google-ads-audit" className="hover:text-foreground">
              فحص حساب إعلانات جوجل مجاناً
            </Link>
            <a href={AGENCY_URL} className="hover:text-foreground">
              وكالة مُضاعفة
            </a>
          </nav>
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="الصفحات القانونية">
            <Link href="/privacy" className="hover:text-foreground">
              الخصوصية
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              الشروط
            </Link>
            <Link href="/refund" className="hover:text-foreground">
              الاسترداد
            </Link>
            <Link href="/data-deletion" className="hover:text-foreground">
              حذف البيانات
            </Link>
          </nav>
        </div>
        <span>
          © 2026 {BRAND.nameAr} / {BRAND.appName} · {BRAND.legalName} · الرقم الوطني الموحد {BRAND.unifiedNumber}
        </span>
      </div>
    </footer>
  );
}
