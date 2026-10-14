import Image from 'next/image';

/* Throwaway mockups of three hero directions. Not committed. */

function Nav({ tone, links = true }: { tone: 'dark' | 'light' | 'yellow'; links?: boolean }) {
  const dark = tone === 'dark';
  return (
    <header className={`relative z-20 mx-auto flex h-20 w-full max-w-[1320px] items-center justify-between px-5 sm:px-10 ${dark ? 'text-brand-paper' : 'text-brand-navy'}`}>
      <Image src={dark ? '/brand/modaafa-lockup-reversed.svg' : '/brand/modaafa-lockup-primary.svg'} alt="مُضاعِف" width={136} height={32} style={{ width: 136, height: 32 }} />
      <nav className={`hidden items-center gap-8 text-[15px] font-medium opacity-80 ${links ? 'lg:flex' : ''}`}>
        <span>كيف يشتغل</span><span>الأسعار</span><span>الفحص المجاني</span><span>عن مُضاعِف</span>
      </nav>
      <span className="text-[15px] font-semibold">تسجيل الدخول</span>
    </header>
  );
}

function ChatCard({ tone = 'light', compact = false }: { tone?: 'light' | 'dark'; compact?: boolean }) {
  const d = tone === 'dark';
  return (
    <div className={`overflow-hidden rounded-[22px] ${d ? 'bg-[#161D33] text-brand-paper ring-1 ring-white/10' : 'bg-white text-brand-navy'} shadow-[0_40px_80px_-30px_rgba(14,20,38,0.55)]`}>
      <div className={`flex items-center gap-3 border-b px-5 py-3.5 ${d ? 'border-white/10' : 'border-black/[0.06]'}`}>
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-navy ring-1 ring-white/10">
          <Image src="/brand/modaafa-symbol-reversed.svg" alt="" width={20} height={20} />
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-bold">مُضاعِف</div>
          <div className={`text-[12.5px] ${d ? 'text-brand-paper/55' : 'text-brand-slate'}`}>قرا حسابك الساعة 7:02 الصبح</div>
        </div>
      </div>
      <div className="space-y-4 p-5">
        <p className={`max-w-[30rem] rounded-2xl rounded-tr-md px-4 py-3 text-[16px] leading-7 ${d ? 'bg-white/[0.06]' : 'bg-[#F3F2EE]'}`}>
          آخر 7 أيام صرفت <b className="numeric">1,470</b> ريال، وجاك منها <b className="numeric">41</b> طلب. عندي لك 3 قرارات اليوم، ابدأ بأولها.
        </p>
        <div className={`rounded-2xl border-r-4 border-brand-signal p-4 ${d ? 'bg-white/[0.04]' : 'bg-[#FFFBEB]'}`}>
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#C2410C]">
            <span className="h-2 w-2 rounded-full bg-[#EA580C]" /> عاجل
          </div>
          <div className="mt-1.5 text-[18px] font-bold leading-7">أوقف عبارة «عطور رخيصة»</div>
          {!compact && (
            <p className={`mt-1 text-[14.5px] leading-6 ${d ? 'text-brand-paper/70' : 'text-brand-slate'}`}>
              جابت 96 ضغطة في 30 يوم وما سجّلت ولا طلب. اللي يكتبونها يدورون أرخص من أسعارك.
            </p>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <span className={`rounded-xl px-5 py-2.5 text-[15px] font-bold ${d ? 'bg-brand-signal text-brand-navy' : 'bg-brand-navy text-brand-paper'}`}>اعتمد</span>
              <span className={`rounded-xl px-4 py-2.5 text-[15px] font-semibold ${d ? 'bg-white/10' : 'bg-black/[0.05]'}`}>مو الحين</span>
            </div>
            <span className={`text-[13.5px] ${d ? 'text-brand-paper/60' : 'text-brand-slate'}`}>
              توفر <b className={`numeric ${d ? 'text-brand-paper' : 'text-brand-navy'}`}>412</b> ريال بالشهر
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Founder({ tone }: { tone: 'dark' | 'light' }) {
  const d = tone === 'dark';
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className={`flex h-12 w-12 items-center justify-center font-display text-[20px] font-bold ${d ? 'bg-brand-paper text-brand-navy' : 'bg-brand-navy text-brand-paper'}`}>أ</span>
      <div className="leading-snug">
        <div className="text-[15px] font-bold">أيمن أمين</div>
        <div className={`text-[13.5px] ${d ? 'text-brand-paper/60' : 'text-brand-slate'}`}>مؤسس وكالة مُضاعفة، شريك Google Partner</div>
      </div>
    </div>
  );
}

/* A: the conversation is the hero, on navy, with one yellow block for weight */
function A() {
  return (
    <main className="min-h-screen overflow-hidden bg-brand-navy text-brand-paper">
      <Nav tone="dark" />
      <section className="relative mx-auto grid max-w-[1320px] items-center gap-14 px-5 pb-20 pt-8 sm:px-10 lg:grid-cols-[1fr_minmax(0,560px)] lg:pt-14">
        <div>
          <h1 className="font-display text-[44px] font-bold leading-[1.15] sm:text-[64px] lg:text-[76px]">
            صار لك أحد تسأله عن إعلاناتك في قوقل.
          </h1>
          <p className="mt-6 max-w-[34rem] text-[18px] leading-8 text-brand-paper/75 sm:text-[20px] sm:leading-9">
            مُضاعِف يقرا حسابك كل صبح، ويقول لك بكلامك وين راحت فلوسك ووش القرار اليوم. يجهّزه، وأنت اللي تضغط اعتمد.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-5">
            <span className="rounded-2xl bg-brand-signal px-8 py-4 text-[18px] font-bold text-brand-navy">افحص حسابك مجاناً</span>
            <span className="text-[16px] font-semibold underline decoration-brand-signal decoration-2 underline-offset-8">كلّمني على الواتساب</span>
          </div>
          <div className="mt-12"><Founder tone="dark" /></div>
        </div>
        <div className="relative">
          <div className="absolute -left-24 -top-10 h-[78%] w-[82%] bg-brand-signal" aria-hidden />
          <div className="relative"><ChatCard /></div>
          <p className="relative mt-4 text-[12.5px] text-brand-paper/50">مثال من حساب تجريبي لمتجر عطور.</p>
        </div>
      </section>
    </main>
  );
}

/* B: Ayman's photo full-bleed, paper side, the card sits on the seam */
function B() {
  return (
    <main className="min-h-screen bg-brand-paper text-brand-navy">
      <section className="relative grid min-h-[100svh] lg:grid-cols-[1fr_46%]">
        <div className="relative z-10 flex flex-col">
          <Nav tone="light" links={false} />
          <div className="flex w-full flex-1 flex-col justify-center px-5 pb-16 pt-6 sm:px-10 lg:pl-28 lg:pr-[max(2.5rem,calc((100vw-1320px)/2+2.5rem))]">
            <h1 className="font-display text-[44px] font-bold leading-[1.15] sm:text-[62px] lg:text-[70px]">
              صار لك أحد تسأله عن إعلاناتك في قوقل.
            </h1>
            <p className="mt-6 max-w-[32rem] text-[18px] leading-8 text-brand-slate sm:text-[20px] sm:leading-9">
              أنا أيمن، أدير إعلانات قوقل لعملاء وكالة مُضاعفة. بنيت مُضاعِف عشان يسوي لك اللي أسويه لهم كل صبح: يقرا الحساب ويقول لك وش القرار.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-5">
              <span className="rounded-2xl bg-brand-navy px-8 py-4 text-[18px] font-bold text-brand-paper">افحص حسابك مجاناً</span>
              <span className="text-[16px] font-semibold underline decoration-brand-signal decoration-[3px] underline-offset-8">كلّمني على الواتساب</span>
            </div>
            <div className="mt-8 inline-flex w-fit items-center gap-2 text-[14px] font-semibold text-brand-slate">
              <span className="h-2.5 w-2.5 bg-brand-signal" /> وكالة مُضاعفة شريك Google Partner
            </div>
          </div>
        </div>
        <div className="relative z-20 h-[520px] sm:h-[620px] lg:h-auto">
          <div className="absolute inset-0 flex items-center justify-center bg-[#DCD8CE] text-center">
            <div className="px-8 text-brand-navy/60">
              <div className="font-display text-[26px] font-bold">مكان صورتك الحقيقية</div>
              <div className="mt-2 text-[15px]">صورة من جوالك على مكتبك أو في المكتب، وأنا أقصّها وأضبط ألوانها</div>
            </div>
          </div>
          <div className="absolute hidden sm:bottom-8 sm:left-8 sm:block sm:w-[420px] lg:-right-20 lg:bottom-16 lg:left-auto lg:w-[400px]">
            <ChatCard compact />
          </div>
        </div>
        <div className="relative z-30 -mt-14 px-4 pb-12 sm:hidden">
          <ChatCard compact />
        </div>
      </section>
    </main>
  );
}

/* C: the number is the hero, on signal yellow */
function C() {
  return (
    <main className="min-h-screen overflow-hidden bg-brand-signal text-brand-navy">
      <Nav tone="yellow" />
      <section className="mx-auto grid max-w-[1320px] items-center gap-12 px-5 pb-20 pt-4 sm:px-10 lg:grid-cols-[1fr_minmax(0,500px)] lg:pt-10">
        <div>
          <div className="text-[15px] font-semibold text-brand-navy/70">متجر عطور، آخر 30 يوم</div>
          <div className="mt-2 font-display font-bold leading-none">
            <span className="numeric text-[120px] sm:text-[190px] lg:text-[230px]">412</span>
            <span className="mr-3 text-[40px] sm:text-[60px]">ريال</span>
          </div>
          <p className="mt-4 max-w-[36rem] font-display text-[26px] font-semibold leading-[1.45] sm:text-[34px]">
            راحت على ناس يكتبون «عطور رخيصة»، وولا واحد منهم اشترى.
          </p>
          <p className="mt-5 max-w-[34rem] text-[18px] leading-8 text-brand-navy/80 sm:text-[20px] sm:leading-9">
            مُضاعِف لقطها من أول قراءة للحساب، وجهّز القرار. صاحب المتجر ضغط اعتمد وخلص.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-5">
            <span className="rounded-2xl bg-brand-navy px-8 py-4 text-[18px] font-bold text-brand-paper">افحص حسابك مجاناً</span>
          </div>
          <div className="mt-10"><Founder tone="light" /></div>
        </div>
        <div>
          <ChatCard tone="dark" />
          <p className="mt-4 text-[12.5px] text-brand-navy/60">الأرقام من حساب تجريبي، للتوضيح.</p>
        </div>
      </section>
    </main>
  );
}

export default async function Page({ params }: { params: Promise<{ v: string }> }) {
  const { v } = await params;
  return v === 'b' ? <B /> : v === 'c' ? <C /> : <A />;
}
