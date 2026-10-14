import Link from 'next/link';
import { headers } from 'next/headers';
import { NONCE_HEADER } from '@/lib/security/csp';
import { buttonClasses } from '@/lib/ui/button';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';
import { JsonLd } from '@/lib/seo/json-ld';
import { BRAND, ENTITY_IDS, PAGE_DATES, PLAN_PRICES_SAR, SITE_URL, pageMetadata } from '@/lib/seo/site';

const PATH = '/google-ads-audit';

export const metadata = pageMetadata({
  title: 'فحص حساب إعلانات جوجل مجاناً وبدون بطاقة',
  description:
    'يقرأ مُضاعِف آخر 30 يوم في حساب إعلانات جوجل ويطلع لك العبارات اللي تصرف بدون نتيجة وأخطاء تتبع التحويلات. أول فحص مجاني بدون بطاقة، وما يلمس حسابك.',
  path: PATH,
  ogTitle: 'فحص حساب إعلانات جوجل مجاناً: وين يروح صرفك؟',
});

/*
 * Every threshold in CHECKS mirrors lib/audit/rule-engine.ts. If a rule there
 * changes, this table changes with it, otherwise the page promises a check the
 * audit no longer runs.
 */
const CHECKS: Array<{ area: string; when: string }> = [
  {
    area: 'عبارات بحث تصرف بدون نتيجة',
    when: 'عبارة ما جابت ولا تحويل خلال 30 يوم، وأخذت 7 ضغطات أو أكثر، أو صرفت 20 أو ربع تكلفة التحويل في حسابك (الأكبر منهم) بعملة حسابك.',
  },
  {
    area: 'حملة تصرف وما تجيب تحويل',
    when: 'حملة مفعلة صرفت خلال آخر 30 يوم بدون أي تحويل. ولو الضايع 500 أو أكثر تطلع لك في أعلى التقرير كخطر.',
  },
  {
    area: 'تتبع التحويلات',
    when: 'ما فيه إجراء تحويل مفعّل أصلاً، أو 100 ضغطة وأكثر خلال 30 يوم وصفر تحويل مع إن التتبع مفعّل، أو 5 تحويلات وأكثر مسجلة بدون قيمة مالية.',
  },
  {
    area: 'تكلفة التحويل',
    when: 'حملة تكلفة التحويل فيها أعلى من متوسط حسابك بـ35% أو أكثر (وأعلى من 60 بعملة حسابك). وأيضاً حملة صارت آخر 7 أيام أغلى من متوسط شهرها بـ35% وصرفت 50 أو أكثر.',
  },
  {
    area: 'نسبة النقر',
    when: 'حملة ظهرت 500 مرة أو أكثر ونسبة النقر فيها أقل من 3.5%.',
  },
  {
    area: 'جودة الكلمات',
    when: 'كلمة نقاط جودتها 5 أو أقل وصرفت أو ظهرت 100 مرة. ولو النقاط 3 أو أقل يصير التنبيه أشد.',
  },
  {
    area: 'الإعلانات',
    when: 'إعلان مرفوض، أو إعلان قوته «ضعيفة» وظهر 100 مرة وأكثر.',
  },
  {
    area: 'فرص ضايعة',
    when: 'حملة تجيب نتائج بسعر معقول وتخسر 15% أو أكثر من ظهورها بسبب الميزانية. أو حملة تخسر 35% من ظهورها بسبب الترتيب. أو حملة موقوفة جابت 3 تحويلات قبل. أو عبارة جابت تحويلين ومو مضافة ككلمة في حسابك.',
  },
  {
    area: 'حملات واقفة بدون ما تدري',
    when: 'حملة مفعلة على الورق، وما صرفت ولا ريال خلال 30 يوم.',
  },
];

const STEPS: Array<{ title: string; body: string }> = [
  { title: 'أنشئ حسابك', body: 'الاسم والبريد والجوال، ودقيقة وحدة.' },
  {
    title: 'اربط حساب Google اللي يدير إعلاناتك',
    body: 'الربط من شاشة موافقة Google الرسمية، وما نطلب كلمة مرورك أبداً.',
  },
  {
    title: 'اختر الحساب',
    body: 'لو عندك أكثر من حساب أو حسابات تحت حساب إداري (MCC)، تختار اللي تبي تفحصه.',
  },
  {
    title: 'جاوب أسئلة قصيرة عن نشاطك',
    body: 'وأنت تجاوب، الفحص شغّال في الخلفية، فتطلع النتيجة أول ما تخلص.',
  },
];

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'هل فحص حساب إعلانات جوجل مجاني فعلاً؟',
    a: 'إيه، أول فحص مجاني وما يطلب بطاقة. الاشتراك يبدأ لما تبي تنفّذ القرارات وتسأل مُضاعِف في المحادثة، ومعه تجربة 14 يوم لمن ما جربها قبل.',
  },
  {
    q: 'هل الفحص يغيّر شي في حسابي؟',
    a: 'لا. الفحص قراءة بس. وحتى بعد الاشتراك، ولا تعديل ينطبق على حسابك إلا بعد ما تضغط اعتماد بنفسك، وتقدر ترجّع أي تعديل خلال 30 يوم.',
  },
  {
    q: 'أحتاج أعطيكم كلمة مرور حسابي؟',
    a: 'لا. الربط من شاشة موافقة Google الرسمية بصلاحية إعلانات Google فقط، ونشفّر رمز الوصول عندنا. وتقدر تسحب الصلاحية متى ما بغيت من إعدادات حساب Google.',
  },
  {
    q: 'حسابي تديره وكالة، أقدر أفحصه؟',
    a: 'إيه، إذا بريدك له صلاحية على الحساب. والفحص ما يغيّر شي، فما يتعارض مع شغل الوكالة، وتقدر تقارن تقريرها بأرقامك.',
  },
  {
    q: 'ما عندي حساب إعلانات جوجل، أقدر أستفيد؟',
    a: `الفحص يحتاج حساب فيه حملات صرفت. لو ما عندك حساب، فريق وكالة مُضاعفة يساعدك تفتحه مجاناً على واتساب ${BRAND.whatsappLocal}.`,
  },
  {
    q: 'وش الفرق بين الفحص وتوصيات جوجل داخل الحساب؟',
    a: 'الفحص يرتب كل ملاحظة حسب كم تكلفك من صرفك الفعلي آخر 30 يوم، ويقول لك السبب بالأرقام. وما يقترح رفع ميزانية إلا لحملة تجيب نتائج بسعر معقول وتخسر ظهورها بسبب الميزانية.',
  },
];

const startingPrice = PLAN_PRICES_SAR[0].monthly.toLocaleString('en-US');

export default async function GoogleAdsAuditPage() {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const pageUrl = `${SITE_URL}${PATH}`;

  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#page`,
        url: pageUrl,
        name: 'فحص حساب إعلانات جوجل مجاناً',
        inLanguage: 'ar',
        isPartOf: { '@id': ENTITY_IDS.website },
        about: { '@id': `${pageUrl}#service` },
        dateModified: PAGE_DATES[PATH],
      },
      {
        '@type': 'Service',
        '@id': `${pageUrl}#service`,
        name: 'فحص حساب إعلانات جوجل',
        alternateName: 'Google Ads account audit',
        serviceType: 'Google Ads account audit',
        provider: { '@id': ENTITY_IDS.org },
        isRelatedTo: { '@id': ENTITY_IDS.app },
        areaServed: { '@type': 'Country', name: 'السعودية' },
        offers: {
          '@type': 'Offer',
          name: 'الفحص الأول',
          price: 0,
          priceCurrency: 'SAR',
          url: `${SITE_URL}/register`,
        },
      },
      {
        '@type': 'FAQPage',
        '@id': `${pageUrl}#faq`,
        mainEntity: FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <article className="mx-auto max-w-3xl px-4 pb-16 pt-10 sm:px-6 sm:pt-14">
        <header>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground">مُضاعِف · Modaafa</p>
          <h1 className="mt-3 text-[2rem] font-bold leading-[1.3] sm:text-[2.6rem]">فحص حساب إعلانات جوجل مجاناً</h1>
          <p className="mt-5 text-[1.05rem] leading-9">
            مُضاعِف (Modaafa) يقرأ آخر 30 يوم من حساب إعلانات جوجل حقك ويطلع لك تقرير بالأخطاء اللي تاكل ميزانيتك، مرتبة
            من الأخطر للأخف، ومع كل خطأ سببه بالأرقام. الفحص الأول مجاني وما يطلب بطاقة، ويكفيك حساب Google له صلاحية
            على الإعلانات. والفحص قراءة بس: ما يتغير شي في حسابك.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href="/register" className={buttonClasses({ size: 'lg' })}>
              افحص حسابك مجاناً
            </Link>
            <span className="text-sm text-muted-foreground">بدون بطاقة، ولا يلمس حسابك</span>
          </div>
        </header>

        <dl className="mt-10 grid gap-x-8 gap-y-5 border-y border-border py-6 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">الفترة اللي يقراها</dt>
            <dd className="mt-1 text-base font-semibold">آخر 30 يوم، ويقارنها بآخر 7 أيام</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">الكلفة</dt>
            <dd className="mt-1 text-base font-semibold">الفحص الأول مجاني</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">اللي تحتاجه</dt>
            <dd className="mt-1 leading-7">حساب Google له صلاحية على حساب الإعلانات</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">اللي يتغير في حسابك</dt>
            <dd className="mt-1 text-base font-semibold">ولا شي</dd>
          </div>
        </dl>

        <section className="mt-12" aria-labelledby="checks">
          <h2 id="checks" className="text-2xl font-bold leading-[1.4]">
            وش يفحص مُضاعِف في حساب إعلانات جوجل؟
          </h2>
          <p className="mt-3 leading-8 text-muted-foreground">
            هذي القواعد نفسها اللي يشتغل عليها الفحص في مُضاعِف، بأرقامها. أي ملاحظة تطلع لك في التقرير، تقدر ترجع لهذا
            الجدول وتعرف ليش طلعت.
          </p>
          <div className="mt-6 overflow-hidden border border-border">
            <table className="w-full text-start text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="w-[34%] px-4 py-3 text-start font-semibold">
                    الفحص
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">
                    متى ينبهك
                  </th>
                </tr>
              </thead>
              <tbody>
                {CHECKS.map((check) => (
                  <tr key={check.area} className="border-t border-border align-top">
                    <th scope="row" className="px-4 py-4 text-start font-semibold leading-7">
                      {check.area}
                    </th>
                    <td className="px-4 py-4 leading-7 text-muted-foreground">{check.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12" aria-labelledby="report">
          <h2 id="report" className="text-2xl font-bold leading-[1.4]">
            وش يطلع لك في تقرير الفحص؟
          </h2>
          <p className="mt-3 leading-8">
            درجة لحسابك من 100، وكل ملاحظة معلّمة بمستواها من الخطر لين الفرصة. ومعها الهدر التقديري بالريال من أرقام
            آخر 30 يوم، وأول قرار كامل بسببه.
          </p>
          <p className="mt-3 leading-8 text-muted-foreground">
            وبصراحة، باقي القرارات تنفتح مع الاشتراك أو مع التجربة 14 يوم. الملخص والهدر التقديري تشوفهم مجاناً ومعهم
            أول قرار، وتقدر تحكم منها هل يستاهل تكمل.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="steps">
          <h2 id="steps" className="text-2xl font-bold leading-[1.4]">
            كيف تفحص حسابك؟
          </h2>
          <ol className="mt-5 space-y-5">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center border border-foreground font-mono text-xs font-semibold">
                  {index + 1}
                </span>
                <div>
                  <p className="font-semibold">{step.title}</p>
                  <p className="mt-1 text-sm leading-7 text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-12 border-s-4 border-brand-signal ps-5" aria-labelledby="fit">
          <h2 id="fit" className="text-2xl font-bold leading-[1.4]">
            لمن يناسب الفحص؟
          </h2>
          <p className="mt-3 leading-8">
            يناسب أي حساب صرف خلال آخر 30 يوم، سواء تديره بنفسك أو مع وكالة. أما الحساب الجديد اللي ما صرف، فالتقرير
            بيقول لك بوضوح إن البيانات ما تكفي، وما بيخترع لك ملاحظات.
          </p>
          <p className="mt-3 leading-8 text-muted-foreground">
            ورأينا الصريح: لو صرفك الشهري قليل، الاشتراك اللي يبدأ من {startingPrice} ريال في الشهر ممكن ما يغطي نفسه.
            خذ الفحص المجاني أول، واحكم من أرقامك.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="faq">
          <h2 id="faq" className="text-2xl font-bold leading-[1.4]">
            أسئلة شائعة عن فحص حساب إعلانات جوجل
          </h2>
          <div className="mt-5 divide-y divide-border border-y border-border">
            {FAQ.map((item) => (
              <div key={item.q} className="py-5">
                <h3 className="font-semibold leading-7">{item.q}</h3>
                <p className="mt-2 leading-8 text-muted-foreground">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12 bg-brand-navy px-6 py-8 text-brand-paper">
          <p className="text-xl font-bold leading-9">اعرف وين يروح صرفك قبل ما تقرر أي شي.</p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link
              href="/register"
              className="inline-flex h-12 items-center justify-center bg-brand-paper px-6 text-[0.9375rem] font-semibold text-brand-navy transition-colors hover:bg-brand-paper/90"
            >
              افحص حسابك مجاناً
            </Link>
            <Link href="/about" className="text-sm font-semibold underline-offset-4 hover:underline">
              مين ورا مُضاعِف؟
            </Link>
          </div>
        </section>

        <p className="mt-10 text-xs leading-6 text-muted-foreground">
          آخر تحديث: 14 أكتوبر 2026، من فريق مُضاعِف. الفحص يقرأ أرقام الحملات (الصرف والضغطات وعبارات البحث
          والتحويلات)، والتفاصيل في{' '}
          <Link href="/privacy" className="font-semibold text-foreground hover:underline">
            سياسة الخصوصية
          </Link>
          .
        </p>
      </article>

      <SiteFooter />
      <JsonLd data={structuredData} nonce={nonce} />
    </main>
  );
}
