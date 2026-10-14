import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Check, MessageCircle, Mic, ShieldCheck } from 'lucide-react';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { getPlanPriceAmounts, type PeriodKey, type PlanKey } from '@/lib/billing/stripe';
import { NONCE_HEADER } from '@/lib/security/csp';
import { JsonLd } from '@/lib/seo/json-ld';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';
import { cn, formatCurrency } from '@/lib/utils';
import { CTA_TEXT, WHATSAPP, ownerConfig, showDrafts } from '@/lib/landing/owner-config';
import { getProofCounts } from '@/lib/landing/proof-stats';
import { SquareField } from './landing/square-field';
import { HeroStage, HomeScreen, Phone } from './landing/screens';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const container = 'mx-auto w-full max-w-[76rem] px-5 sm:px-8';
const h2Class = 'font-display text-[1.9rem] font-semibold leading-[1.32] text-balance sm:text-[2.5rem]';
const leadClass = 'mt-5 max-w-[38rem] text-[17px] leading-9 text-muted-foreground';

const questions = [
  'أصرف على قوقل كل يوم، وما أدري وين راحت فلوسي.',
  'تقرير الوكالة يجيني آخر الشهر، وما أفهم منه شي.',
  'قوقل كل شوي يقول لي: زد الميزانية.',
  'ليش الطلبات أمس قليلة؟',
  'ما عندي وقت أفتح الحساب كل يوم، وأخاف أضغط شي يخرب الحملة.',
];

// The quick questions under the chat box, verbatim from lib/chat-first.
const quickAsks = ['وش خطة اليوم؟', 'وين تروح فلوسي؟', 'ليش الطلبات قليلة؟', 'وش وضع حسابي؟'];

const steps = [
  {
    title: 'سجّل واربط حسابك في قوقل',
    body: 'من شاشة موافقة قوقل الرسمية. ما نطلب كلمة مرورك، وتسحب الصلاحية متى ما بغيت.',
  },
  {
    title: 'يقرا حسابك ويتأكد منك',
    body: 'يعرف من الحساب نفسه هل أنت متجر أو عيادة أو خدمات، ويسألك قبل ما يبني على اللي فهمه.',
  },
  {
    title: 'خطتك جاهزة',
    body: 'الهدر الشهري التقديري من أرقام آخر 30 يوم، وأول قرار مفتوح لك تشوفه كامل.',
  },
  {
    title: 'تبدأ تجربتك، أو توقف هنا',
    body: '14 يوم ما ينخصم منك فيها شي، وتلغي بضغطة من داخل التطبيق قبل ما تنتهي.',
  },
];

// Every number below is enforced in code: lib/ai/optimizer-agent.ts
// (checkGuardrails) and app/api/actions/rollback/route.ts.
const limits = [
  { value: '0', unit: 'تعديل', text: 'يوصل حسابك بدون ما تضغط اعتمد. حتى المكالمة الصوتية ما تنفّذ شي.' },
  { value: '25%', unit: 'سقف', text: 'أقصى رفع لميزانية حملة في القرار الواحد، و50% في 24 ساعة مهما اعتمدت.' },
  { value: '20%', unit: 'حد', text: 'أقصى تحريك لهدف المزايدة في المرة.' },
  { value: '30', unit: 'يوم', text: 'ترجع فيها أي تعديل اعتمدته، بضغطة وحدة.' },
];

const notDoing = [
  'ما يصمم إعلانات ولا فيديوهات. يقرا الحساب ويحسّنه، ويكتب لك مسودة حملة نصية لو طلبت.',
  'ما يوعدك بمبيعات. اللي يقدر يقوله لك هو وين تروح فلوسك، ووش القرار اللي يستاهل.',
  'ما ينفّذ شي من نفسه، لا بالكتابة ولا بالصوت.',
  'يحتاج حساب إعلانات قوقل. وإذا ما عندك، نفتحه لك مجاناً على الواتساب.',
];

// Feature lists mirror lib/billing/entitlements PLAN_LIMITS. Do not change a
// number here without changing the plan itself.
const plans = [
  {
    id: 'starter' as PlanKey,
    name: 'البداية',
    monthlyPrice: 500,
    who: 'لمتجر أو نشاط بحساب واحد',
    features: ['20 محادثة مع مُضاعِف يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً', '3 تنفيذات معتمدة يومياً'],
  },
  {
    id: 'growth' as PlanKey,
    name: 'النمو',
    monthlyPrice: 1200,
    who: 'لنشاط يصرف يومياً ويبي متابعة أقرب',
    features: ['100 محادثة مع مُضاعِف يومياً', '7 فحوصات أسبوعياً', '20 مزامنة يدوية يومياً', '20 تنفيذاً معتمداً يومياً'],
    recommended: true,
  },
  {
    id: 'pro' as PlanKey,
    name: 'الاحتراف',
    monthlyPrice: 2500,
    who: 'للوكالات والميديا باير بحسابات كثيرة',
    features: ['500 محادثة مع مُضاعِف يومياً', '70 فحصاً أسبوعياً', '100 مزامنة يومياً', '100 تنفيذ معتمد يومياً'],
  },
];

const faq: Array<{ q: string; a: string; whatsapp?: boolean }> = [
  {
    q: 'وش الفرق بينه وبين توصيات قوقل؟',
    a: 'توصيات قوقل تجي من قوقل نفسه، وكثير منها يدفعك تزيد الميزانية. مُضاعِف يقرا أرقام حسابك أنت، ويكتب لكل قرار سببه، وأحياناً القرار إنك تنزّل أو توقف. وما يتغيّر شي إلا لما تضغط اعتمد.',
  },
  {
    q: 'ما أفهم في الإعلانات، ينفع لي؟',
    a: 'إيه، وهذا اللي انبنى له. تسأله بكلامك ويرد بالعربي من أرقامك، وكل قرار معه سببه. وإذا ما اقتنعت لا تعتمده، ولا يتغيّر شي.',
  },
  {
    q: 'ليش ما أسأل ChatGPT وخلاص؟',
    a: 'تقدر تسأله، وللأسئلة العامة عن الإعلانات يكفي. بس هو ما يشوف حملاتك ولا العبارات اللي صرفت عليها، ويجاوبك على اللي تلصقه له بس. مُضاعِف يقرا الحساب نفسه كل يوم، ويحط على أي تعديل سقف وتراجع 30 يوم.',
  },
  {
    q: 'ميزانيتي صغيرة، يستاهل؟',
    a: `الفحص الأول مجاني، فتعرف قبل ما تدفع هل فيه هدر يستاهل. وصراحة، الاشتراك يبدأ من ${plans[0].monthlyPrice.toLocaleString('en-US')} ريال في الشهر، وإذا حسابك يصرف قليل ممكن ما يغطي نفسه. جرّب الفحص أول، واحكم من أرقامك.`,
  },
  {
    q: 'إذا اعتمدت، مين ينفّذ؟',
    a: 'مُضاعِف يطبّق التعديل على حسابك في قوقل مباشرة بعد ما يتحقق منه، فما تحتاج تدخل قوقل أدز بنفسك. وكل تعديل منفّذ يبقى له زر «رجّعه» لمدة 30 يوم.',
  },
  {
    q: 'أقدر أكلمه بالصوت؟',
    a: 'إيه. داخل المحادثة زر مكالمة، تكلمه وتسمع رده. أما التنفيذ فما يصير بالصوت: أي تعديل يطلع لك في المحادثة وتعتمده بيدك.',
  },
  {
    q: 'أحتاج بطاقة عشان أشوف النتيجة؟',
    a: 'لا. تربط حسابك وتشوف الفحص وخطتك وأول قرار بدون بطاقة، ولكل حساب إعلانات إعادة فحص وحدة مجانية. البطاقة تنطلب لما تبدأ التجربة عشان تنفتح المحادثة والقرارات الباقية، وما ينخصم منك شي 14 يوم.',
  },
  {
    q: 'وش الصلاحية اللي تاخذونها على حسابي؟',
    a: 'صلاحية إعلانات قوقل بس (نطاق adwords) من شاشة موافقة قوقل الرسمية. ما نطلب كلمة مرورك، ورمز الوصول محفوظ مشفّر. وتسحب الصلاحية متى ما بغيت من إعدادات حساب قوقل، أو بحذف حسابك عندنا.',
  },
  {
    q: 'ما عندي حساب إعلانات قوقل، أقدر أستخدمه؟',
    a: 'مُضاعِف يجهّز لك خطة أول حملة من أسئلة بسيطة عن نشاطك. وعشان يشتغل على الحساب نفسه لازم حساب إعلانات، فكلمنا على الواتساب ونفتح لك حساب مستقل باسمك مجاناً.',
    whatsapp: true,
  },
  {
    q: 'أقدر أدير أكثر من حساب؟',
    a: 'إيه. موافقة وحدة تجيب حسابك المباشر وكل حساب عميل تحت أي حساب إداري (MCC) عندك صلاحية عليه، وتبدّل بينها بدون ما تعيد الربط.',
  },
  {
    q: 'إذا ألغيت، وش يصير لبياناتي؟',
    a: 'تحذف حسابك نهائياً من الإعدادات: نلغي الاشتراك، ونسحب صلاحية قوقل، ونحذف بياناتك. الحذف يطلب تأكيد مكتوب عشان ما يصير بالغلط.',
  },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodKey = params?.period === 'yearly' ? 'yearly' : 'monthly';
  const [priceAmounts, proof, nonce] = await Promise.all([
    getPlanPriceAmounts(),
    getProofCounts({
      auditedAccounts: ownerConfig.proofMinAuditedAccounts,
      recommendations: ownerConfig.proofMinRecommendations,
    }),
    headers().then((h) => h.get(NONCE_HEADER) ?? undefined),
  ]);
  const guarantee = ownerConfig.guarantee.approved || showDrafts() ? ownerConfig.guarantee : null;

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      <TikTokPixel pageView />
      <SiteHeader />

      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative isolate overflow-hidden bg-brand-navy text-brand-paper dark:bg-[#0A0F1E]">
        <SquareField tone="navy" id="sq-hero" fade="edges" />
        <div
          className={cn(
            container,
            'grid items-center gap-12 pb-16 pt-10 sm:pt-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16 lg:pb-24 lg:pt-20'
          )}
        >
          <div>
            <div className="flex items-center gap-3">
              <Image
                src="/landing/ayman-avatar-v4.jpg"
                alt=""
                width={44}
                height={44}
                className="h-11 w-11 rounded-full object-cover ring-2 ring-brand-paper/20"
              />
              <p className="text-[14px] leading-6 text-brand-paper/75">
                أيمن أمين، مؤسس وكالة مُضاعفة
                <br />
                <a
                  href={ownerConfig.founderProfileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  className="text-brand-paper/55 underline-offset-4 hover:text-brand-paper hover:underline"
                >
                  @{ownerConfig.founderHandle}
                </a>
              </p>
            </div>

            <h1 className="mt-8 font-display text-[2.35rem] font-semibold leading-[1.22] text-balance sm:text-[3.1rem] lg:text-[3.35rem]">
              صار لك أحد تسأله عن إعلاناتك في قوقل.
            </h1>
            <p className="mt-6 max-w-[34rem] text-[17.5px] leading-9 text-brand-paper/80 sm:text-[19px]">
              مُضاعِف يقرا حسابك كل يوم، ويقول لك بكلامك وين تروح فلوسك ووش القرار اليوم. يجهّزه لك، وأنت اللي تضغط
              اعتمد.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex h-14 items-center justify-center bg-brand-paper px-8 text-[17px] font-bold text-brand-navy transition-colors hover:bg-white"
              >
                {CTA_TEXT}
              </Link>
              <a
                href={WHATSAPP.general}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-14 items-center justify-center gap-2 border border-brand-paper/30 px-6 text-[16px] font-semibold text-brand-paper transition-colors hover:border-brand-paper hover:bg-white/5"
              >
                <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
                كلّمني على الواتساب
              </a>
            </div>
            <p className="mt-5 text-[14.5px] leading-7 text-brand-paper/60">
              الفحص الأول بدون بطاقة، وما يتغيّر شي في حسابك إلا باعتمادك.
            </p>
            {proof.auditedAccounts !== null && (
              <p className="mt-6 inline-flex items-center gap-2.5 border-s-2 border-brand-signal ps-3 text-[14.5px] text-brand-paper/80">
                انفحص فيه <span className="font-bold text-brand-paper numeric">{proof.auditedAccounts}</span> حساب إعلانات
                حقيقي لين اليوم
              </p>
            )}
          </div>

          <HeroStage />
        </div>
      </section>

      {/* ------------------------------------------------- Questions they carry */}
      <section aria-labelledby="questions" className="py-16 sm:py-24">
        <div className={cn(container, 'grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20')}>
          <div>
            <h2 id="questions" className={h2Class}>
              كل صاحب نشاط يعلن في قوقل يعرف هالأسئلة.
            </h2>
            <p className={leadClass}>
              المشكلة مو إن ما فيه أجوبة. المشكلة إن ما فيه أحد يشوف حسابك كل يوم ويجاوبك من أرقامه.
            </p>
          </div>
          <div className="space-y-3.5">
            {questions.map((q) => (
              <p
                key={q}
                className="me-0 ms-auto w-fit max-w-[92%] rounded-[22px] bg-muted px-5 py-3 text-[16.5px] leading-8 text-foreground"
              >
                {q}
              </p>
            ))}
            <div className="flex items-start gap-3 pt-4">
              <Image src="/brand/modaafa-symbol-primary.svg" alt="" width={30} height={30} className="mt-1 dark:hidden" />
              <Image src="/brand/modaafa-symbol-reversed.svg" alt="" width={30} height={30} className="mt-1 hidden dark:block" />
              <p className="max-w-[30rem] text-[17px] font-medium leading-9">
                هذي بالضبط الأسئلة اللي تسأل عنها مُضاعِف. وجوابها يجي من حسابك أنت، مو من نصايح عامة.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- The chat home */}
      <section id="product" aria-labelledby="product-title" className="scroll-mt-20 border-t border-border bg-card py-16 sm:py-24">
        <div className={container}>
          <div className="max-w-[44rem]">
            <h2 id="product-title" className={h2Class}>
              تفتحه، ويبدأ هو الكلام.
            </h2>
            <p className={leadClass}>
              أول ما تفتح مُضاعِف تلقى رسالة فيها آخر 7 أيام بالريال، وتحتها قرارات اليوم مرتبة. الأهم أول، وكل قرار معه
              سببه وكم يوفّر لك في الشهر.
            </p>
          </div>
          <div className="mt-12">
            <HomeScreen />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Ask in words */}
      <section aria-labelledby="ask" className="border-t border-border py-16 sm:py-24">
        <div className={cn(container, 'grid items-center gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-20')}>
          <div>
            <h2 id="ask" className={h2Class}>
              اسأله بكلامك، ويرد بأرقامك.
            </h2>
            <p className={leadClass}>
              تكتب له زي ما تكلم موظفك. يرد من أرقام حسابك، ولو فيه شي يحتاج يتعدّل يجهّزه لك في بطاقة وينتظر اعتمادك.
            </p>
            <p className="mt-8 text-[15px] font-semibold">أسئلة تلقاها جاهزة بضغطة:</p>
            <ul className="mt-3 flex flex-wrap gap-2.5">
              {quickAsks.map((q) => (
                <li key={q} className="rounded-full border border-border bg-card px-4 py-2 text-[15px]">
                  {q}
                </li>
              ))}
            </ul>
            <div className="mt-10 flex gap-4 border-t border-border pt-8">
              <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-brand-paper">
                <Mic className="h-5 w-5" aria-hidden />
              </span>
              <p className="max-w-[32rem] text-[16px] leading-8 text-muted-foreground">
                <span className="font-semibold text-foreground">ما تبي تكتب؟</span> اضغط المكالمة وكلّمه بالصوت. وأي
                تعديل يطلع لك في المحادثة تعتمده بيدك، لأن التنفيذ ما يصير بالصوت.
              </p>
            </div>
          </div>
          <div>
            <Phone
              src="/landing/chat-ask-mobile.png"
              alt="محادثة في مُضاعِف: السؤال «ليش الطلبات أمس قليلة؟» والرد بأرقام الحساب، وتحته بطاقة رفع ميزانية تحتاج اعتماد"
            />
            <p className="mt-4 text-center text-[13px] text-muted-foreground">لقطة من المنصة، بحساب تجريبي.</p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- First session */}
      <section id="how" aria-labelledby="how-title" className="scroll-mt-20 border-t border-border bg-card py-16 sm:py-24">
        <div className={container}>
          <h2 id="how-title" className={cn(h2Class, 'max-w-[40rem]')}>
            من الربط لأول قرار، في جلسة وحدة.
          </h2>
          <div className="mt-12 grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
            <ol className="space-y-9">
              {steps.map((step, i) => (
                <li key={step.title} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-4">
                  <span className="flex h-11 w-11 items-center justify-center border border-foreground/80 font-display text-[18px] font-semibold numeric">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="text-[19px] font-bold leading-8">{step.title}</h3>
                    <p className="mt-1.5 text-[16px] leading-8 text-muted-foreground">{step.body}</p>
                  </div>
                </li>
              ))}
              <li className="border-s-2 border-brand-signal ps-4 text-[15.5px] leading-8 text-muted-foreground">
                ما عندك حساب إعلانات قوقل؟ مُضاعِف يجهّز لك خطة أول حملة، ونفتح لك الحساب مجاناً{' '}
                <a
                  href={WHATSAPP.noAccount}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-foreground underline underline-offset-4"
                >
                  على الواتساب
                </a>
                .
              </li>
            </ol>
            <div className="grid grid-cols-2 items-start gap-4 sm:gap-6">
              <figure>
                <Phone
                  src="/landing/chat-confirm-mobile.png"
                  alt="أول رسالة بعد الربط: هلا، ربطت حسابك وقريته، مع اللي شافه في الحساب وسؤال صح إن اللي يهمك الطلبات من المتجر؟"
                  crop={1300}
                  className="max-w-[250px] rounded-[30px] border-[7px]"
                />
                <figcaption className="mt-3 text-center text-[13px] text-muted-foreground">يقرا ويسألك</figcaption>
              </figure>
              <figure className="mt-12">
                <Phone
                  src="/landing/chat-plan-mobile.png"
                  alt="شاشة خطتك جاهزة: صحة الحساب 64 من 100، وهدر شهري تقديري 1,840 ر.س، وأول قرار مفتوح"
                  crop={2400}
                  className="max-w-[250px] rounded-[30px] border-[7px]"
                />
                <figcaption className="mt-3 text-center text-[13px] text-muted-foreground">وتلقى خطتك جاهزة</figcaption>
              </figure>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Hard limits */}
      <section
        id="control"
        aria-labelledby="control-title"
        className="relative isolate scroll-mt-20 overflow-hidden bg-brand-navy py-16 text-brand-paper dark:bg-[#0A0F1E] sm:py-24"
      >
        <SquareField tone="navy" id="sq-control" fade="left" />
        <div className={container}>
          <h2 id="control-title" className={h2Class}>
            فلوسك تبقى في يدك.
          </h2>
          <p className="mt-5 max-w-[36rem] text-[17px] leading-9 text-brand-paper/70">
            هذي حدود مكتوبة في كود المنصة نفسه، مو وعود في صفحة. وقبل أي تنفيذ، يتحقق التعديل على قوقل أول.
          </p>
          <dl className="mt-12 grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {limits.map((item) => (
              <div key={item.value} className="bg-brand-navy p-6 dark:bg-[#0A0F1E] sm:p-8">
                <dt className="flex items-baseline gap-2">
                  <span className="font-display text-[3rem] font-semibold leading-none numeric">{item.value}</span>
                  <span className="text-[15px] text-brand-paper/60">{item.unit}</span>
                </dt>
                <dd className="mt-4 text-[15.5px] leading-8 text-brand-paper/80">{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------ Founder and proof */}
      <section id="ayman" aria-labelledby="ayman-title" className="scroll-mt-20 py-16 sm:py-24">
        <div className={cn(container, 'grid items-start gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-20')}>
          <div className="order-2 lg:order-1">
            <h2 id="ayman-title" className={h2Class}>
              ليش بنيت مُضاعِف
            </h2>
            <div className="mt-8 max-w-[36rem] space-y-5 text-[17px] leading-9 text-foreground/85">
              <p>
                أنا أيمن أمين. أدير إعلانات قوقل لعملاء وكالة مُضاعفة: عيادة أسنان، ومعرض مراتب، وشركة أبواب، ومسابح. وقبل
                مُضاعفة اشتغلت في تشويش على استراتيجية الإعلانات.
              </p>
              <p>
                أكثر شي تعلمته من هالحسابات إن الخسارة نادراً تجي من حملة غلط من أولها. تجي من حساب ما أحد يفتحه كل يوم.
                صاحب المحل ما عنده وقت، والوكالة مكلفة على أغلب الناس.
              </p>
              <p>
                فبنيت مُضاعِف يسوي القراءة اليومية اللي أسويها أنا، وتسأله وتناقشه زي ما تناقشني. والقرار الأخير يبقى
                عندك، لأني ما أرضى أحد يحرك فلوس عميلي بدون ما يشوفها، فما أرضاها لك.
              </p>
              <p>واعرف إنه للحين يشتغل على قوقل بس. ميتا وتيك توك وسناب مو فيه، وما أبي أوعدك بشي ما انبنى.</p>
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
              <div>
                <p className="font-display text-[1.5rem] font-semibold leading-none">أيمن أمين</p>
                <p className="mt-2 text-[14px] text-muted-foreground">مؤسس وكالة مُضاعفة ومنصة مُضاعِف</p>
              </div>
              <a
                href={WHATSAPP.general}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-12 items-center gap-2 border border-foreground px-5 text-[15px] font-semibold transition-colors hover:bg-foreground hover:text-background"
              >
                <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
                كلّمني على الواتساب
              </a>
            </div>
          </div>

          <div className="order-1 lg:order-2">
            <Image
              src="/landing/ayman-desk-v4.jpg"
              alt="أيمن أمين على مكتبه الصبح، قدامه اللابتوب وفنجال قهوة"
              width={980}
              height={1223}
              sizes="(min-width: 1024px) 34vw, 100vw"
              className="mx-auto block h-auto w-full max-w-[26rem] lg:max-w-none"
            />
          </div>
        </div>

        {(proof.auditedAccounts !== null || proof.recommendations !== null || ownerConfig.agencyResults.length > 0) && (
          <div className={cn(container, 'mt-16 sm:mt-24')}>
            <div
              className={cn(
                'grid gap-px overflow-hidden border border-border bg-border',
                (proof.auditedAccounts !== null || proof.recommendations !== null) &&
                  ownerConfig.agencyResults.length > 0 &&
                  'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]'
              )}
            >
              {(proof.auditedAccounts !== null || proof.recommendations !== null) && (
                <div className="bg-card p-7 sm:p-9">
                  <p className="text-[14px] font-semibold text-muted-foreground">من قاعدة بيانات المنصة، تتحدث كل ساعة</p>
                  <dl className="mt-6 space-y-7">
                    {proof.auditedAccounts !== null && (
                      <div>
                        <dt className="font-display text-[2.6rem] font-semibold leading-none numeric">
                          {proof.auditedAccounts.toLocaleString('en-US')}
                        </dt>
                        <dd className="mt-2 text-[16px] text-muted-foreground">حساب إعلانات انفحص في مُضاعِف</dd>
                      </div>
                    )}
                    {proof.recommendations !== null && (
                      <div>
                        <dt className="font-display text-[2.6rem] font-semibold leading-none numeric">
                          {proof.recommendations.toLocaleString('en-US')}
                        </dt>
                        <dd className="mt-2 text-[16px] text-muted-foreground">قرار جهّزه لأصحابها، كل واحد بسببه</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
              {ownerConfig.agencyResults.map((r) => (
                <div key={r.business} className="bg-card p-7 sm:p-9">
                  <p className="text-[14px] font-semibold text-muted-foreground">
                    من شغل الوكالة: {r.business}، {r.period}
                  </p>
                  <dl className="mt-6 space-y-6">
                    {r.lines.map((line) => (
                      <div key={line.label}>
                        <dt className="text-[15.5px]">{line.label}</dt>
                        <dd className="mt-2 flex flex-wrap items-baseline gap-x-3 font-display text-[1.9rem] font-semibold leading-tight numeric">
                          <span className="text-muted-foreground line-through decoration-1">{line.before}</span>
                          <span aria-hidden className="text-[1.2rem] text-muted-foreground">←</span>
                          <span>{line.after}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-6 text-[14px] leading-7 text-muted-foreground">{r.note}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- Two ways in */}
      <section aria-labelledby="paths" className="border-t border-border bg-card py-16 sm:py-24">
        <div className={container}>
          <h2 id="paths" className={cn(h2Class, 'max-w-[40rem]')}>
            تبيها بنفسك؟ ولا تبينا نديرها عنك؟
          </h2>
          <div className="mt-10 grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="flex flex-col border-2 border-foreground p-7 sm:p-9">
              <h3 className="text-[21px] font-bold">سوّها بنفسك مع مُضاعِف</h3>
              <p className="mt-3 flex-1 text-[16.5px] leading-8 text-muted-foreground">
                لصاحب النشاط اللي يبي يفهم حسابه ويقرر بنفسه، بدون ما يدفع راتب ميديا باير. تبدأ بالفحص المجاني، وتشوف
                خطتك قبل أي بطاقة.
              </p>
              <Link
                href="/register"
                className="mt-7 inline-flex h-12 w-fit items-center bg-foreground px-6 text-[15.5px] font-bold text-background transition-opacity hover:opacity-90"
              >
                {CTA_TEXT}
              </Link>
            </div>
            <div className="flex flex-col border border-border p-7 sm:p-9">
              <h3 className="text-[21px] font-bold">خلّ فريق وكالة مُضاعفة يديرها</h3>
              <p className="mt-3 flex-1 text-[16.5px] leading-8 text-muted-foreground">
                إذا ما عندك وقت أبد، أو حسابك كبير ويبي أحد يمسكه كل يوم. نفس الفريق اللي بنى مُضاعِف.
              </p>
              <a
                href={WHATSAPP.fullManagement}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-7 inline-flex h-12 w-fit items-center gap-2 border border-foreground px-6 text-[15.5px] font-semibold transition-colors hover:bg-foreground hover:text-background"
              >
                <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
                كلّم الوكالة على الواتساب
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Pricing */}
      <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 border-t border-border py-16 sm:py-24">
        <div className={container}>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[40rem]">
              <h2 id="pricing-title" className={h2Class}>
                الفحص مجاني. والاشتراك لما تبي تعتمد.
              </h2>
              <p className={leadClass}>
                تشوف خطتك وأول قرار بدون بطاقة. الاشتراك يبدأ بتجربة 14 يوم، والأسعار بالريال قبل الضريبة.
              </p>
            </div>
            <div className="inline-flex w-fit items-center border border-border p-1 text-[14px]" role="group" aria-label="فترة الفوترة">
              {(['monthly', 'yearly'] as const).map((p) => (
                <Link
                  key={p}
                  href={`/?period=${p}#pricing`}
                  aria-current={period === p ? 'true' : undefined}
                  className={cn(
                    'px-5 py-2 font-medium transition-colors',
                    period === p ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {p === 'monthly' ? 'شهري' : 'سنوي'}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-4 border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div>
              <p className="text-[18px] font-bold">الفحص المجاني</p>
              <p className="mt-1 text-[15.5px] leading-7 text-muted-foreground">
                فحص كامل وإعادة وحدة لكل حساب، مع خطتك وأول قرار. بدون بطاقة.
              </p>
            </div>
            <Link
              href="/register"
              className="inline-flex h-12 flex-shrink-0 items-center justify-center bg-foreground px-6 text-[15.5px] font-bold text-background transition-opacity hover:opacity-90"
            >
              {CTA_TEXT}
            </Link>
          </div>

          <div className="mt-5 grid gap-5 md:grid-cols-3">
            {plans.map((plan) => {
              const livePrice = priceAmounts?.[plan.id]?.[period] ?? null;
              const displayAmount = livePrice?.amount ?? (period === 'monthly' ? plan.monthlyPrice : null);
              const displayCurrency = (livePrice?.currency ?? 'sar').toUpperCase();
              const monthlyAmount = priceAmounts?.[plan.id]?.monthly?.amount ?? plan.monthlyPrice;
              const yearlySavings =
                period === 'yearly' && livePrice && displayCurrency === 'SAR'
                  ? Math.max(0, monthlyAmount * 12 - livePrice.amount)
                  : 0;
              return (
                <article
                  key={plan.id}
                  className={cn(
                    'relative flex flex-col bg-card p-7',
                    plan.recommended ? 'border-2 border-foreground' : 'border border-border'
                  )}
                >
                  {plan.recommended && (
                    <span className="absolute -top-3 start-6 bg-foreground px-2.5 py-0.5 text-[12.5px] font-bold text-background">
                      أنصح فيها
                    </span>
                  )}
                  <h3 className="text-[19px] font-bold">{plan.name}</h3>
                  <p className="mt-1 text-[14.5px] leading-7 text-muted-foreground">{plan.who}</p>
                  <div className="mt-6 flex min-h-11 items-baseline gap-1.5">
                    {displayAmount !== null ? (
                      <>
                        <span className="font-display text-[2.4rem] font-semibold leading-none numeric">
                          {formatCurrency(displayAmount, displayCurrency)}
                        </span>
                        <span className="text-[14px] text-muted-foreground">/ {period === 'yearly' ? 'سنة' : 'شهر'}</span>
                      </>
                    ) : (
                      <span className="text-[14px] font-semibold leading-7 text-muted-foreground">
                        يظهر السعر السنوي النهائي في صفحة الدفع
                      </span>
                    )}
                  </div>
                  {yearlySavings > 0 && (
                    <p className="mt-2 text-[13px] font-medium text-success">
                      توفّر {formatCurrency(yearlySavings, 'SAR')} عن الدفع الشهري
                    </p>
                  )}
                  <ul className="mt-6 flex-1 space-y-2.5 border-t border-border pt-6">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5 text-[15px] leading-7">
                        <Check className="mt-1.5 h-4 w-4 flex-shrink-0" aria-hidden />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/register"
                    className={cn(
                      'mt-7 inline-flex h-12 items-center justify-center text-[15.5px] font-bold transition-colors',
                      plan.recommended
                        ? 'bg-foreground text-background hover:opacity-90'
                        : 'border border-foreground hover:bg-foreground hover:text-background'
                    )}
                  >
                    ابدأ بخطة {plan.name}
                  </Link>
                </article>
              );
            })}
          </div>
          <p className="mt-5 text-[14.5px] leading-7 text-muted-foreground">
            خلال التجربة تشتغل بحدود باقة البداية، والحدود الكاملة تبدأ من أول دفعة. وتلغي بضغطة من داخل التطبيق.
          </p>

          {guarantee && (
            <div
              className={cn(
                'relative mt-10 grid gap-5 bg-brand-navy p-7 text-brand-paper dark:bg-[#0A0F1E] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:p-9',
                !guarantee.approved && 'outline-dashed outline-2 outline-offset-4 outline-brand-signal'
              )}
            >
              {!guarantee.approved && (
                <span className="absolute -top-3 end-6 bg-brand-signal px-2.5 py-0.5 text-[12px] font-bold text-brand-navy">
                  مسودة للاعتماد، ما تطلع في الموقع الحي
                </span>
              )}
              <ShieldCheck className="h-10 w-10 text-brand-signal" aria-hidden />
              <div>
                <p className="font-display text-[1.5rem] font-semibold">{guarantee.title}</p>
                <p className="mt-2 max-w-[44rem] text-[16.5px] leading-8 text-brand-paper/80">{guarantee.promise}</p>
              </div>
              <Link
                href="/refund#guarantee"
                className="w-fit text-[15px] font-semibold text-brand-paper underline underline-offset-4 hover:no-underline"
              >
                الشروط كاملة
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------- What it doesn't do */}
      <section aria-labelledby="not-doing" className="border-t border-border bg-card py-16 sm:py-24">
        <div className={cn(container, 'grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20')}>
          <h2 id="not-doing" className={h2Class}>
            قبل ما تسجّل، اعرف وش ما يسويه.
          </h2>
          <ul className="divide-y divide-border border-y border-border">
            {notDoing.map((line) => (
              <li key={line} className="py-5 text-[17px] leading-8">
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------------- FAQ */}
      <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-t border-border py-16 sm:py-24">
        <div className={cn(container, 'grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20')}>
          <h2 id="faq-title" className={h2Class}>
            اسأل قبل ما تربط.
          </h2>
          <div className="space-y-3">
            {faq.map((item) => (
              <details key={item.q} className="group border-b border-border pb-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-2 [&::-webkit-details-marker]:hidden">
                  <span className="rounded-[20px] bg-muted px-5 py-2.5 text-[16.5px] font-medium leading-7">{item.q}</span>
                  <span
                    aria-hidden
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-border text-[18px] leading-none text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <div className="flex items-start gap-3 pb-4 pt-3">
                  <Image src="/brand/modaafa-symbol-primary.svg" alt="" width={24} height={24} className="mt-1.5 dark:hidden" />
                  <Image src="/brand/modaafa-symbol-reversed.svg" alt="" width={24} height={24} className="mt-1.5 hidden dark:block" />
                  <div>
                    <p className="max-w-[42rem] text-[16.5px] leading-9 text-foreground/85">{item.a}</p>
                    {item.whatsapp && (
                      <a
                        href={WHATSAPP.noAccount}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-2 text-[15px] font-semibold underline underline-offset-4"
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden />
                        افتح حسابي على الواتساب
                      </a>
                    )}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Final CTA */}
      <section className="relative isolate overflow-hidden bg-brand-navy py-20 text-brand-paper dark:bg-[#0A0F1E] sm:py-28">
        <SquareField tone="navy" id="sq-final" fade="edges" />
        <div className={cn(container, 'max-w-[48rem] text-center')}>
          <h2 className="font-display text-[2rem] font-semibold leading-[1.3] text-balance sm:text-[2.8rem]">
            اربط حسابك اليوم، وشوف وين راحت فلوس آخر 30 يوم.
          </h2>
          <p className="mx-auto mt-5 max-w-[32rem] text-[17px] leading-9 text-brand-paper/75">
            الفحص الأول مجاني وبدون بطاقة. وإذا ما عجبك اللي شفته، ما خسرت شي.
          </p>
          <Link
            href="/register"
            className="mt-9 inline-flex h-14 items-center justify-center bg-brand-paper px-9 text-[17px] font-bold text-brand-navy transition-colors hover:bg-white"
          >
            {CTA_TEXT}
          </Link>
        </div>
      </section>

      <SiteFooter />
      <JsonLd
        nonce={nonce}
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        }}
      />
    </main>
  );
}
