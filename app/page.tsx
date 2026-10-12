import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { ArrowLeft, ChevronDown, MessageCircle } from 'lucide-react';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { getPlanPriceAmounts, type PeriodKey, type PlanKey } from '@/lib/billing/stripe';
import { NONCE_HEADER } from '@/lib/security/csp';
import { getAuditedAccountsForProof } from '@/lib/landing/proof-stats';
import { cn, formatCurrency } from '@/lib/utils';
import { CTA_TEXT, ownerConfig } from './landing/owner-config';
import { PlanDemo } from './landing/plan-demo';
import { StickyCta } from './landing/sticky-cta';
import { DayLeaks, FlowDiagram, LimitVisual, MoveVisual, PlanScreen, type LimitKind, type MoveKind } from './landing/visuals';

/*
 * Landing page, October 2026 rewrite.
 *
 * Built around three things a Saudi merchant checks before connecting an ad
 * account: who is behind this (Ayman, in person, with his photo and number),
 * what exactly it will do to the account (the six allowed actions and their
 * conditions, taken from lib/ai/optimizer-agent.ts), and what it will never do
 * (the guardrails in checkGuardrails and the 30-day rollback window in
 * app/api/actions/rollback). Every rule quoted on this page exists in code;
 * update the copy here if those limits change.
 *
 * The page is always light: it is photo-led and brand-coloured, so it uses the
 * raw identity palette (brand-*) instead of the theme tokens.
 */

const WHATSAPP_NUMBER = '966541004029';
const whatsappHref = (text: string) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
const WHATSAPP_GENERAL = whatsappHref('السلام عليكم، شفت مُضاعِف وعندي سؤال');
const WHATSAPP_NO_ACCOUNT = whatsappHref('السلام عليكم، ما عندي حساب إعلانات قوقل وأبي أجرب مُضاعِف');

export const metadata: Metadata = {
  title: { absolute: 'مُضاعِف | ميديا باير يقرا حساب إعلانات قوقل كل يوم' },
  description:
    'مُضاعِف يقرا حساب إعلانات قوقل ويجهّز لك خطة يومية، كل قرار فيها معه سببه من أرقامك، وما يتغير شي في الحساب إلا باعتمادك. الفحص الأول مجاني وبدون بطاقة.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'مُضاعِف | كم تضيع من فلوسك في إعلانات قوقل؟ مُضاعِف يوريك وينها بالريال',
    description: 'خطة يومية لحساب إعلانات قوقل، كل قرار معه سببه، وما يتغير شي إلا باعتمادك. الفحص الأول مجاني.',
    type: 'website',
    locale: 'ar_SA',
    siteName: 'مُضاعِف',
    images: [{ url: '/landing/og-landing-v2.png', width: 1200, height: 630, alt: 'أيمن أمين، مؤسس مُضاعِف' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'مُضاعِف | كم تضيع من فلوسك في إعلانات قوقل؟ مُضاعِف يوريك وينها بالريال',
    description: 'خطة يومية لحساب إعلانات قوقل، وما يتغير شي إلا باعتمادك. الفحص الأول مجاني.',
    images: ['/landing/og-landing-v2.png'],
  },
};

const moves: Array<{ kind: MoveKind; name: string; rule: string }> = [
  { kind: 'pause_keyword', name: 'يوقف كلمة تصرف بدون نتيجة', rule: 'بعد 7 أيام بيانات على الأقل، وأكثر من 20 ضغطة، وبدون تحويل.' },
  { kind: 'add_keyword', name: 'يضيف عبارة بحث جابت طلبات', rule: 'إذا جابت تحويلين أو أكثر خلال 30 يوم وهي مو كلمة في حسابك.' },
  { kind: 'add_negative', name: 'يمنع عبارة تاكل الميزانية', rule: '5 ضغطات أو أكثر بدون أي تحويل.' },
  { kind: 'adjust_budget', name: 'يعدّل ميزانية حملة', rule: 'يرفع حتى 25% أو ينزّل حتى 30% في المرة، ولما الأرقام تبرر بس.' },
  { kind: 'adjust_bid', name: 'يحرّك هدف المزايدة', rule: 'في حدود 20% زيادة أو نقص عن الهدف الحالي.' },
  { kind: 'pause_ad', name: 'يوقف إعلان ضعيف', rule: 'لما قوقل يقيّمه ضعيف ونسبة ضغطه أقل من نص متوسط مجموعته.' },
];

const limits: Array<{ kind: LimitKind; value: string; unit: string; text: string }> = [
  { kind: 'gate', value: '0', unit: 'تعديل', text: 'يوصل حسابك في قوقل بدون ما تضغط اعتمد.' },
  { kind: 'cap', value: '50%', unit: 'سقف', text: 'أقصى زيادة لميزانية الحملة الوحدة خلال 24 ساعة، حتى لو اعتمدت أكثر من قرار.' },
  { kind: 'window', value: '30', unit: 'يوم', text: 'تقدر ترجع فيها أي تعديل اعتمدته، بضغطة.' },
  { kind: 'range', value: '20%', unit: 'حد', text: 'أقصى تحريك لهدف المزايدة في القرار الواحد.' },
];

const painLines = [
  'أصرف على قوقل كل يوم، وما أدري وين راحت فلوسي.',
  'تقرير الوكالة يجيني آخر الشهر، وما أفهم منه شي.',
  'قوقل كل شوي يرسل لي توصية: زد الميزانية.',
  'ما عندي وقت أفتح الحساب كل يوم، وأخاف أضغط شي يخرب الحملة.',
  'أبي أحد يقول لي بالعربي وش أسوي، مو جداول.',
];

const plans = [
  {
    id: 'starter' as PlanKey,
    name: 'البداية',
    monthlyPrice: 500,
    who: 'لمتجر أو نشاط بحساب واحد',
    features: ['20 محادثة مع المساعد يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً', '3 تنفيذات معتمدة يومياً'],
  },
  {
    id: 'growth' as PlanKey,
    name: 'النمو',
    monthlyPrice: 1200,
    who: 'لنشاط يصرف يومياً ويبي متابعة أقرب',
    features: ['100 محادثة مع المساعد يومياً', '7 فحوصات أسبوعياً', '20 مزامنة يدوية يومياً', '20 تنفيذاً معتمداً يومياً'],
    recommended: true,
  },
  {
    id: 'pro' as PlanKey,
    name: 'الاحتراف',
    monthlyPrice: 2500,
    who: 'للوكالات والميديا باير بحسابات كثيرة',
    features: ['500 محادثة مع المساعد يومياً', '70 فحصاً أسبوعياً', '100 مزامنة يومياً', '100 تنفيذ معتمد يومياً'],
  },
];

const faq: Array<{ q: string; a: string; whatsapp?: boolean; cta?: boolean }> = [
  {
    q: 'وش الفرق بينه وبين توصيات قوقل؟',
    a: 'توصيات قوقل تجي من قوقل نفسه، وكثير منها يدفعك تزيد الميزانية. مُضاعِف يقرا أرقام حسابك أنت، ويكتب لكل قرار سببه، وأحياناً القرار إنك تنزّل أو توقف. وما يتغير شي إلا لما تضغط اعتمد.',
    cta: true,
  },
  {
    q: 'ما أفهم في الإعلانات، ينفع لي؟',
    a: 'إيه. كل قرار مكتوب بالعربي ومعه سببه من أرقامك، وأنت تقرا وتقرر. وإذا قرار ما فهمته، اسأل المساعد داخل المنصة أو كلمني على الواتساب. وإذا ما اقتنعت لا تعتمده، ولا يتغير شي.',
    cta: true,
  },
  {
    q: 'ليش ما أسأل ChatGPT وخلاص؟',
    a: 'تقدر تسأله، وللأسئلة العامة عن الإعلانات يكفي. لكن لو ما ربطته بحسابك فهو ما يشوف حملاتك ولا كلماتك ولا عبارات البحث اللي صرفت عليها، ويجاوبك على اللي تلصقه له بس. مُضاعِف يقرا الحساب نفسه، ويحط على التنفيذ سقف ميزانية وتراجع 30 يوم.',
    cta: true,
  },
  {
    q: 'ميزانيتي صغيرة، يستاهل؟',
    a: `الفحص الأول مجاني، فتعرف قبل ما تدفع هل في هدر يستاهل. وصراحة، الاشتراك يبدأ من ${plans[0].monthlyPrice.toLocaleString('en-US')} ريال في الشهر، وإذا حسابك يصرف قليل ممكن ما يغطي نفسه. جرب الفحص أول، وحكم من أرقامك.`,
    cta: true,
  },
  {
    q: 'هل يعدّل في حسابي من نفسه؟',
    a: 'لا. كل تعديل يطلع لك كاقتراح فيه الحملة المستهدفة والقيمة الجديدة والسبب. ما يوصل قوقل شي قبل ما تضغط «اعتمد».',
  },
  {
    q: 'إذا اعتمدت، مين ينفّذ؟',
    a: 'مُضاعِف يطبّق التعديل على حسابك في قوقل مباشرة، فما تحتاج تدخل قوقل أدز بنفسك. وكل تعديل منفّذ يبقى له زر تراجع لمدة 30 يوم.',
  },
  {
    q: 'وش الصلاحية اللي تاخذونها على حسابي؟',
    a: 'صلاحية إعلانات قوقل بس (نطاق adwords) من شاشة موافقة قوقل الرسمية. ما نطلب كلمة مرورك، ورمز الوصول محفوظ مشفّر. وتقدر تسحب الصلاحية متى ما بغيت من إعدادات حساب قوقل، أو بحذف حسابك عندنا.',
  },
  {
    q: 'أحتاج بطاقة عشان أشوف النتيجة؟',
    a: 'لا. تربط حسابك وتشغّل فحص كامل وتقرا توصياته بدون بطاقة، ولكل حساب إعلاني إعادة فحص وحدة مجانية بعده. الاشتراك يُطلب لما تضغط تنفيذ توصية، أو تبي فحص جديد بعد الفحصين. وقتها تنطلب البطاقة عبر Stripe، واللي ما جرب التجربة قبل ياخذ 14 يوم بدون خصم، ويلغي قبل أول خصم من صفحة الفوترة.',
  },
  {
    q: 'ما عندي حساب إعلانات قوقل، أقدر أستخدمه؟',
    a: 'مُضاعِف يحتاج حساب إعلانات قوقل عشان يقرا. إذا ما عندك، كلمنا على الواتساب ونفتح لك حساب مستقل باسمك مجاناً، وتوصلك دعوة على إيميلك.',
    whatsapp: true,
  },
  {
    q: 'هل يصمم إعلانات أو فيديوهات؟',
    a: 'لا. شغله قراءة الحساب وتحسينه. تقدر تطلب من المساعد مسودة حملة نصية بالعربي، أما الصور والفيديو فمو عنده.',
  },
  {
    q: 'أقدر أدير أكثر من حساب؟',
    a: 'إيه. موافقة وحدة تجيب حسابك المباشر وكل حساب عميل تحت أي حساب إداري (MCC) عندك صلاحية عليه، وتبدّل بينها بدون ما تعيد الربط.',
  },
  {
    q: 'إذا ألغيت، وش يصير لبياناتي؟',
    a: 'تقدر تحذف حسابك نهائياً من الإعدادات: نلغي الاشتراك، ونسحب صلاحية قوقل، ونحذف بياناتك من قاعدة البيانات. الحذف يطلب منك تأكيد مكتوب عشان ما يصير بالغلط.',
  },
  {
    q: 'الأسعار شاملة الضريبة؟',
    a: 'الأسعار بالريال السعودي قبل ضريبة القيمة المضافة، والضريبة تطلع في صفحة الدفع وفي فاتورتك.',
  },
];

const container = 'mx-auto w-full max-w-[76rem] px-5 sm:px-8';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodKey = params?.period === 'yearly' ? 'yearly' : 'monthly';
  const priceAmounts = await getPlanPriceAmounts();
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const auditedAccounts = await getAuditedAccountsForProof(ownerConfig.proofMinAccounts);

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-brand-paper text-brand-navy">
      <TikTokPixel pageView />
      <StructuredData nonce={nonce} />

      {/* ------------------------------------------------------------------ Nav */}
      <header className="sticky top-0 z-40 border-b border-brand-navy/10 bg-brand-paper/95 backdrop-blur-sm">
        <div className={cn(container, 'flex h-16 items-center justify-between gap-3')}>
          <Link href="/" className="flex-shrink-0" aria-label="مُضاعِف، الصفحة الرئيسية">
            <Image src="/brand/modaafa-lockup-primary.svg" alt="مُضاعِف" width={136} height={32} priority className="h-8 w-auto" />
          </Link>

          <nav aria-label="أقسام الصفحة" className="hidden items-center gap-1 text-[14px] text-brand-slate md:flex">
            <a href="#how" className="px-3 py-2 transition-colors hover:text-brand-navy">
              كيف يشتغل
            </a>
            <a href="#limits" className="px-3 py-2 transition-colors hover:text-brand-navy">
              الحدود
            </a>
            <a href="#ayman" className="px-3 py-2 transition-colors hover:text-brand-navy">
              مين وراه
            </a>
            <a href="#pricing" className="px-3 py-2 transition-colors hover:text-brand-navy">
              الأسعار
            </a>
            <a href="#faq" className="px-3 py-2 transition-colors hover:text-brand-navy">
              أسئلة
            </a>
          </nav>

          <div className="flex items-center gap-1.5">
            <Link
              href="/login"
              className="inline-flex h-10 items-center px-3 text-[14px] font-semibold text-brand-navy transition-colors hover:bg-brand-navy/5"
            >
              تسجيل الدخول
            </Link>
            <Link
              href="/login"
              className="hidden h-10 items-center bg-brand-navy px-4 text-[14px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540] sm:inline-flex"
            >
              {CTA_TEXT}
            </Link>
          </div>
        </div>
      </header>

      {/* ----------------------------------------------------------------- Hero */}
      <section className="border-b border-brand-navy/10">
        <div className={cn(container, 'grid items-end gap-10 pt-10 sm:pt-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-6 lg:pt-16')}>
          <div className="pb-2 lg:pb-20">
            {ownerConfig.googlePartner && (
              <p className="inline-flex items-center gap-2 border border-brand-navy/25 px-3 py-1.5 text-[13px] font-semibold text-brand-navy">
                <span className="h-2 w-2 bg-brand-signal" aria-hidden />
                شريك قوقل المعتمد
              </p>
            )}

            <h1 className="mt-5 font-display text-[2.45rem] font-semibold leading-[1.25] text-brand-navy sm:text-[3.4rem] lg:text-[4rem]">
              كم تضيع من فلوسك في إعلانات قوقل؟
              <br />
              مُضاعِف يوريك وينها بالريال.
            </h1>

            <p className="mt-6 max-w-[34rem] text-[17px] leading-8 text-brand-navy/80 sm:text-[18px] sm:leading-9">
              وما يتغير شي في حسابك إلا لما تضغط اعتمد.
            </p>

            <div id="hero-cta" className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="inline-flex h-14 items-center bg-brand-navy px-7 text-[16px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540]"
              >
                {CTA_TEXT}
              </Link>
              <a
                href={WHATSAPP_GENERAL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-14 items-center gap-2 border border-brand-navy/25 px-5 text-[15px] font-semibold transition-colors hover:border-brand-navy"
              >
                <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
                اسألني على الواتساب
              </a>
            </div>
            <p className="mt-4 max-w-[34rem] text-[13.5px] leading-6 text-brand-slate">
              الفحص الأول وإعادته مجاناً، وما يحتاج بطاقة. رقم الهدر تقدير من أرقام آخر 30 يوم في حسابك، مو وعد.
            </p>
            {auditedAccounts !== null && (
              <p className="mt-3 flex items-center gap-2 text-[14px] font-semibold text-brand-navy">
                <span className="h-2 w-2 flex-shrink-0 bg-brand-signal" aria-hidden />
                <span>
                  فحصنا{' '}
                  <span dir="ltr" className="font-numeric">
                    {auditedAccounts.toLocaleString('en-US')}
                  </span>{' '}
                  حساب إعلانات قوقل لين الحين.
                </span>
              </p>
            )}
          </div>

          <div className="relative mx-auto w-full max-w-[30rem] lg:max-w-none">
            <Image
              src="/landing/ayman-portrait-thobe.jpg"
              alt="أيمن أمين، مؤسس مُضاعِف، بالثوب والشماغ وجواله في يده"
              width={896}
              height={1200}
              priority
              sizes="(min-width: 1024px) 40vw, (min-width: 640px) 30rem, 100vw"
              className="block h-auto w-full"
            />
            <div className="relative z-10 -mt-24 px-3 sm:px-6 lg:absolute lg:-bottom-14 lg:-start-28 lg:mt-0 lg:px-0">
              <PlanDemo />
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- Who is behind it */}
      <section aria-label="مين وراه" className="border-b border-brand-navy/10 bg-white">
        <div className={cn(container, 'flex flex-wrap items-center gap-x-5 gap-y-3 py-5')}>
          <Image
            src={ownerConfig.founderPhoto ?? '/landing/ayman-avatar-thobe.jpg'}
            alt="أيمن أمين"
            width={48}
            height={48}
            className="h-12 w-12 flex-shrink-0 object-cover"
          />
          <p className="min-w-0 flex-1 basis-[16rem] text-[14.5px] leading-7 text-brand-navy/85">
            المنصة مبنية من فريق وكالة مُضاعفة، اللي يدير حسابات قوقل كل يوم.{' '}
            <span className="font-bold text-brand-navy">أيمن أمين</span>
            {ownerConfig.founderHandle && (
              <>
                {' '}
                ·{' '}
                {ownerConfig.founderProfileUrl ? (
                  <a
                    href={ownerConfig.founderProfileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    dir="ltr"
                    className="font-numeric underline underline-offset-4"
                  >
                    {ownerConfig.founderHandle}
                  </a>
                ) : (
                  <span dir="ltr" className="font-numeric">
                    {ownerConfig.founderHandle}
                  </span>
                )}
              </>
            )}
          </p>
        </div>
      </section>

      {/* -------------------------------------------- Guarantee (hidden until set) */}
      {ownerConfig.guarantee && (
        <section aria-label="الضمان" className="border-b border-brand-navy/10 py-10 sm:py-14">
          <div className={cn(container, 'grid gap-4 lg:grid-cols-[minmax(0,0.5fr)_minmax(0,1.5fr)] lg:gap-14')}>
            <h2 className="font-display text-[1.6rem] font-semibold leading-[1.35] sm:text-[2rem]">الضمان</h2>
            <div>
              <p className="max-w-[40rem] text-[17px] leading-9 text-brand-navy/90">{ownerConfig.guarantee.text}</p>
              <Link href="/refund" className="mt-4 inline-flex min-h-10 items-center text-[14.5px] font-semibold underline underline-offset-4">
                اقرأ سياسة الاسترداد كاملة
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- A normal day */}
      <section className="bg-brand-navy py-20 text-brand-paper sm:py-28">
        <div className={container}>
          <h2 className="max-w-[44rem] font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.75rem]">
            الإعلان ما يخرب فجأة. يخرب كل يوم شوي، وأنت مشغول بشغلك.
          </h2>
          <ul className="mt-8 max-w-[40rem] divide-y divide-brand-paper/15 border-y border-brand-paper/15">
            {painLines.map((line) => (
              <li key={line} className="py-4 text-[17px] leading-8 sm:text-[18px]">
                «{line}»
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-[38rem] text-[16px] leading-8 text-brand-paper/70">
            وهذا يوم تمثيلي في حساب متجر عطور، ما أحد فتحه من أسبوع. ولا وحدة من الأربع تطلّع لك تنبيه.
          </p>

          <div className="mt-12">
            <DayLeaks />
          </div>

          <p className="mt-12 max-w-[40rem] text-[20px] font-semibold leading-9 sm:text-[22px]">
            كلها تنكشف بس لما أحد يقرا الأرقام. مُضاعِف يقراها كل يوم، وهو في صفك: يقولك وش تسوي، والقرار لك.
          </p>
        </div>
      </section>

      {/* -------------------------------------------------------- How it works */}
      <section id="how" className="scroll-mt-16 py-14 sm:py-28">
        <div className={container}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
            <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">من الربط إلى أول قرار في نفس اليوم</h2>
            <p className="max-w-[28rem] text-[16px] leading-8 text-brand-slate lg:justify-self-end">
              ما تحتاج تفهم في الإعلانات عشان تستخدمه. تحتاج تقرا السبب وتقرر.
            </p>
          </div>

          <div className="mt-14 sm:mt-16">
            <FlowDiagram />
          </div>

          {ownerConfig.reportSample ? (
            <ReportSampleBlock sample={ownerConfig.reportSample} />
          ) : (
            <div className="mt-20 grid grid-cols-[minmax(0,1fr)] gap-10 lg:mt-24 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,1.38fr)] lg:items-center lg:gap-14">
              <div>
                <h3 className="font-display text-[1.6rem] font-semibold leading-[1.35] sm:text-[1.9rem]">وهذي الشاشة اللي تفتحها الصبح</h3>
                <p className="mt-4 max-w-[24rem] text-[15.5px] leading-8 text-brand-slate">
                  خطة اليوم داخل المنصة. أهم قرار فوق، وكل قرار مكتوب جنبه وش يغيّر وليه. وإذا التتبع خربان، يطلع أول شي قبل أي
                  قرار ميزانية.
                </p>
              </div>
              <PlanScreen />
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------- What it can change */}
      <section className="border-y border-brand-navy/10 bg-white py-14 sm:py-28">
        <div className={container}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
            <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">ست حركات بس. وكل وحدة لها شرط.</h2>
            <p className="max-w-[30rem] text-[16px] leading-8 text-brand-slate lg:justify-self-end">
              ما يجرّب في حسابك ولا يقلب الحملات. هذي كل التعديلات اللي يقدر يقترحها، والشرط اللي لازم تحققه الأرقام قبل ما
              يقترح أي وحدة.
            </p>
          </div>

          <ul className="mt-12 grid gap-px border border-brand-navy/15 bg-brand-navy/15 md:grid-cols-2 lg:grid-cols-3">
            {moves.map((move) => (
              <li key={move.kind} className="flex flex-col bg-white">
                <div className="hidden h-[11.5rem] border-b border-brand-navy/10 bg-brand-paper/70 p-5 md:block">
                  <MoveVisual kind={move.kind} />
                </div>
                <div className="p-5 md:p-6">
                  <h3 className="text-[18px] font-bold leading-8">{move.name}</h3>
                  <p className="mt-1 text-[15px] leading-7 text-brand-slate">{move.rule}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px] text-brand-slate">الرسوم توضيحية بأرقام تمثيلية. الشروط تحتها هي المكتوبة في النظام.</p>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <p className="border-s-2 border-brand-signal ps-5 text-[15.5px] leading-8">
              <span className="font-bold">التتبع أول.</span> إذا تتبع التحويلات في حسابك خربان، يقولك هذا قبل أي شي، وما يبني قرار
              ميزانية على أرقام غلط.
            </p>
            <p className="border-s-2 border-brand-signal ps-5 text-[15.5px] leading-8">
              <span className="font-bold">يعرف موسمك.</span> رمضان واليوم الوطني وأسبوع الرواتب في الحسبة، فما يعاقب حملة على
              نزول كان متوقع.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- Limits */}
      <section id="limits" className="scroll-mt-16 bg-brand-navy py-20 text-brand-paper sm:py-28">
        <div className={cn(container, 'grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20')}>
          <div>
            <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">القرار بيدك، والحدود مكتوبة في النظام نفسه.</h2>
            <p className="mt-5 max-w-[28rem] text-[16px] leading-8 text-brand-paper/70">
              حتى لو اعتمدت كل شي بدون ما تقرا، فيه حدود ما يتعداها. حطيناها لأن أكثر شي يخوّف في أدوات الإعلانات هو الضغطة اللي
              تقلب الحساب.
            </p>
            <p className="mt-8 max-w-[28rem] border-t border-brand-paper/15 pt-6 text-[14.5px] leading-7 text-brand-paper/70">
              الصلاحية من شاشة قوقل الرسمية ونطاقها إعلانات قوقل بس. ما نشوف كلمة مرورك، ورمز الوصول محفوظ مشفّر، وتسحبه من حساب
              قوقل متى ما بغيت.
            </p>
          </div>

          <ul className="border-t border-brand-paper/30">
            {limits.map((limit) => (
              <li
                key={limit.kind}
                className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-5 gap-y-5 border-b border-brand-paper/15 py-7 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
              >
                <span className="flex items-baseline gap-1.5">
                  <span dir="ltr" className="font-numeric text-[2.1rem] font-medium leading-none sm:text-[2.6rem]">
                    {limit.value}
                  </span>
                  <span className="text-[13px] text-brand-paper/60">{limit.unit}</span>
                </span>
                <p className="text-[16px] leading-8">{limit.text}</p>
                <div className="col-span-2 hidden sm:col-span-1 sm:col-start-2 sm:block">
                  <LimitVisual kind={limit.kind} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------ Founder letter */}
      <section id="ayman" className="scroll-mt-16 py-14 sm:py-28">
        <div className={cn(container, 'grid items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-20')}>
          <div className="order-2 lg:order-1">
            <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">ليش بنيت مُضاعِف</h2>
            <div className="mt-8 max-w-[36rem] space-y-5 text-[17px] leading-9 text-brand-navy/85">
              <p>
                أنا أيمن أمين. أدير إعلانات قوقل لعملاء وكالة مُضاعفة: عيادة أسنان، ومعرض مراتب، وشركة أبواب، ومسابح. وقبل مُضاعفة
                اشتغلت في تشويش على استراتيجية الإعلانات.
              </p>
              <p>
                أكثر شي تعلمته من هالحسابات إن الخسارة نادراً تجي من حملة غلط من أولها. تجي من حساب ما أحد يفتحه كل يوم. صاحب
                المحل ما عنده وقت، والوكالة مكلفة على أغلب الناس.
              </p>
              <p>
                فبنيت مُضاعِف يسوي القراءة اليومية اللي أسويها أنا: يمسك الأرقام، ويطلّع القرار، ويكتب لك السبب بكلام تفهمه.
                والقرار الأخير يبقى عندك، لأني ما أرضى أحد يحرك فلوس عميلي بدون ما يشوفها، فما أرضاها لك.
              </p>
              <p>واعرف إنه للحين يشتغل على قوقل بس. ميتا وتيك توك وسناب مو فيه، وما أبي أوعدك بشي ما انبنى.</p>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
              <div>
                <p className="font-display text-[1.6rem] font-semibold leading-none">أيمن أمين</p>
                <p className="mt-2 text-[13.5px] text-brand-slate">مؤسس وكالة مُضاعفة ومنصة مُضاعِف</p>
              </div>
              <a
                href={WHATSAPP_GENERAL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-12 items-center gap-2 border border-brand-navy px-5 text-[15px] font-semibold transition-colors hover:bg-brand-navy hover:text-brand-paper"
              >
                <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
                كلّمني على الواتساب
              </a>
            </div>
          </div>

          <div className="order-1 lg:order-2">
            <Image
              src="/landing/ayman-desk-thobe.jpg"
              alt="أيمن أمين على مكتبه الصبح"
              width={720}
              height={900}
              sizes="(min-width: 1024px) 34vw, 100vw"
              className="mx-auto block h-auto w-full max-w-[28rem] lg:max-w-none"
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------- Testimonials (hidden until real) */}
      {ownerConfig.testimonials.length > 0 && (
        <section aria-label="تجارب عملاء" className="border-t border-brand-navy/10 py-14 sm:py-24">
          <div className={container}>
            <h2 className="font-display text-[1.8rem] font-semibold leading-[1.35] sm:text-[2.2rem]">وش صار عند غيرك</h2>
            <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {ownerConfig.testimonials.map((t) => (
                <li key={`${t.name}-${t.business}`} className="flex flex-col border border-brand-navy/20 bg-white p-6">
                  <p className="text-[17px] font-bold leading-8">
                    من {t.before} إلى {t.after} خلال {t.period}
                  </p>
                  <p className="mt-auto pt-5 text-[14px] leading-6 text-brand-slate">
                    <span className="font-semibold text-brand-navy">{t.name}</span>، {t.business}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------------- Fit */}
      <section className="border-y border-brand-navy/10 bg-white py-16 sm:py-20">
        <div className={cn(container, 'grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20')}>
          <h2 className="font-display text-[1.8rem] font-semibold leading-[1.35] sm:text-[2.2rem]">لمين هو، ووش ما يسويه</h2>
          <ul className="space-y-5 text-[16px] leading-8">
            <li className="flex gap-3">
              <span className="mt-3 h-2 w-2 flex-shrink-0 bg-brand-navy" aria-hidden />
              <span>ما يصمم لك صور ولا فيديوهات إعلانية. شغله قراءة الحساب وتحسينه.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-3 h-2 w-2 flex-shrink-0 bg-brand-navy" aria-hidden />
              <span>ما يضمن لك مبيعات. يقرا حسابك ويقترح، أما المنتج والسعر وصفحة البيع فعليك.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-3 h-2 w-2 flex-shrink-0 bg-brand-navy" aria-hidden />
              <span>ما ينفّذ شي من نفسه. لو تبي أداة تشتغل في حسابك وأنت ما تشوف، هذا مو لك.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-3 h-2 w-2 flex-shrink-0 bg-brand-signal" aria-hidden />
              <span>
                يحتاج حساب إعلانات قوقل. ما عندك؟{' '}
                <a
                  href={WHATSAPP_NO_ACCOUNT}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline decoration-brand-signal decoration-2 underline-offset-[6px]"
                >
                  نفتحه لك مجاناً على الواتساب
                </a>
                .
              </span>
            </li>
          </ul>
        </div>

        <div className={cn(container, 'mt-12 grid gap-4 md:grid-cols-2')}>
          <article className="flex flex-col border border-brand-navy p-6 sm:p-8">
            <h3 className="font-display text-[1.5rem] font-semibold leading-[1.35]">سوها بنفسك</h3>
            <p className="mt-3 flex-1 text-[15.5px] leading-8 text-brand-navy/80">
              تربط حسابك، وتقرا خطة اليوم، وتعتمد اللي يعجبك. المنصة تبدأ من {plans[0].monthlyPrice.toLocaleString('en-US')} ريال في الشهر،
              والفحص الأول مجاني.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex h-12 items-center justify-center bg-brand-navy px-6 text-[15px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540]"
            >
              {CTA_TEXT}
            </Link>
          </article>
          <article className="flex flex-col border border-brand-navy/20 bg-white p-6 sm:p-8">
            <h3 className="font-display text-[1.5rem] font-semibold leading-[1.35]">خل فريق مُضاعفة يديرها عنك</h3>
            <p className="mt-3 flex-1 text-[15.5px] leading-8 text-brand-navy/80">
              إذا ما عندك وقت ولا تبي تدخل الحساب بنفسك، الفريق اللي بنى المنصة يدير إعلاناتك بدالك.
            </p>
            <a
              href="https://modaafa.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex h-12 items-center justify-center gap-2 border border-brand-navy px-6 text-[15px] font-bold text-brand-navy transition-colors hover:bg-brand-navy hover:text-brand-paper"
            >
              تعرّف على إدارة الفريق
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </a>
          </article>
        </div>
      </section>

      {/* ------------------------------------------------------------ Pricing */}
      <section id="pricing" className="scroll-mt-16 py-14 sm:py-28">
        <div className={container}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">ابدأ بالفحص. والاشتراك لما تبي تنفّذ.</h2>
              <p className="mt-4 max-w-[36rem] text-[15.5px] leading-8 text-brand-slate">
                الأسعار بالريال قبل الضريبة. واللي ما جرب قبل ياخذ 14 يوم تجربة لما يبدأ التنفيذ، ويلغي قبل أول خصم.
              </p>
            </div>
            <div className="inline-flex w-fit border border-brand-navy/25 p-1 text-[14px]" role="group" aria-label="فترة الفوترة">
              {(['monthly', 'yearly'] as const).map((key) => (
                <Link
                  key={key}
                  href={`/?period=${key}#pricing`}
                  scroll={false}
                  aria-current={period === key ? 'true' : undefined}
                  className={cn(
                    'px-5 py-2 font-semibold transition-colors',
                    period === key ? 'bg-brand-navy text-brand-paper' : 'text-brand-slate hover:text-brand-navy'
                  )}
                >
                  {key === 'monthly' ? 'شهري' : 'سنوي'}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-4 border border-brand-navy p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div>
              <p className="text-[19px] font-bold">{ownerConfig.freeAuditName ?? 'الفحص المجاني'}</p>
              <p className="mt-1 text-[15px] leading-7 text-brand-slate">
                فحص كامل لحسابك وإعادة فحص وحدة بعده، وتقرا كل التوصيات. بدون بطاقة وبدون اشتراك.
              </p>
              {ownerConfig.agencyAnalysisValueSar !== null && (
                <p className="mt-2 text-[14.5px] leading-7 text-brand-navy">
                  تحليل حساب بنفس العمق عند الوكالة قيمته{' '}
                  <span dir="ltr" className="font-numeric font-semibold">
                    {ownerConfig.agencyAnalysisValueSar.toLocaleString('en-US')}
                  </span>{' '}
                  ريال.
                </p>
              )}
            </div>
            <Link
              href="/login"
              className="inline-flex h-12 flex-shrink-0 items-center justify-center bg-brand-navy px-6 text-[15px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540]"
            >
              {CTA_TEXT}
            </Link>
          </div>

          {(ownerConfig.comparison.mediaBuyerSalarySar !== null || ownerConfig.comparison.agencyFeeSar !== null) && (
            <dl className="mt-4 grid gap-px border border-brand-navy/15 bg-brand-navy/15 text-[15px] sm:grid-cols-3">
              {ownerConfig.comparison.mediaBuyerSalarySar !== null && (
                <div className="bg-white p-5">
                  <dt className="text-brand-slate">راتب ميديا باير في الشهر</dt>
                  <dd className="mt-1 font-bold">
                    <span dir="ltr" className="font-numeric text-[1.5rem] font-medium">
                      {ownerConfig.comparison.mediaBuyerSalarySar.toLocaleString('en-US')}
                    </span>{' '}
                    ريال
                  </dd>
                </div>
              )}
              {ownerConfig.comparison.agencyFeeSar !== null && (
                <div className="bg-white p-5">
                  <dt className="text-brand-slate">رسوم وكالة في الشهر</dt>
                  <dd className="mt-1 font-bold">
                    <span dir="ltr" className="font-numeric text-[1.5rem] font-medium">
                      {ownerConfig.comparison.agencyFeeSar.toLocaleString('en-US')}
                    </span>{' '}
                    ريال
                  </dd>
                </div>
              )}
              <div className="bg-brand-navy p-5 text-brand-paper">
                <dt className="text-brand-paper/70">مُضاعِف، من</dt>
                <dd className="mt-1 font-bold">
                  <span dir="ltr" className="font-numeric text-[1.5rem] font-medium">
                    {plans[0].monthlyPrice.toLocaleString('en-US')}
                  </span>{' '}
                  ريال
                </dd>
              </div>
            </dl>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {plans.map((plan) => {
              const livePrice = priceAmounts?.[plan.id]?.[period] ?? null;
              const displayAmount = livePrice?.amount ?? (period === 'monthly' ? plan.monthlyPrice : null);
              const displayCurrency = (livePrice?.currency ?? 'sar').toUpperCase();
              const monthlyAmount = priceAmounts?.[plan.id]?.monthly?.amount ?? plan.monthlyPrice;
              const yearlySavings =
                period === 'yearly' && livePrice && displayCurrency === 'SAR'
                  ? Math.max(0, monthlyAmount * 12 - livePrice.amount)
                  : 0;
              const dark = Boolean(plan.recommended);

              return (
                <article
                  key={plan.id}
                  className={cn(
                    'relative flex flex-col p-6 sm:p-7',
                    dark ? 'bg-brand-navy text-brand-paper' : 'border border-brand-navy/20 bg-white'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-[18px] font-bold">{plan.name}</h3>
                    {dark && (
                      <span className="flex items-center gap-1.5 text-[12.5px] text-brand-paper/80">
                        <span className="h-2 w-2 bg-brand-signal" aria-hidden />
                        أنصح فيها
                      </span>
                    )}
                  </div>
                  <p className={cn('mt-1 text-[14px] leading-6', dark ? 'text-brand-paper/65' : 'text-brand-slate')}>{plan.who}</p>
                  {ownerConfig.planAudience[plan.id as 'starter' | 'growth' | 'pro'] && (
                    <p className={cn('mt-2 text-[14px] font-semibold leading-6', dark ? 'text-brand-paper' : 'text-brand-navy')}>
                      {ownerConfig.planAudience[plan.id as 'starter' | 'growth' | 'pro']}
                    </p>
                  )}

                  <div className="mt-6 flex min-h-12 items-baseline gap-2">
                    {displayAmount !== null ? (
                      <>
                        {displayCurrency === 'SAR' ? (
                          <span className="flex items-baseline gap-1.5">
                            <span dir="ltr" className="font-numeric text-[2.4rem] font-medium leading-none">
                              {displayAmount.toLocaleString('en-US')}
                            </span>
                            <span className="text-[15px] font-semibold">ريال</span>
                          </span>
                        ) : (
                          <span className="font-numeric text-[2.4rem] font-medium leading-none">
                            {formatCurrency(displayAmount, displayCurrency)}
                          </span>
                        )}
                        <span className={cn('text-[14px]', dark ? 'text-brand-paper/65' : 'text-brand-slate')}>
                          / {period === 'yearly' ? 'سنة' : 'شهر'}
                        </span>
                      </>
                    ) : (
                      <span className={cn('text-[14px] font-semibold leading-6', dark ? 'text-brand-paper/65' : 'text-brand-slate')}>
                        السعر السنوي النهائي يطلع في صفحة الدفع
                      </span>
                    )}
                  </div>
                  {yearlySavings > 0 && (
                    <p className={cn('mt-2 text-[13px] font-semibold', dark ? 'text-brand-signal' : 'text-success')}>
                      توفّر {formatCurrency(yearlySavings, 'SAR')} عن الدفع الشهري
                    </p>
                  )}

                  <ul className={cn('mt-6 flex-1 space-y-2.5 border-t pt-5', dark ? 'border-brand-paper/20' : 'border-brand-navy/15')}>
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5 text-[14px] leading-6">
                        <span className={cn('mt-2.5 h-1.5 w-1.5 flex-shrink-0', dark ? 'bg-brand-paper' : 'bg-brand-navy')} aria-hidden />
                        {feature}
                      </li>
                    ))}
                  </ul>

                  {/* Carry the chosen plan and period through login so the user
                      lands on the matching billing choice. */}
                  <Link
                    href={`/login?next=${encodeURIComponent(`/billing?plan=${plan.id}&period=${period}`)}`}
                    className={cn(
                      'mt-7 inline-flex h-12 items-center justify-center text-[15px] font-bold transition-colors',
                      dark
                        ? 'bg-brand-paper text-brand-navy hover:bg-white'
                        : 'border border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-brand-paper'
                    )}
                  >
                    ابدأ بخطة {plan.name}
                  </Link>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- FAQ */}
      <section id="faq" className="scroll-mt-16 border-t border-brand-navy/10 bg-white py-14 sm:py-28">
        <div className={cn(container, 'grid gap-10 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-20')}>
          <div>
            <h2 className="font-display text-[2rem] font-semibold leading-[1.3] sm:text-[2.6rem]">أسئلة قبل ما تربط حسابك</h2>
            <p className="mt-4 max-w-[22rem] text-[15.5px] leading-8 text-brand-slate">
              سؤالك مو هنا؟{' '}
              <a href={WHATSAPP_GENERAL} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-navy underline underline-offset-4">
                اسألني على الواتساب
              </a>
            </p>
          </div>

          <div className="border-t border-brand-navy">
            {faq.map((item) => (
              <details key={item.q} className="group border-b border-brand-navy/15">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 py-4 text-[16.5px] font-bold [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <ChevronDown className="h-5 w-5 flex-shrink-0 text-brand-slate transition-transform duration-200 group-open:rotate-180" aria-hidden />
                </summary>
                <p className="max-w-[44rem] pb-6 text-[15.5px] leading-8 text-brand-navy/80">
                  {item.a}
                  {item.cta && (
                    <Link
                      href="/login"
                      className="mt-5 flex h-12 w-fit items-center bg-brand-navy px-6 text-[15px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540]"
                    >
                      {CTA_TEXT}
                    </Link>
                  )}
                  {item.whatsapp && (
                    <>
                      {' '}
                      <a
                        href={WHATSAPP_NO_ACCOUNT}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-brand-navy underline underline-offset-4"
                      >
                        افتح محادثة واتساب
                      </a>
                    </>
                  )}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Final CTA */}
      <section className="bg-brand-navy py-20 text-brand-paper sm:py-24">
        <div className={cn(container, 'flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between')}>
          <div className="flex items-start gap-5">
            <Image
              src="/landing/ayman-avatar-thobe.jpg"
              alt=""
              width={80}
              height={80}
              className="hidden h-20 w-20 flex-shrink-0 object-cover sm:block"
            />
            <div>
              <h2 className="max-w-[36rem] font-display text-[1.9rem] font-semibold leading-[1.35] sm:text-[2.4rem]">
                حسابك يصرف الحين، وأنت تقرا هالصفحة.
              </h2>
              <p className="mt-4 max-w-[34rem] text-[16px] leading-8 text-brand-paper/70">
                اربطه وخل مُضاعِف يقرا آخر 30 يوم. الفحص مجاني، وما يتغير شي في حسابك إلا لو اعتمدت.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/login"
              className="inline-flex h-14 items-center bg-brand-paper px-7 text-[16px] font-bold text-brand-navy transition-colors hover:bg-white"
            >
              {CTA_TEXT}
            </Link>
            <a
              href={WHATSAPP_GENERAL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-14 items-center gap-2 border border-brand-paper/40 px-5 text-[15px] font-semibold transition-colors hover:border-brand-paper"
            >
              <MessageCircle className="h-[18px] w-[18px]" aria-hidden />
              واتساب
            </a>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="pb-28 pt-10 lg:pb-10">
        <div className={cn(container, 'flex flex-col gap-6 text-[13.5px] text-brand-slate lg:flex-row lg:items-center lg:justify-between')}>
          <div className="flex items-start gap-3">
            <Image src="/brand/modaafa-symbol-primary.svg" alt="" width={24} height={24} className="mt-0.5 h-6 w-6" />
            <p className="leading-7">
              © 2026 مُضاعِف. منصة من مؤسسة تقنيات أيمن للتسويق الإلكتروني، الرقم الموحد{' '}
              <span dir="ltr" className="font-numeric">
                7038156571
              </span>
            </p>
          </div>
          <div className="-mx-2 flex flex-wrap gap-x-1">
            <Link href="/privacy" className="inline-flex min-h-10 items-center px-2 transition-colors hover:text-brand-navy">
              الخصوصية
            </Link>
            <Link href="/terms" className="inline-flex min-h-10 items-center px-2 transition-colors hover:text-brand-navy">
              الشروط
            </Link>
            <Link href="/refund" className="inline-flex min-h-10 items-center px-2 transition-colors hover:text-brand-navy">
              الاسترداد
            </Link>
            <Link href="/data-deletion" className="inline-flex min-h-10 items-center px-2 transition-colors hover:text-brand-navy">
              حذف البيانات
            </Link>
            <a
              href={ownerConfig.supportEmail ? `mailto:${ownerConfig.supportEmail}` : WHATSAPP_GENERAL}
              {...(ownerConfig.supportEmail ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
              className="inline-flex min-h-10 items-center px-2 transition-colors hover:text-brand-navy"
            >
              الدعم
            </a>
          </div>
        </div>
      </footer>

      <StickyCta watchId="hero-cta" whatsappHref={WHATSAPP_GENERAL} />
    </main>
  );
}

/** A real audit report, shown only when the owner supplies one in owner-config. */
function ReportSampleBlock({ sample }: { sample: NonNullable<typeof ownerConfig.reportSample> }) {
  return (
    <div className="mt-14 grid gap-8 lg:mt-20 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:items-center lg:gap-14">
      <div>
        <h3 className="font-display text-[1.6rem] font-semibold leading-[1.35] sm:text-[1.9rem]">
          {ownerConfig.freeAuditName ?? 'الفحص المجاني'}: هذا تقرير حقيقي
        </h3>
        <p className="mt-4 max-w-[26rem] text-[15.5px] leading-8 text-brand-slate">
          من حساب {sample.accountLabel}، كما طلع من الفحص بدون تعديل. تحت كل رقم نسبة تغطية البيانات، عشان تعرف كم من الحساب انقرا فعلاً.
        </p>
      </div>
      <article className="border border-brand-navy bg-white p-5 sm:p-7">
        <dl className="grid grid-cols-3 gap-px border border-brand-navy/15 bg-brand-navy/15 text-center">
          <div className="bg-white p-3 sm:p-4">
            <dt className="text-[12.5px] text-brand-slate">صحة الحساب</dt>
            <dd dir="ltr" className="mt-1 font-numeric text-[1.6rem] font-medium leading-none sm:text-[2rem]">
              {sample.healthScore}/100
            </dd>
          </div>
          <div className="bg-white p-3 sm:p-4">
            <dt className="text-[12.5px] text-brand-slate">هدر شهري متوقع</dt>
            <dd className="mt-1 font-numeric text-[1.6rem] font-medium leading-none sm:text-[2rem]">
              <span dir="ltr">{sample.estimatedWasteSar.toLocaleString('en-US')}</span>
              <span className="ms-1 text-[13px] font-semibold">ريال</span>
            </dd>
          </div>
          <div className="bg-white p-3 sm:p-4">
            <dt className="text-[12.5px] text-brand-slate">تغطية البيانات</dt>
            <dd dir="ltr" className="mt-1 font-numeric text-[1.6rem] font-medium leading-none sm:text-[2rem]">
              {sample.coveragePct}%
            </dd>
          </div>
        </dl>
        {sample.findings.length > 0 && (
          <ul className="mt-5 divide-y divide-brand-navy/10 border-t border-brand-navy/15">
            {sample.findings.slice(0, 3).map((finding) => (
              <li key={finding} className="py-3 text-[15px] leading-7">
                {finding}
              </li>
            ))}
          </ul>
        )}
      </article>
    </div>
  );
}

/** Organization, founder and FAQ markup so search and answer engines can cite the page. */
function StructuredData({ nonce }: { nonce?: string }) {
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': 'https://ai.modaafa.com/#app',
        name: 'مُضاعِف',
        alternateName: 'Modaafa Ads AI',
        url: 'https://ai.modaafa.com/',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: 'ar',
        description:
          'منصة عربية تقرا حساب إعلانات قوقل وتجهّز خطة يومية بالأسباب، ولا تنفّذ أي تعديل إلا بعد موافقة صاحب الحساب، مع تراجع خلال 30 يوماً.',
        offers: plans.map((plan) => ({
          '@type': 'Offer',
          name: plan.name,
          price: plan.monthlyPrice,
          priceCurrency: 'SAR',
        })),
        creator: { '@id': 'https://ai.modaafa.com/#ayman' },
        publisher: { '@id': 'https://ai.modaafa.com/#org' },
      },
      {
        '@type': 'Person',
        '@id': 'https://ai.modaafa.com/#ayman',
        name: 'أيمن أمين',
        alternateName: 'Ayman Amin',
        jobTitle: 'مؤسس وكالة مُضاعفة ومنصة مُضاعِف',
        image: 'https://ai.modaafa.com/landing/ayman-portrait-thobe.jpg',
        worksFor: { '@id': 'https://ai.modaafa.com/#org' },
      },
      {
        '@type': 'Organization',
        '@id': 'https://ai.modaafa.com/#org',
        name: 'مُضاعفة',
        legalName: 'مؤسسة تقنيات أيمن للتسويق الإلكتروني',
        url: 'https://modaafa.com/',
        logo: 'https://ai.modaafa.com/brand/png/modaafa-symbol-primary-1024.png',
        founder: { '@id': 'https://ai.modaafa.com/#ayman' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // JSON.stringify output contains no `</script>` sequence for this static data.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
