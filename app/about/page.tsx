import Link from 'next/link';
import { headers } from 'next/headers';
import { NONCE_HEADER } from '@/lib/security/csp';
import { buttonClasses } from '@/lib/ui/button';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';
import { JsonLd } from '@/lib/seo/json-ld';
import {
  AGENCY_URL,
  BRAND,
  ENTITY_IDS,
  PAGE_DATES,
  PLAN_PRICES_SAR,
  POSITIONING_AR,
  SITE_URL,
  pageMetadata,
} from '@/lib/seo/site';

const PATH = '/about';

// The title already starts with the brand, so it skips the layout's "| مُضاعِف" suffix.
const ABOUT_TITLE = 'عن مُضاعِف: مين وراه ووش يسوي في حساب إعلانات جوجل';

export const metadata = {
  ...pageMetadata({
    title: ABOUT_TITLE,
    description:
      'مُضاعِف منصة سعودية من مؤسسة تقنيات أيمن للتسويق الإلكتروني، أسسها أيمن أمين مؤسس وكالة مُضاعفة. تقرأ حساب إعلانات جوجل وما تنفّذ أي تعديل إلا بموافقتك.',
    path: PATH,
    ogTitle: 'عن مُضاعِف',
  }),
  title: { absolute: ABOUT_TITLE },
};

const formatPrice = (value: number) => value.toLocaleString('en-US');

export default async function AboutPage() {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const pageUrl = `${SITE_URL}${PATH}`;

  // The sitewide graph (app/layout.tsx) declares the app, the agency and the
  // founder. This page is the entity home, so it adds the AboutPage node and the
  // list prices, which are visible in the table below and nowhere else in markup.
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'AboutPage',
        '@id': `${pageUrl}#page`,
        url: pageUrl,
        name: 'عن مُضاعِف',
        inLanguage: 'ar',
        isPartOf: { '@id': ENTITY_IDS.website },
        mainEntity: { '@id': ENTITY_IDS.app },
        dateModified: PAGE_DATES[PATH],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': ENTITY_IDS.app,
        offers: PLAN_PRICES_SAR.map((plan) => ({
          '@type': 'Offer',
          name: plan.nameAr,
          price: plan.monthly,
          priceCurrency: 'SAR',
          description: 'اشتراك شهري، السعر قبل ضريبة القيمة المضافة',
        })),
      },
    ],
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <article className="mx-auto max-w-3xl px-4 pb-16 pt-10 sm:px-6 sm:pt-14">
        <header>
          <h1 className="text-[2rem] font-bold leading-[1.3] sm:text-[2.6rem]">عن مُضاعِف</h1>
          <p className="mt-5 text-[1.05rem] leading-9">{POSITIONING_AR}</p>
        </header>

        <dl className="mt-10 divide-y divide-border border-y border-border text-sm">
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">الاسم</dt>
            <dd className="leading-7">مُضاعِف، وبالإنجليزي Modaafa. واسم التطبيق على Google: {BRAND.appName}</dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">الرابط</dt>
            <dd dir="ltr" className="text-end font-mono sm:text-start">
              ai.modaafa.com
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">الجهة المالكة</dt>
            <dd className="leading-7">
              {BRAND.legalName}، الرقم الوطني الموحد <span className="font-mono">{BRAND.unifiedNumber}</span>، المملكة
              العربية السعودية
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">المؤسس</dt>
            <dd className="leading-7">
              {BRAND.founderAr} ({BRAND.founderEn})، مؤسس وكالة مُضاعفة لإدارة إعلانات جوجل
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">يشتغل مع</dt>
            <dd className="leading-7">حسابات إعلانات جوجل (Google Ads)، ومعها الحسابات تحت حساب إداري (MCC)</dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
            <dt className="text-muted-foreground">السعر</dt>
            <dd className="leading-7">
              يبدأ من {formatPrice(PLAN_PRICES_SAR[0].monthly)} ريال في الشهر قبل الضريبة، والفحص الأول مجاني
            </dd>
          </div>
        </dl>

        <section className="mt-12" aria-labelledby="why">
          <h2 id="why" className="text-2xl font-bold leading-[1.4]">
            ليش انبنى مُضاعِف؟
          </h2>
          <p className="mt-3 leading-8">
            أيمن أمين يدير إعلانات جوجل لعملاء وكالة مُضاعفة، منهم عيادة أسنان ومعرض مراتب وشركة أبواب ومسابح. كل صبح
            يفتح حساباتهم ويقرا الأرقام ويقرر وش يوقف ووش يزيد.
          </p>
          <p className="mt-3 leading-8">
            المشكلة إن صاحب المحل الصغير ما عنده وقت لهالقراية، والوكالة مكلفة على أغلب الناس. فانبنى مُضاعِف يسوي نفس
            القراية لحسابك، ويحط القرار قدامك مع سببه.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="does">
          <h2 id="does" className="text-2xl font-bold leading-[1.4]">
            وش يسوي مُضاعِف بالضبط؟
          </h2>
          <ul className="mt-4 space-y-4 leading-8">
            <li>
              <span className="font-semibold">يقرا حسابك كل يوم</span> ويطلع لك قراءة اليوم: وش صرفت أمس، ووش يحتاج منك
              قرار.
            </li>
            <li>
              كل قرار يجيك ومعه سببه من أرقام حسابك، مثل كلمة صرفت 30 يوم بدون تحويل أو حملة تخسر ظهورها لأن ميزانيتها
              تخلص بدري.
            </li>
            <li>
              <span className="font-semibold">ما يلمس حسابك إلا باعتمادك.</span> تضغط اعتماد، يتحقق من التعديل على جوجل
              قبل ما ينطبق، ويحفظ له سجل تراجع لمدة 30 يوم.
            </li>
            <li>تسأله بالعربي في المحادثة، كتابة أو بالصوت، عن أي حملة أو رقم.</li>
            <li>
              أول ما تربط، يفحص الحساب مجاناً. تفاصيل الفحص في{' '}
              <Link href="/google-ads-audit" className="font-semibold text-primary hover:underline">
                صفحة فحص حساب إعلانات جوجل
              </Link>
              .
            </li>
          </ul>
        </section>

        <section className="mt-12 border-s-4 border-brand-signal ps-5" aria-labelledby="doesnt">
          <h2 id="doesnt" className="text-2xl font-bold leading-[1.4]">
            وش ما يسويه مُضاعِف؟
          </h2>
          <p className="mt-3 leading-8">
            يشتغل على إعلانات جوجل بس. ما يدير إعلاناتك على منصات ثانية مثل تيك توك وسناب، وما يصمم لك فيديوهات إعلانية.
          </p>
          <p className="mt-3 leading-8">
            ما يضمن لك نتيجة، ولا أحد صادق يضمنها في إعلانات جوجل. والحساب الجديد اللي ما صرف بعد، قرارات مُضاعِف فيه
            قليلة لين تتجمع بيانات تكفي.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="agency">
          <h2 id="agency" className="text-2xl font-bold leading-[1.4]">
            مُضاعِف ووكالة مُضاعفة، وش الفرق؟
          </h2>
          <p className="mt-3 leading-8">
            الاسمين متقاربين والفرق بسيط. <span className="font-semibold">مُضاعفة</span> وكالة تسويق يدير فريقها إعلانات
            جوجل لعملائها، وموقعها{' '}
            <a href={AGENCY_URL} className="font-semibold text-primary hover:underline" dir="ltr">
              modaafa.com
            </a>
            . و<span className="font-semibold">مُضاعِف</span> منصة من نفس المؤسس، تخليك تدير حسابك بنفسك والقرارات جاهزة
            قدامك.
          </p>
          <p className="mt-3 leading-8 text-muted-foreground">
            لو تبي أحد يدير حسابك عنك بالكامل، الوكالة موجودة. ولو تبي تبقى ماسك حسابك بيدك، مُضاعِف معمول لك.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="pricing">
          <h2 id="pricing" className="text-2xl font-bold leading-[1.4]">
            كم سعر مُضاعِف؟
          </h2>
          <p className="mt-3 leading-8">
            الفحص الأول مجاني وبدون بطاقة. والاشتراك له ثلاث خطط شهرية بالريال السعودي قبل ضريبة القيمة المضافة، واللي
            ما جرب قبل ياخذ تجربة 14 يوم ويقدر يلغي قبل أول خصم.
          </p>
          <div className="mt-5 overflow-hidden border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">خطط اشتراك مُضاعِف الشهرية</caption>
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">
                    الخطة
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">
                    السعر الشهري
                  </th>
                </tr>
              </thead>
              <tbody>
                {PLAN_PRICES_SAR.map((plan) => (
                  <tr key={plan.key} className="border-t border-border">
                    <th scope="row" className="px-4 py-3 text-start font-semibold">
                      {plan.nameAr}
                    </th>
                    <td className="px-4 py-3">
                      <span className="font-mono">{formatPrice(plan.monthly)}</span> ريال
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            حدود كل خطة والسعر السنوي في{' '}
            <Link href="/#pricing" className="font-semibold text-foreground hover:underline">
              قسم الأسعار بالصفحة الرئيسية
            </Link>
            ، وشروط الإلغاء في{' '}
            <Link href="/refund" className="font-semibold text-foreground hover:underline">
              سياسة الاسترداد
            </Link>
            .
          </p>
        </section>

        <section className="mt-12" aria-labelledby="contact">
          <h2 id="contact" className="text-2xl font-bold leading-[1.4]">
            كيف تتواصل مع مُضاعِف؟
          </h2>
          <ul className="mt-4 space-y-3 leading-8">
            <li>
              واتساب الفريق:{' '}
              <a
                href={`https://wa.me/${BRAND.whatsappIntl.replace('+', '')}`}
                className="font-mono font-semibold"
                dir="ltr"
              >
                {BRAND.whatsappLocal}
              </a>
              ، وعليه نساعدك تفتح حساب إعلانات جوجل مجاناً لو ما عندك حساب
            </li>
            <li>
              البريد:{' '}
              <a href={`mailto:${BRAND.email}`} className="font-mono font-semibold" dir="ltr">
                {BRAND.email}
              </a>
            </li>
          </ul>
        </section>

        <div className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-border pt-8">
          <Link href="/register" className={buttonClasses({ size: 'lg' })}>
            افحص حسابك مجاناً
          </Link>
          <span className="text-sm text-muted-foreground">آخر تحديث لهذي الصفحة: 14 أكتوبر 2026</span>
        </div>
      </article>

      <SiteFooter />
      <JsonLd data={structuredData} nonce={nonce} />
    </main>
  );
}
