import Image from 'next/image';
import Link from 'next/link';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { AGENCY_URL, BRAND } from '@/lib/seo/site';
import { CTA_TEXT, WHATSAPP } from '@/lib/landing/owner-config';
import { SupportWidgetGate } from '@/lib/support/support-widget-gate';
import { SupportLink } from '@/lib/support/open-support';

/**
 * Header and footer shared by every public page (home, /about,
 * /google-ads-audit and the legal pages). Server components; the only client
 * piece is ThemeToggle. The header is navy in both themes so the brand reads
 * the same on every page; the footer carries the internal links that tie the
 * public pages to each other and to the agency site.
 */

const NAV = [
  { href: '/#product', label: 'كيف يشتغل' },
  { href: '/#pricing', label: 'الأسعار' },
  { href: '/google-ads-audit', label: 'الفحص المجاني' },
  { href: '/faq', label: 'الأسئلة' },
  { href: '/about', label: 'عن مُضاعِف' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-brand-navy/95 text-brand-paper backdrop-blur supports-[backdrop-filter]:bg-brand-navy/85">
      <div className="mx-auto flex h-16 max-w-[76rem] items-center justify-between gap-3 px-4 sm:px-8">
        <Link href="/" className="flex min-w-0 items-center" aria-label="مُضاعِف، الصفحة الرئيسية">
          <Image
            src="/brand/modaafa-lockup-reversed.svg"
            alt="مُضاعِف"
            width={Math.round(30 * (974 / 229))}
            height={30}
            priority
            style={{ width: Math.round(30 * (974 / 229)), height: 30 }}
          />
        </Link>

        <nav aria-label="أقسام الموقع" className="hidden items-center gap-7 text-[14.5px] lg:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-brand-paper/70 transition-colors hover:text-brand-paper">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle className="!h-9 !w-9 !border-white/15 !bg-transparent !text-brand-paper/70 hover:!bg-white/10 hover:!text-brand-paper" />
          <Link
            href="/login"
            className="whitespace-nowrap px-1 text-[13.5px] font-semibold text-brand-paper/80 transition-colors hover:text-brand-paper sm:text-[14.5px]"
          >
            تسجيل الدخول
          </Link>
          <Link
            href="/register"
            className="inline-flex h-10 items-center whitespace-nowrap bg-brand-paper px-3.5 text-[13.5px] font-bold text-brand-navy transition-colors hover:bg-white sm:px-5 sm:text-[14.5px]"
          >
            {/* Short label on small phones so the wordmark keeps its place. */}
            <span className="min-[440px]:hidden">افحص مجاناً</span>
            <span className="hidden min-[440px]:inline">{CTA_TEXT}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

const footerLink = 'inline-flex min-h-10 items-center transition-colors hover:text-foreground';

export function SiteFooter() {
  return (
    <>
      <footer className="border-t border-border bg-background text-[14px] text-muted-foreground">
        <div className="mx-auto grid max-w-[76rem] gap-10 px-4 py-12 sm:px-8 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
          <div className="max-w-sm">
            <Link href="/" className="inline-flex items-center gap-2.5 text-foreground">
              <Image src="/brand/modaafa-symbol-primary.svg" alt="" width={28} height={28} className="dark:hidden" />
              <Image src="/brand/modaafa-symbol-reversed.svg" alt="" width={28} height={28} className="hidden dark:block" />
              <span className="text-[16px] font-bold">مُضاعِف</span>
            </Link>
            <p className="mt-4 leading-7">
              يقرا حساب إعلاناتك في قوقل كل يوم، ويجهّز لك القرار مع سببه. وما يتغيّر شي إلا باعتمادك.
            </p>
          </div>

          <nav aria-label="عن مُضاعِف" className="flex flex-col">
            <span className="mb-2 font-semibold text-foreground">المنصة</span>
            <Link href="/#product" className={footerLink}>
              كيف يشتغل
            </Link>
            <Link href="/#pricing" className={footerLink}>
              الأسعار
            </Link>
            <Link href="/google-ads-audit" className={footerLink}>
              فحص حساب إعلانات جوجل مجاناً
            </Link>
            <Link href="/faq" className={footerLink}>
              أسئلة العملاء
            </Link>
            <Link href="/about" className={footerLink}>
              عن مُضاعِف
            </Link>
          </nav>

          <nav aria-label="تواصل" className="flex flex-col">
            <span className="mb-2 font-semibold text-foreground">تواصل</span>
            <SupportLink href={WHATSAPP.general} className={footerLink}>
              واتساب <span dir="ltr" className="ms-1.5 numeric">{BRAND.whatsappLocal}</span>
            </SupportLink>
            <a href={`mailto:${BRAND.email}`} className={footerLink}>
              الدعم
            </a>
            <a href={AGENCY_URL} className={footerLink}>
              وكالة مُضاعفة
            </a>
          </nav>

          <nav aria-label="الصفحات القانونية" className="flex flex-col">
            <span className="mb-2 font-semibold text-foreground">قانوني</span>
            <Link href="/privacy" className={footerLink}>
              الخصوصية
            </Link>
            <Link href="/terms" className={footerLink}>
              الشروط
            </Link>
            <Link href="/refund" className={footerLink}>
              الاسترداد
            </Link>
            <Link href="/data-deletion" className={footerLink}>
              حذف البيانات
            </Link>
          </nav>
        </div>
        <div className="border-t border-border">
          <p className="mx-auto max-w-[76rem] px-4 py-5 text-[12.5px] leading-6 sm:px-8">
            © 2026 {BRAND.nameAr} ({BRAND.appName})، {BRAND.legalName}، الرقم الوطني الموحد{' '}
            <span className="numeric">{BRAND.unifiedNumber}</span>
          </p>
        </div>
      </footer>
      <SupportWidgetGate />
    </>
  );
}
