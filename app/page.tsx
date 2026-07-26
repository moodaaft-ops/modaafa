import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
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

const plans = [
  { name: 'البداية', nameEn: 'Starter', price: '500', limit: 'للبداية وإدارة العمل اليومي' },
  { name: 'النمو', nameEn: 'Growth', price: '1٬200', limit: 'للشركات النشطة والمتابعة اليومية', highlighted: true },
  { name: 'الاحتراف', nameEn: 'Pro', price: '2٬500', limit: 'للوكالات والاستخدام المكثف' },
];

export default function HomePage() {
  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-background text-foreground">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Image
              src="/logo-mark.svg"
              alt="مُضاعِف"
              width={40}
              height={40}
              className="h-10 w-10 flex-shrink-0 rounded-xl shadow-soft"
            />
            <span className="hidden min-w-0 sm:block">
              <span className="block text-lg font-bold leading-tight">مُضاعِف</span>
              <span className="block text-xs text-muted-foreground" dir="ltr">
                Modaafa Ads AI
              </span>
            </span>
          </Link>
          <div className="flex flex-shrink-0 items-center gap-2">
            <a href="#how" className="hidden rounded-lg px-4 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted md:inline-flex">
              كيف تعمل؟
            </a>
            <a href="#pricing" className="hidden rounded-lg px-4 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted md:inline-flex">
              الأسعار
            </a>
            <ThemeToggle />
            <Link href="/login" className={buttonClasses({ variant: 'primary' })}>
              تسجيل الدخول
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="overflow-hidden border-b border-border bg-muted/25">
        <div className="mx-auto max-w-7xl px-4 pb-12 pt-14 sm:px-6 md:pt-20">
          <div className="mx-auto min-w-0 max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              <Sparkles className="h-3.5 w-3.5" />
              ميديا باير ذكي لإعلانات Google
            </span>
            <h1 className="mt-6 max-w-full text-2xl font-bold leading-[1.35] sm:text-4xl md:text-6xl md:leading-[1.15]">
              يقرأ حسابك، يقترح التحسين،
              <br className="hidden sm:block" />
              <span className="text-gradient-brand"> وينتظر موافقتك قبل التنفيذ.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
              مُضاعِف يحوّل إدارة الحملات من شات عشوائي إلى منصة منظّمة: ربط الحسابات، فحص، توصيات، مساعد ذكي، ومركز موافقات.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link href="/login" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                ابدأ الآن
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <a href="#how" className={buttonClasses({ variant: 'outline', size: 'lg' })}>
                شوف كيف تعمل
              </a>
            </div>
          </div>

          <div className="mt-10 min-w-0 max-w-full animate-fade-up sm:mt-14">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* Flow */}
      <section id="how" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand-700 dark:text-brand-400">التجربة الكاملة</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">من التسجيل إلى أول توصية بدون ضياع.</h2>
        </div>
        <div className="mt-12 grid gap-3 md:grid-cols-5">
          {flow.map((item, index) => (
            <div key={item.title} className="rounded-lg border border-border bg-card p-5 shadow-soft transition hover:shadow-card">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-gradient font-bold text-white shadow-soft">
                {index + 1}
              </div>
              <div className="mt-4 font-semibold">{item.title}</div>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-y border-border bg-muted/40">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-12 max-w-2xl">
            <p className="text-sm font-semibold text-brand-700 dark:text-brand-400">ماذا يحصل العميل؟</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">أدوات عملية بدل لوحة فارغة.</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((cap) => {
              const Icon = cap.icon;
              return (
                <article
                  key={cap.title}
                  className="group rounded-lg border border-border bg-card p-6 shadow-soft transition hover:-translate-y-0.5 hover:shadow-card"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600 transition group-hover:bg-brand-gradient group-hover:text-white dark:bg-brand-500/15 dark:text-brand-300">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-bold">{cap.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-muted-foreground">{cap.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Safety / approval model */}
      <section className="border-y border-white/10 bg-ink-900 text-white">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-20">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">
              <ShieldCheck className="h-3.5 w-3.5" />
              نموذج الأمان والموافقات
            </span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight md:text-4xl">لا تعديل على حسابك قبل موافقتك.</h2>
            <p className="mt-4 max-w-md leading-7 text-white/70">
              كل توصية تبدأ في مركز الموافقات. تراجعها، تعرف أثرها المتوقع، ثم تعتمد أو تتجاهل. المنصة لا تلمس إعلاناتك من تلقاء نفسها.
            </p>
          </div>
          <ul className="grid gap-1 divide-y divide-white/10 border-y border-white/10">
            {[
              'كل تغيير مؤثر يمر عبر مراجعة واعتماد',
              'الحسابات الإدارية لا تُستخدم لقياس الأداء',
              'رسائل واضحة عند توقف الحساب أو غياب الاسم من Google',
              'سجل تنفيذ يوثّق كل قرار اعتمدته',
            ].map((item) => (
              <li key={item} className="flex items-start gap-3 py-4 text-sm leading-6">
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-300" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Audience */}
      <section className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-12 max-w-2xl">
            <p className="text-sm font-semibold text-brand-700 dark:text-brand-400">لمن هذه المنصة؟</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">لكل من يدير إنفاقاً على إعلانات Google.</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {audience.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className="rounded-lg border border-border bg-card p-6 shadow-soft">
                  <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-ink-900 text-white dark:bg-white/10">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-bold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section id="pricing" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand-700 dark:text-brand-400">الأسعار</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">ابدأ بتجربة، وطوّر حسب حجم حساباتك.</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.nameEn}
              className={`relative flex flex-col rounded-lg border bg-card p-6 ${
                plan.highlighted ? 'border-brand-500 shadow-card ring-1 ring-brand-500/30' : 'border-border shadow-soft'
              }`}
            >
              {plan.highlighted && (
                <span className="absolute -top-3 end-6 rounded-full bg-brand-gradient px-3 py-1 text-xs font-semibold text-white shadow-glow-brand">
                  الأنسب
                </span>
              )}
              <h3 className="text-xl font-bold">{plan.name}</h3>
              <p className="text-xs font-medium text-muted-foreground" dir="ltr">
                {plan.nameEn}
              </p>
              <div className="mt-5 text-3xl font-bold">
                {plan.price} <span className="text-sm font-normal text-muted-foreground">ر.س / شهر</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{plan.limit}</p>
              <Link
                href="/login"
                className={`mt-6 ${buttonClasses({ variant: plan.highlighted ? 'primary' : 'outline', block: true })}`}
              >
                ابدأ التجربة
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-y border-brand-700 bg-brand-700 text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-4 py-12 sm:px-6 md:flex-row md:items-center">
          <div>
            <h2 className="text-2xl font-bold md:text-3xl">جاهز تربط حسابك وتشوف التجربة؟</h2>
            <p className="mt-2 max-w-xl text-sm leading-7 text-white/85">
              سجّل دخولك، اربط إعلانات Google، واختر الحساب الذي تريد أن يعمل عليه المساعد.
            </p>
          </div>
          <Link
            href="/login"
            className="inline-flex h-12 items-center justify-center rounded-lg bg-white px-6 text-sm font-semibold text-brand-700 transition hover:bg-white/90"
          >
            الدخول إلى المنصة
          </Link>
        </div>
      </section>

      <footer className="border-t border-border px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <span>© 2026 مُضاعِف / Modaafa Ads AI</span>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground">
              الخصوصية
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              الشروط
            </Link>
            <Link href="/data-deletion" className="hover:text-foreground">
              حذف البيانات
            </Link>
            <a href="mailto:moodaaft@gmail.com" className="hover:text-foreground">
              الدعم
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ProductPreview() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-pop ring-1 ring-black/5 lg:max-w-5xl">
      <div className="flex items-center justify-between border-b border-border bg-muted/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-amber-400" />
          <span className="h-3 w-3 rounded-full bg-emerald-400" />
        </div>
        <div className="rounded-md bg-card px-3 py-1 text-xs text-muted-foreground shadow-soft" dir="ltr">
          ai.modaafa.com
        </div>
      </div>
      <div className="grid w-full min-w-0 max-w-full grid-cols-1 md:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="hidden flex-col gap-1 border-e border-border bg-[hsl(var(--sidebar))] p-3 md:flex">
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2">
            <Building2 className="h-4 w-4 text-brand-600 dark:text-brand-400" />
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">متجر تجريبي</div>
              <div className="text-[10px] text-muted-foreground" dir="ltr">
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
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${
                  item.active
                    ? 'bg-brand-50 font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'text-muted-foreground'
                }`}
              >
                <Icon className={`h-4 w-4 ${item.active ? 'text-brand-600 dark:text-brand-300' : 'text-muted-foreground/70'}`} />
                {item.label}
              </div>
            );
          })}
        </aside>
        <div className="min-w-0 p-3 sm:p-5">
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <PreviewMetric label="الصرف 7 أيام" value="8٬420 ر.س" />
            <PreviewMetric label="التحويلات" value="137" />
            <PreviewMetric label="صحة الحساب" value="74/100" />
            <PreviewMetric label="تسريب متوقع" value="1٬180 ر.س" danger />
          </div>
          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-bold">
                <Sparkles className="h-4 w-4 text-brand-600 dark:text-brand-400" />
                رد المساعد
              </div>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                أعلى حملة صرفاً تحتاج مراجعة كلمات البحث والميزانية. أقترح إضافة كلمات سلبية وتشغيل فحص قبل أي تعديل.
              </p>
            </div>
            <div className="rounded-lg border border-brand-100 bg-brand-50 p-4 dark:border-brand-500/20 dark:bg-brand-500/10">
              <div className="text-xs font-bold text-brand-800 dark:text-brand-300">موافقة مطلوبة</div>
              <p className="mt-2 text-[11px] leading-6 text-brand-800/90 dark:text-brand-300/90">
                إيقاف كلمة منخفضة الجودة وتعديل ميزانية حملة البحث.
              </p>
              <div className="mt-3 flex gap-2">
                <span className="rounded-md bg-brand-gradient px-2.5 py-1 text-[11px] font-semibold text-white">اعتماد</span>
                <span className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
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
    <div
      className={`min-w-0 rounded-lg p-3 ${
        danger
          ? 'border border-red-100 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300'
          : 'border border-border bg-muted/60 text-foreground'
      }`}
    >
      <div className="text-[11px] opacity-70">{label}</div>
      <div className="mt-1 break-words text-lg font-bold">{value}</div>
    </div>
  );
}
