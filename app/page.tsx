import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Layers,
  MessageCircle,
  ScanSearch,
  ShieldCheck,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { getPlanPriceAmounts, type PeriodKey, type PlanKey } from '@/lib/billing/stripe';
import { cn, formatCurrency } from '@/lib/utils';
import { Reveal } from './reveal';
import { HeroVideo } from './hero-video';
import { LogoLockup, LogoMark } from '@/lib/ui/logo';

const trustPoints = [
  'موافقة واضحة قبل أي تعديل',
  'تحقق مسبق على Google',
  'سجل تراجع لكل إجراء',
  'تشفير رموز الوصول',
];

const flow = [
  { title: 'سجّل بحساب Google', desc: 'دخول واحد بالبريد الذي يدير إعلاناتك.' },
  { title: 'اربط Google Ads', desc: 'موافقة واحدة تسحب كل حساباتك.' },
  { title: 'اختر الحساب', desc: 'بدّل بين الحسابات من مبدّل واحد.' },
  { title: 'افحص واسأل', desc: 'الفحص يرتب الأولويات والمساعد يجيب عن أي حملة.' },
  { title: 'اعتمد التوصيات', desc: 'لا يتغير شيء قبل ضغطك على تنفيذ.' },
];

const featureLead = {
  icon: ShieldCheck,
  title: 'لا ينفّذ قبل موافقتك',
  body: 'كل تغيير مؤثر يمر عبر مركز الموافقات. ترى الحملة المستهدفة والقيمة الجديدة، ثم تعتمد أو تتجاهل. وبعد التنفيذ يبقى سجل تراجع للإجراء.',
};

const features = [
  {
    icon: Layers,
    title: 'كل حساباتك بموافقة واحدة',
    body: 'حسابك المباشر وكل حساب عميل تحت MCC، وتبدّل بينها دون إعادة ربط.',
  },
  {
    icon: ScanSearch,
    title: 'يقرأ قبل أن يقترح',
    body: 'الصرف والتحويلات وصحة الحساب والتوصيات المفتوحة، من بيانات حسابك أنت.',
  },
  {
    icon: MessageCircle,
    title: 'مساعد بلغة الميديا باير',
    body: 'اسأله عن أداء حملة، أو اطلب مسودة حملة جديدة بالعربي.',
  },
  {
    icon: Type,
    title: 'عربي من الأساس',
    body: 'واجهة RTL وأرقام لاتينية، ومصطلحات Google Ads تبقى بالإنجليزي كما تراها في حسابك.',
  },
];

const audience = [
  { title: 'أصحاب الأنشطة', body: 'تتابع صرفك ونتائجك وتفهم كل توصية بدون مصطلحات معقدة.' },
  { title: 'الميديا باير', body: 'الفحص والتوصيات جاهزة، فيبقى وقتك للقرارات.' },
  { title: 'الوكالات', body: 'حسابات عملائك تحت MCC في مكان واحد منظّم.' },
];

// Feature lists mirror lib/billing/entitlements PLAN_LIMITS. The marketing page
// used to show only a price and one line, so a visitor learned LESS here than
// on the billing page they could not reach without signing up.
const plans = [
  {
    id: 'starter' as PlanKey,
    name: 'البداية',
    monthlyPrice: 500,
    limit: 'للبداية وإدارة العمل اليومي',
    features: ['20 محادثة ذكية يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً', '3 تنفيذات معتمدة يومياً'],
  },
  {
    id: 'growth' as PlanKey,
    name: 'النمو',
    monthlyPrice: 1200,
    limit: 'للشركات النشطة والمتابعة اليومية',
    features: ['100 محادثة ذكية يومياً', '7 فحوصات أسبوعياً', '20 مزامنة يدوية يومياً', '20 تنفيذاً معتمداً يومياً'],
    highlighted: true,
  },
  {
    id: 'pro' as PlanKey,
    name: 'الاحتراف',
    monthlyPrice: 2500,
    limit: 'للوكالات والاستخدام المكثف',
    features: ['500 محادثة ذكية يومياً', '70 فحصاً أسبوعياً', '100 مزامنة يومياً', '100 تنفيذ معتمد يومياً'],
  },
];

const faq = [
  {
    q: 'هل يعدّل المساعد حساباتي تلقائياً؟',
    a: 'لا. كل تعديل مؤثر يتحول إلى اقتراح داخل مركز الموافقات، ويعرض لك العملية والمورد المستهدف والقيمة الجديدة قبل التنفيذ. لا شيء يُطبَّق على Google Ads قبل أن تضغط «تنفيذ».',
  },
  {
    q: 'ما الصلاحية التي تطلبونها على حسابي؟',
    a: 'صلاحية Google Ads فقط (نطاق adwords) عبر شاشة موافقة Google الرسمية. لا نطلب كلمة مرورك، ونشفّر رمز الوصول في قاعدة البيانات. تستطيع سحب الصلاحية في أي وقت من إعدادات حساب Google أو بحذف حسابك لدينا.',
  },
  {
    q: 'هل التجربة تحتاج بطاقة؟',
    a: 'نعم، تُطلب بطاقة عند بدء التجربة عبر Stripe، ولا يُخصم منها شيء خلال 14 يوماً. أول خصم في اليوم الخامس عشر، وتستطيع الإلغاء قبله من زر «إلغاء الاشتراك» في صفحة الفوترة دون أي خصم. ونرسل لك تنبيهاً بالبريد قبل أول تجديد.',
  },
  {
    q: 'هل أستطيع إدارة أكثر من حساب إعلاني؟',
    a: 'نعم. موافقة واحدة تسحب حسابك المباشر وكل حساب عميل تحت أي حساب إداري (MCC) يملك بريدك صلاحية عليه، وتبدّل بينها من مبدّل الحسابات دون إعادة ربط.',
  },
  {
    q: 'ماذا يحدث لبياناتي إذا ألغيت؟',
    a: 'تستطيع حذف حسابك نهائياً من الإعدادات: نلغي الاشتراك، ونُبطل صلاحية Google، ثم نحذف بياناتك من قاعدة البيانات. الحذف يحتاج تأكيداً نصياً صريحاً حتى لا يقع بالخطأ.',
  },
  {
    q: 'الأسعار شاملة الضريبة؟',
    a: 'الأسعار المعروضة بالريال السعودي شهرياً قبل ضريبة القيمة المضافة. تظهر الضريبة في صفحة الدفع وفي فاتورتك.',
  },
];

const navLinkClasses =
  'px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodKey = params?.period === 'yearly' ? 'yearly' : 'monthly';
  const priceAmounts = await getPlanPriceAmounts();

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      <TikTokPixel pageView />
      {/* ---------------------------------------------------------------- Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <LogoLockup height={32} alt="مُضاعِف" priority />
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            <a href="#how" className={navLinkClasses}>
              كيف تعمل؟
            </a>
            <a href="#features" className={navLinkClasses}>
              المزايا
            </a>
            <a href="#pricing" className={navLinkClasses}>
              الأسعار
            </a>
            <a href="#faq" className={navLinkClasses}>
              أسئلة شائعة
            </a>
          </nav>

          <div className="flex flex-shrink-0 items-center gap-2">
            <ThemeToggle className="h-9 w-9" />
            <Link href="/login" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
              تسجيل الدخول
            </Link>
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------------- Hero */}
      <section className="border-b border-border">
        <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-24">
          <div className="max-w-4xl">
            <SectionLabel>ميديا باير لإعلانات Google</SectionLabel>

            <h1 className="mt-5 font-display text-[2.5rem] font-bold leading-[1.18] text-balance [word-spacing:0.18em] sm:text-display-lg lg:text-display-xl">
              يقرأ حسابك ويقترح
              <br />
              والقرار يبقى لك
            </h1>

            <p className="mt-6 max-w-xl text-[15px] leading-8 text-muted-foreground">
              تربط حساب Google Ads فيطلع لك المساعد بقائمة من الهدر والفرص. كل توصية تعرض الحملة المستهدفة
              والقيمة الجديدة قبل التنفيذ، وأنت من يعتمد أو يتجاهل.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/login" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ابدأ تجربة 14 يوماً
                <ArrowLeft className="h-4 w-4" aria-hidden />
              </Link>
              <a href="#how" className={buttonClasses({ variant: 'outline', size: 'lg' })}>
                شوف كيف تعمل
              </a>
            </div>

            <p className="mt-4 text-xs leading-6 text-muted-foreground">
              التجربة تطلب بطاقة عبر Stripe، ولا يُخصم منها شيء قبل اليوم الخامس عشر.
            </p>
          </div>

          <Reveal className="mt-12 sm:mt-16" delay={80}>
            <HeroVideo />
          </Reveal>

          <ul className="mt-8 flex w-full flex-wrap items-center gap-x-8 gap-y-2.5">
            {trustPoints.map((point) => (
              <li key={point} className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <span className="status-square text-foreground" aria-hidden />
                {point}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* --------------------------------------------------------------- Flow */}
      <section id="how" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <SectionLabel>كيف تعمل</SectionLabel>
          <h2 className="mt-3 max-w-2xl font-display text-display-sm font-bold text-balance [word-spacing:0.15em]">
            خمس خطوات من تسجيل الدخول إلى أول قرار معتمد
          </h2>

          <ol className="mt-10 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
            {flow.map((step, index) => (
              <li key={step.title} className="bg-card p-5 sm:p-6">
                <span className="font-numeric text-[1.75rem] font-medium leading-none text-border-strong">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-5 font-sans text-[14px] font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-[12.5px] leading-6 text-muted-foreground">{step.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ----------------------------------------------------------- Features */}
      <section id="features" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <SectionLabel>المزايا</SectionLabel>
          <h2 className="mt-3 max-w-2xl font-display text-display-sm font-bold text-balance [word-spacing:0.15em]">
            ما يفعله على حسابك الإعلاني فعلاً
          </h2>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            <Reveal
              as="article"
              className="flex flex-col justify-between bg-foreground p-7 text-background sm:p-9 lg:col-span-2"
            >
              <featureLead.icon className="h-6 w-6" aria-hidden />
              <div className="mt-10">
                <h3 className="font-display text-[1.625rem] font-bold leading-snug [word-spacing:0.15em]">
                  {featureLead.title}
                </h3>
                <p className="mt-3 max-w-xl text-[14.5px] leading-8 text-background/80">{featureLead.body}</p>
              </div>
            </Reveal>

            {features.slice(0, 1).map((item) => (
              <FeatureCard key={item.title} {...item} />
            ))}
            <div className="grid gap-4 sm:grid-cols-3 lg:col-span-3">
              {features.slice(1).map((item, index) => (
                <FeatureCard key={item.title} {...item} delay={index * 70} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------- Security + limitation */}
      <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionLabel>الأمان</SectionLabel>
            <h2 className="mt-3 font-display text-display-sm font-bold text-balance [word-spacing:0.15em]">
              لا تعديل على حسابك قبل موافقتك
            </h2>
            <p className="mt-4 max-w-xl text-[14px] leading-8 text-muted-foreground">
              المهام المجدولة تجهّز التوصيات فقط. أي تغيير فعلي على Google Ads يمر عبر مركز الموافقات، ويُتحقق
              منه على Google قبل تطبيقه، ويُحفظ له سجل تراجع.
            </p>
            <ul className="mt-6 space-y-2.5">
              {[
                'تحقق مسبق من العملية قبل تنفيذها',
                'حواجز على الميزانية والمزايدة',
                'سجل تراجع لكل إجراء منفّذ',
                'تشفير رموز الوصول في قاعدة البيانات',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[13px] leading-6">
                  <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                  <span className="text-foreground-subtle">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="surface-card self-start p-6 sm:p-8">
            <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold text-muted-foreground">
              <span className="status-square text-signal" aria-hidden />
              حدود نقولها من الآن
            </span>
            <h3 className="mt-3 font-display text-[1.375rem] font-bold leading-snug [word-spacing:0.15em]">
              يعمل مع Google Ads فقط
            </h3>
            <p className="mt-3 text-[13.5px] leading-8 text-muted-foreground">
              لا يوجد ربط مع Meta أو TikTok أو Snapchat حالياً. وإن كنت تريد أتمتة كاملة تنفّذ بدون موافقتك،
              فهذا ليس المنتج المناسب. الموافقة جزء من التصميم وليست خياراً نطفئه.
            </p>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Audience */}
      <section className="border-b border-border px-4 py-14 sm:px-6 sm:py-16">
        <div className="mx-auto w-full max-w-6xl">
          <SectionLabel>لمن؟</SectionLabel>
          <div className="mt-6 grid gap-x-8 gap-y-6 md:grid-cols-3">
            {audience.map((item) => (
              <article key={item.title} className="border-t border-foreground pt-4">
                <h3 className="font-sans text-[14px] font-semibold">{item.title}</h3>
                <p className="mt-2 text-[13px] leading-7 text-muted-foreground">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Pricing */}
      <section id="pricing" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <div className="text-center">
            <SectionLabel>الأسعار</SectionLabel>
            <h2 className="mt-3 font-display text-display-sm font-bold [word-spacing:0.15em]">
              ثلاث خطط بحسب حجم عملك
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-[13.5px] leading-7 text-muted-foreground">
              كل الخطط تبدأ بتجربة 14 يوماً. الأسعار بالريال السعودي قبل الضريبة.
            </p>
            <div
              className="mt-5 inline-flex items-center border border-border bg-background-elevated p-1 text-[13px]"
              role="group"
              aria-label="فترة الفوترة"
            >
              <Link
                href="/?period=monthly#pricing"
                aria-current={period === 'monthly' ? 'true' : undefined}
                className={cn(
                  'px-4 py-1.5 font-medium transition-colors',
                  period === 'monthly'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                شهري
              </Link>
              <Link
                href="/?period=yearly#pricing"
                aria-current={period === 'yearly' ? 'true' : undefined}
                className={cn(
                  'px-4 py-1.5 font-medium transition-colors',
                  period === 'yearly'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                سنوي
              </Link>
            </div>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {plans.map((plan) => {
              const livePrice = priceAmounts?.[plan.id]?.[period] ?? null;
              const displayAmount =
                livePrice?.amount ?? (period === 'monthly' ? plan.monthlyPrice : null);
              const displayCurrency = (livePrice?.currency ?? 'sar').toUpperCase();
              const monthlyAmount =
                priceAmounts?.[plan.id]?.monthly?.amount ?? plan.monthlyPrice;
              const yearlySavings =
                period === 'yearly' && livePrice && displayCurrency === 'SAR'
                  ? Math.max(0, monthlyAmount * 12 - livePrice.amount)
                  : 0;

              return (
                <article
                  key={plan.id}
                  className={cn(
                    'relative flex flex-col p-6',
                    plan.highlighted
                      ? 'border-2 border-foreground bg-card'
                      : 'surface-card'
                  )}
                >
                  {plan.highlighted && (
                    <span className="absolute -top-3 start-5 bg-signal px-2.5 py-0.5 text-[11px] font-bold text-signal-foreground">
                      الأكثر اختياراً
                    </span>
                  )}

                  <h3 className="font-sans text-[15px] font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-[12.5px] leading-6 text-muted-foreground">{plan.limit}</p>

                  <div className="mt-5 flex min-h-10 items-baseline gap-1.5">
                    {displayAmount !== null ? (
                      <>
                        <span className="text-[2.25rem] font-bold leading-none numeric">
                          {formatCurrency(displayAmount, displayCurrency)}
                        </span>
                        <span className="text-[13px] text-muted-foreground">
                          / {period === 'yearly' ? 'سنة' : 'شهر'}
                        </span>
                      </>
                    ) : (
                      <span className="text-[13px] font-semibold leading-6 text-muted-foreground">
                        يظهر السعر السنوي النهائي في صفحة الدفع
                      </span>
                    )}
                  </div>
                  {yearlySavings > 0 && (
                    <p className="mt-1.5 text-[12px] font-medium text-success">
                      وفّر {formatCurrency(yearlySavings, 'SAR')} مقارنة بالدفع الشهري
                    </p>
                  )}

                  <ul className="mt-5 flex-1 space-y-2.5 border-t border-border pt-5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-[12.5px] leading-6">
                        <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                        <span className="text-foreground-subtle">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Carry the chosen plan and period through login so the user
                      lands on the matching billing choice. */}
                  <Link
                    href={`/login?next=${encodeURIComponent(`/billing?plan=${plan.id}&period=${period}`)}`}
                    className={`${buttonClasses({
                      variant: plan.highlighted ? 'primary' : 'outline',
                      block: true,
                    })} mt-6`}
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
      <section id="faq" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-3xl">
          <div className="text-center">
            <SectionLabel>أسئلة شائعة</SectionLabel>
            <h2 className="mt-3 font-display text-display-sm font-bold [word-spacing:0.15em]">
              قبل أن تربط حسابك
            </h2>
          </div>

          <div className="mt-10 divide-y divide-border border border-border bg-card">
            {faq.map((item) => (
              <details key={item.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[13.5px] font-medium">
                  {item.q}
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center border border-border text-muted-foreground transition-transform duration-200 group-open:rotate-180 group-open:text-foreground">
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </span>
                </summary>
                <p className="mt-3 text-[13px] leading-8 text-muted-foreground">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Final CTA */}
      <section className="bg-foreground px-4 py-20 text-background sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <span className="status-square text-signal" aria-hidden />
          <h2 className="mt-5 font-display text-display-sm font-bold text-balance [word-spacing:0.15em]">
            شوف حسابك بعين ثانية
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[14px] leading-8 text-background/75">
            سجّل دخولك واربط Google Ads، ثم اختر الحساب الذي تريد أن يعمل عليه المساعد.
          </p>
          <Link
            href="/login"
            className="mt-8 inline-flex h-12 items-center justify-center gap-2 bg-background px-6 text-[0.9375rem] font-semibold text-foreground transition-colors hover:bg-background/90"
          >
            الدخول إلى المنصة
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 text-[12.5px] text-muted-foreground">
          <div className="flex items-center gap-2.5">
            <LogoMark size={22} alt="" />
            <span>© 2026 مُضاعِف · <span dir="ltr">Modaafa Ads AI</span> · مؤسسة تقنيات أيمن للتسويق الإلكتروني</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              الخصوصية
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              الشروط
            </Link>
            <Link href="/refund" className="transition-colors hover:text-foreground">
              الاسترداد
            </Link>
            <Link href="/data-deletion" className="transition-colors hover:text-foreground">
              حذف البيانات
            </Link>
            <a href="mailto:moodaaft@gmail.com" className="transition-colors hover:text-foreground">
              الدعم
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold text-muted-foreground">
      <span className="status-square text-foreground" aria-hidden />
      {children}
    </span>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  body,
  delay = 0,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  delay?: number;
}) {
  return (
    <Reveal as="article" delay={delay} className="surface-card surface-interactive p-5">
      <Icon className="h-5 w-5" aria-hidden />
      <h3 className="mt-4 font-sans text-[14px] font-semibold">{title}</h3>
      <p className="mt-2 text-[13px] leading-7 text-muted-foreground">{body}</p>
    </Reveal>
  );
}
