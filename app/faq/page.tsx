import Link from 'next/link';
import { headers } from 'next/headers';
import { MessageCircle } from 'lucide-react';
import { NONCE_HEADER } from '@/lib/security/csp';
import { JsonLd } from '@/lib/seo/json-ld';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';
import { WHATSAPP, whatsappHref } from '@/lib/landing/owner-config';
import { FAQ_CATEGORIES, FAQ_ITEMS, faqAnswerText } from '@/lib/faq/data';
import { ENTITY_IDS, PAGE_DATES, SITE_URL, pageMetadata } from '@/lib/seo/site';
import { FaqBrowser } from './faq-browser';

const PATH = '/faq';

export const metadata = pageMetadata({
  title: 'أسئلة العملاء: السعر والتجربة والدول وصلاحيات الحساب',
  description:
    'الأسئلة اللي تتكرر علينا في الواتساب وإنستقرام وتيك توك، بجوابها: كم الاشتراك، وهل يدعم دولتي، وما عندي حساب إعلانات، وهل يعدّل حسابي بدون علمي.',
  path: PATH,
  ogTitle: 'أسئلة عملاء مُضاعِف',
});

const NOT_FOUND_WHATSAPP = whatsappHref('السلام عليكم، سؤالي ما لقيته في صفحة الأسئلة:');

export default async function FaqPage() {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const pageUrl = `${SITE_URL}${PATH}`;

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      <SiteHeader />

      <div className="mx-auto w-full max-w-[52rem] px-5 pb-20 pt-10 sm:px-8 sm:pt-16">
        <header>
          <h1 className="font-display text-[2.1rem] font-semibold leading-[1.28] text-balance sm:text-[2.8rem]">
            اللي يسألونه قبلك.
          </h1>
          <p className="mt-5 max-w-[38rem] text-[17px] leading-9 text-muted-foreground">
            هذي الأسئلة اللي تجينا كل يوم في الواتساب وإنستقرام وتيك توك، جمعناها مع أجوبتها. دوّر على سؤالك قبل ما
            تكتب لنا، وغالباً بتلقاه. وإذا ما لقيته، زر الواتساب في آخر الصفحة.
          </p>
        </header>

        <div className="mt-10">
          <FaqBrowser
            categories={FAQ_CATEGORIES}
            hrefs={{ noAccount: WHATSAPP.noAccount, agency: WHATSAPP.fullManagement }}
          />
        </div>

        <aside className="mt-16 border border-border p-6 sm:p-8">
          <h2 className="font-display text-[1.35rem] font-semibold leading-snug">سؤالك مو هنا؟</h2>
          <p className="mt-2 max-w-[34rem] text-[16px] leading-8 text-muted-foreground">
            اكتبه لنا واتساب، وكل سؤال جديد يتكرر ننزّله في هذي الصفحة عشان اللي بعدك ما يحتاج يسأل.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <a
              href={NOT_FOUND_WHATSAPP}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center gap-2 bg-brand-navy px-6 text-[15.5px] font-bold text-brand-paper transition-colors hover:bg-[#1B2440]"
            >
              <MessageCircle className="h-4 w-4" aria-hidden />
              اسألنا في الواتساب
            </a>
            <Link href="/register" className="text-[15px] font-semibold underline underline-offset-4">
              أو جرّب الفحص المجاني
            </Link>
          </div>
        </aside>
      </div>

      <SiteFooter />

      <JsonLd
        nonce={nonce}
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          '@id': `${pageUrl}#faq`,
          url: pageUrl,
          inLanguage: 'ar',
          isPartOf: { '@id': ENTITY_IDS.website },
          dateModified: PAGE_DATES[PATH],
          mainEntity: FAQ_ITEMS.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: faqAnswerText(item) },
          })),
        }}
      />
    </main>
  );
}
