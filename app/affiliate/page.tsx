import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';
import { pageMetadata } from '@/lib/seo/site';
import { createAdminClient } from '@/lib/supabase/server';
import { partnersEnabled } from '@/lib/partners/config';
import { readPartnerSettings, type PartnerSettings } from '@/lib/partners/store';
import { Offer } from '../partners/offer';

export const dynamic = 'force-dynamic';

export const metadata = pageMetadata({
  title: 'برنامج الشركاء: عمولة على كل عميل يدفع',
  description: 'سجّل في مُضاعِف، خذ رابطك، وكل عميل يسجّل منه ويدفع لك عمولة منه. الشروط والأرقام مكتوبة في الصفحة.',
  path: '/affiliate',
  ogTitle: 'برنامج الشركاء في مُضاعِف',
});

/** Public page for the partner programme. Gone (404) while the programme is off. */
export default async function AffiliatePage() {
  if (!partnersEnabled()) notFound();
  let settings: PartnerSettings | null = null;
  try {
    settings = await readPartnerSettings(createAdminClient());
  } catch {
    settings = null;
  }
  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      <SiteHeader />
      <div className="mx-auto w-full max-w-[760px] px-4 pb-20 pt-10 sm:px-6 sm:pt-14">
        <h1 className="text-2xl font-bold leading-10 text-foreground">اربح من كل عميل تجيبه لمُضاعِف</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          مُضاعِف يدير إعلانات قوقل لأصحاب الأعمال. لو جمهورك أصحاب أنشطة يصرفون على إعلانات، خذ رابطك وشاركه، وكل عميل يسجّل منه ويدفع لك عمولة منه.
        </p>
        <div className="mt-8">
          <Offer settings={settings} />
        </div>
        <section className="mt-10 border-t border-border pt-6">
          <h2 className="text-base font-bold text-foreground">كيف تبدأ</h2>
          <ol className="mt-3 list-decimal space-y-2 ps-5 text-sm leading-7">
            <li>سجّل حساب في مُضاعِف، أو ادخل لو عندك حساب.</li>
            <li>افتح صفحة «برنامج الشركاء»، واكتب اسمك وجوالك، ووافق على الشروط.</li>
            <li>تاخذ رابطك وكودك، وتشوف نقراتك وتسجيلاتك وعمولاتك مباشرة.</li>
          </ol>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href="/register" className="inline-flex h-11 items-center justify-center bg-foreground px-6 text-sm font-semibold text-background">
              سجّل حساب
            </Link>
            <Link href="/login?next=%2Fpartners" className="inline-flex h-11 items-center justify-center border border-border px-6 text-sm font-semibold text-foreground">
              عندي حساب
            </Link>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
