import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  LayoutDashboard,
  Layers,
  ListChecks,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
} from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { ThemeToggle } from '@/lib/ui/theme-toggle';

const flow = [
  { title: 'سجّل بحساب Google', desc: 'دخول واحد بالبريد الذي يدير إعلاناتك.' },
  { title: 'اربط إعلانات Google', desc: 'موافقة واحدة تسحب كل حساباتك.' },
  { title: 'اختر الحساب', desc: 'بدّل بين الحسابات من لوحة واحدة.' },
  { title: 'افحص واسأل المساعد', desc: 'تحليل الأداء وأولويات التحسين.' },
  { title: 'اعتمد التوصيات', desc: 'لا تعديل قبل موافقتك.' },
];

const capabilities = [
  { icon: Layers, title: 'يربط كل حساباتك', body: 'الحساب المباشر وكل حساب عميل تحت أي MCC، ثم تختار ما تريد إدارته.' },
  { icon: Sparkles, title: 'يفهم قبل أن يقترح', body: 'يلخص الصرف والتحويلات وصحة الحساب والتوصيات المفتوحة من بياناتك.' },
  { icon: ShieldCheck, title: 'لا ينفّذ عشوائياً', body: 'أي تغيير مؤثر يمر عبر مركز موافقات واضح قبل لمس الحساب.' },
  { icon: ListChecks, title: 'توصيات مرتبة', body: 'من الفحص إلى قرارات قابلة للاعتماد، مرتبة حسب الأولوية والأثر.' },
  { icon: MessageCircle, title: 'مساعد ميديا باير', body: 'اسأله عن الأداء أو اطلب مسودة حملة بلغتك، بدل قوالب جامدة.' },
  { icon: BadgeCheck, title: 'عربي أولاً', body: 'تجربة عربية RTL منسّقة، والإنجليزي فقط للمصطلحات عند الحاجة.' },
];

const audience = [
  { icon: Store, title: 'أصحاب الأنشطة', body: 'تحكم بإنفاقك الإعلاني وتفهم نتائجك بدون مصطلحات معقدة.' },
  { icon: Users, title: 'الميديا باير', body: 'أتمتة الفحص والتوصيات لتركّز على القرارات المهمة.' },
  { icon: Building2, title: 'الوكالات', body: 'إدارة حسابات متعددة تحت MCC من مكان واحد منظّم.' },
];

// Feature lists mirror lib/billing/entitlements PLAN_LIMITS. The marketing page
// used to show only a price and one line, so a visitor learned LESS here than
// on the billing page they could not reach without signing up.
const plans = [
  {
    id: 'starter',
    name: 'البداية',
    price: '500',
    limit: 'للبداية وإدارة العمل اليومي',
    features: ['20 محادثة ذكية يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً', '3 تنفيذات معتمدة يومياً'],
  },
  {
    id: 'growth',
    name: 'النمو',
    price: '1,200',
    limit: 'للشركات النشطة والمتابعة اليومية',
    features: ['100 محادثة ذكية يومياً', '7 فحوصات أسبوعياً', '20 مزامنة يدوية يومياً', '20 تنفيذاً معتمداً يومياً'],
    highlighted: true,
  },
  {
    id: 'pro',
    name: 'الاحتراف',
    price: '2,500',
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
    a: 'تبدأ التجربة 14 يوماً عبر Stripe، ويمكنك الإلغاء قبل انتهائها من بوابة إدارة الاشتراك دون أي خصم. ننبّهك بالبريد قبل أول تجديد.',
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

export default function HomePage() {
  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      {/* ---------------------------------------------------------------- Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <Image
              src="/logo-mark.svg"
              alt="مُضاعِف"
              width={30}
              height={30}
              className="h-[30px] w-[30px] flex-shrink-0 rounded-lg ring-1 ring-border"
              priority
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold leading-tight tracking-tight">مُضاعِف</span>
              <span className="block text-[10px] leading-tight text-muted-foreground" dir="ltr">
                Modaafa Ads AI
              </span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            <a href="#how" className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              كيف تعمل؟
            </a>
            <a href="#features" className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              المزايا
            </a>
            <a href="#pricing" className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              الأسعار
            </a>
            <a href="#faq" className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
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
      <section className="relative overflow-hidden border-b border-border">
        <div className="canvas-glow pointer-events-none absolute inset-0" aria-hidden />
        <div className="canvas-grid pointer-events-none absolute inset-0" aria-hidden />

        <div className="relative mx-auto w-full max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-20 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-[11.5px] font-medium text-muted-foreground shadow-soft backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
              ميديا باير ذكي لإعلانات <span dir="ltr">Google</span>
            </span>

            <h1 className="mt-6 text-display-md font-bold text-balance sm:text-display-lg">
              يقرأ حسابك، يقترح التحسين،
              <br />
              <span className="text-gradient-brand">وينتظر موافقتك قبل التنفيذ.</span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-[15px] leading-8 text-muted-foreground text-balance">
              مُضاعِف يحوّل إدارة الحملات من شات عشوائي إلى منصة منظّمة: ربط الحسابات، فحص، توصيات، مساعد ذكي، ومركز موافقات.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/login" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ابدأ التجربة — 14 يوماً
                <ArrowLeft className="h-4 w-4" aria-hidden />
              </Link>
              <a href="#how" className={buttonClasses({ variant: 'outline', size: 'lg' })}>
                شوف كيف تعمل
              </a>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              تلغي متى شئت قبل نهاية التجربة · لا تعديل على حساباتك بدون موافقتك
            </p>
          </div>

          <div className="mt-14 sm:mt-16">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- Flow */}
      <section id="how" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <SectionLabel>كيف تعمل</SectionLabel>
          <h2 className="mt-3 max-w-2xl text-display-sm font-bold text-balance">
            من تسجيل الدخول إلى أول قرار معتمد — خمس خطوات.
          </h2>

          <ol className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
            {flow.map((step, index) => (
              <li key={step.title} className="bg-card p-5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-muted text-[11px] font-bold text-muted-foreground numeric">
                  {index + 1}
                </span>
                <h3 className="mt-3 text-[13.5px] font-semibold tracking-tight">{step.title}</h3>
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
          <h2 className="mt-3 max-w-2xl text-display-sm font-bold text-balance">
            كل ما يحتاجه حساب إعلاني — في مكان واحد منظّم.
          </h2>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className="surface-card surface-interactive group p-5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary transition-colors duration-150 group-hover:border-primary/40">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-[14px] font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-7 text-muted-foreground">{item.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- Trust */}
      <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <div className="surface-card relative overflow-hidden p-8 sm:p-10">
            <div className="canvas-glow pointer-events-none absolute inset-0 opacity-70" aria-hidden />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
              <div>
                <SectionLabel>الأمان</SectionLabel>
                <h2 className="mt-3 text-display-sm font-bold text-balance">
                  لا تعديل على حسابك قبل موافقتك — بلا استثناء.
                </h2>
                <p className="mt-4 max-w-xl text-[14px] leading-8 text-muted-foreground">
                  المهام المجدولة تُجهّز التوصيات فقط. أي تغيير فعلي على Google Ads يمر عبر مركز الموافقات، ويُتحقق منه
                  على Google قبل تطبيقه، ويُحفظ له سجل تراجع.
                </p>
              </div>

              <ul className="space-y-2.5">
                {[
                  'تحقّق مسبق من العملية قبل تنفيذها',
                  'حواجز على الميزانية والمزايدة',
                  'سجل تراجع لكل إجراء منفّذ',
                  'تشفير رموز الوصول في قاعدة البيانات',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-[13px] leading-6">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
                    <span className="text-foreground-subtle">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Audience */}
      <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <SectionLabel>لمن؟</SectionLabel>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {audience.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className="surface-card p-5">
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <h3 className="mt-3 text-[14px] font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-7 text-muted-foreground">{item.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Pricing */}
      <section id="pricing" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-6xl">
          <div className="text-center">
            <SectionLabel>الأسعار</SectionLabel>
            <h2 className="mt-3 text-display-sm font-bold">خطة لكل حجم عمل.</h2>
            <p className="mx-auto mt-3 max-w-lg text-[13.5px] leading-7 text-muted-foreground">
              كل الخطط تبدأ بتجربة 14 يوماً. الأسعار بالريال السعودي شهرياً قبل الضريبة.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {plans.map((plan) => (
              <article
                key={plan.id}
                className={
                  plan.highlighted
                    ? 'surface-raised relative flex flex-col p-6 ring-1 ring-primary/30'
                    : 'surface-card flex flex-col p-6'
                }
              >
                {plan.highlighted && (
                  <span className="absolute -top-2.5 start-6 rounded-full bg-primary px-2.5 py-0.5 text-[10.5px] font-bold text-primary-foreground">
                    الأكثر اختياراً
                  </span>
                )}

                <h3 className="text-[15px] font-semibold tracking-tight">{plan.name}</h3>
                <p className="mt-1 text-[12.5px] leading-6 text-muted-foreground">{plan.limit}</p>

                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="text-[2.25rem] font-bold leading-none numeric" dir="ltr">
                    {plan.price}
                  </span>
                  <span className="text-[13px] text-muted-foreground">ر.س / شهر</span>
                </div>

                <ul className="mt-5 flex-1 space-y-2.5 border-t border-border pt-5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-[12.5px] leading-6">
                      <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
                      <span className="text-foreground-subtle">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* Carry the chosen plan through login so the user lands on the
                    right checkout instead of a bare pricing table again. */}
                <Link
                  href={`/login?next=${encodeURIComponent(`/billing?plan=${plan.id}`)}`}
                  className={`${buttonClasses({
                    variant: plan.highlighted ? 'primary' : 'outline',
                    block: true,
                  })} mt-6`}
                >
                  ابدأ بخطة {plan.name}
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- FAQ */}
      <section id="faq" className="border-b border-border px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto w-full max-w-3xl">
          <div className="text-center">
            <SectionLabel>أسئلة شائعة</SectionLabel>
            <h2 className="mt-3 text-display-sm font-bold">قبل أن تربط حسابك.</h2>
          </div>

          <div className="mt-10 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {faq.map((item) => (
              <details key={item.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[13.5px] font-medium">
                  {item.q}
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-transform duration-150 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-[13px] leading-8 text-muted-foreground">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Final CTA */}
      <section className="relative overflow-hidden border-b border-border px-4 py-20 sm:px-6">
        <div className="canvas-glow pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-2xl text-center">
          <h2 className="text-display-sm font-bold text-balance">جاهز تشوف حسابك بعين ثانية؟</h2>
          <p className="mx-auto mt-4 max-w-lg text-[14px] leading-8 text-muted-foreground">
            سجّل دخولك، اربط إعلانات Google، واختر الحساب الذي تريد أن يعمل عليه المساعد.
          </p>
          <Link href="/login" className={`${buttonClasses({ variant: 'primary', size: 'lg' })} mt-8`}>
            الدخول إلى المنصة
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 text-[12.5px] text-muted-foreground">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-mark.svg" alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-md ring-1 ring-border" />
            <span>© 2026 مُضاعِف · <span dir="ltr">Modaafa Ads AI</span></span>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              الخصوصية
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              الشروط
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
    <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.12em] text-primary">
      <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
      {children}
    </span>
  );
}

/** Hand-built product mock used in the hero. */
function ProductPreview() {
  return (
    <div className="surface-raised mx-auto w-full min-w-0 max-w-full overflow-hidden lg:max-w-5xl">
      <div className="flex items-center justify-between border-b border-border bg-background-elevated px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        </div>
        <div className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground" dir="ltr">
          ai.modaafa.com
        </div>
        <span className="w-12" aria-hidden />
      </div>

      <div className="grid w-full min-w-0 max-w-full grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="hidden flex-col gap-0.5 border-e border-border bg-[hsl(var(--sidebar))] p-2.5 md:flex">
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
            <Building2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold">متجر تجريبي</div>
              <div className="text-[9.5px] text-muted-foreground numeric" dir="ltr">
                123-456-7890
              </div>
            </div>
          </div>
          {[
            { icon: LayoutDashboard, label: 'لوحة التحكم', active: false },
            { icon: MessageCircle, label: 'المساعد الذكي', active: true },
            { icon: ShieldCheck, label: 'فحص الحساب', active: false },
            { icon: ListChecks, label: 'مركز الموافقات', active: false },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className={`relative flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] ${
                  item.active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
                }`}
              >
                {item.active && <span className="absolute inset-y-1 start-0 w-[2px] rounded-full bg-primary" />}
                <Icon className={`h-3.5 w-3.5 ${item.active ? 'text-primary' : 'text-muted-foreground/70'}`} />
                {item.label}
              </div>
            );
          })}
        </aside>

        <div className="min-w-0 bg-background p-3 sm:p-5">
          <div className="grid min-w-0 grid-cols-2 gap-2.5 lg:grid-cols-4">
            <PreviewMetric label="الصرف 7 أيام" value="8,420 ر.س" />
            <PreviewMetric label="التحويلات" value="137" />
            <PreviewMetric label="صحة الحساب" value="74/100" />
            <PreviewMetric label="تسريب متوقع" value="1,180 ر.س" danger />
          </div>

          <div className="mt-3 grid min-w-0 gap-2.5 lg:grid-cols-[minmax(0,1fr)_248px]">
            <div className="surface-card p-4">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                رد المساعد
              </div>
              <p className="mt-2 text-[11.5px] leading-6 text-muted-foreground">
                أعلى حملة صرفاً تحتاج مراجعة كلمات البحث والميزانية. أقترح إضافة كلمات سلبية وتشغيل فحص قبل أي تعديل.
              </p>
            </div>

            <div className="surface-card border-primary/25 bg-primary/[0.06] p-4">
              <div className="text-[11.5px] font-semibold text-primary">موافقة مطلوبة</div>
              <p className="mt-2 text-[11px] leading-6 text-foreground-subtle">
                إيقاف كلمة منخفضة الجودة وتعديل ميزانية حملة البحث.
              </p>
              <div className="mt-3 flex gap-1.5">
                <span className="rounded-md bg-primary px-2 py-1 text-[10.5px] font-semibold text-primary-foreground">
                  اعتماد
                </span>
                <span className="rounded-md border border-border bg-card px-2 py-1 text-[10.5px] font-semibold text-muted-foreground">
                  تجاهل
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewMetric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="surface-card relative min-w-0 overflow-hidden p-3">
      <span
        className={`absolute inset-x-0 top-0 h-px ${danger ? 'bg-red-500' : 'bg-border-strong'}`}
        aria-hidden
      />
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div
        className={`mt-1.5 break-words text-[15px] font-bold leading-tight numeric ${
          danger ? 'text-red-500 dark:text-red-400' : 'text-foreground'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
