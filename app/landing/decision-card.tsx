import Image from 'next/image';

/**
 * The first decision the product shows, drawn in code so it stays sharp at any
 * size. The numbers match the demo account «متجر عطور (حساب تجريبي)».
 */
export function DecisionCard({ className }: { className?: string }) {
  return (
    <figure className={className}>
      <div className="overflow-hidden rounded-[22px] bg-[#161D33] text-brand-paper shadow-[0_40px_80px_-30px_rgba(14,20,38,0.65)] ring-1 ring-white/10">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-navy ring-1 ring-white/10">
            <Image src="/brand/modaafa-symbol-reversed.svg" alt="" width={20} height={20} />
          </span>
          <div className="leading-tight">
            <div className="text-[15px] font-bold">مُضاعِف</div>
            <div className="text-[12.5px] text-brand-paper/55">قرا حسابك الساعة 7:02 الصبح</div>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <p className="rounded-2xl rounded-tr-md bg-white/[0.06] px-4 py-3 text-[16px] leading-7">
            آخر 7 أيام صرفت <b className="numeric">1,470</b> ريال، وجاك منها <b className="numeric">41</b> طلب. عندي لك 3
            قرارات اليوم، ابدأ بأولها.
          </p>
          <div className="rounded-2xl border-r-4 border-brand-signal bg-white/[0.04] p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#FB923C]">
              <span className="h-2 w-2 rounded-full bg-[#FB923C]" /> عاجل
            </div>
            <div className="mt-1.5 text-[18px] font-bold leading-7">أوقف عبارة «عطور رخيصة»</div>
            <p className="mt-1 text-[14.5px] leading-6 text-brand-paper/70">
              جابت 96 ضغطة في 30 يوم وما سجّلت ولا طلب. اللي يكتبونها يدورون أرخص من أسعارك.
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2">
                <span className="rounded-xl bg-brand-signal px-5 py-2.5 text-[15px] font-bold text-brand-navy">اعتمد</span>
                <span className="rounded-xl bg-white/10 px-4 py-2.5 text-[15px] font-semibold">مو الحين</span>
              </div>
              <span className="text-[13.5px] text-brand-paper/60">
                توفر <b className="numeric text-brand-paper">412</b> ريال بالشهر
              </span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-4 text-[12.5px] text-brand-navy/60">الأرقام من حساب تجريبي لمتجر عطور، للتوضيح.</figcaption>
    </figure>
  );
}

const todayDecisions = [
  {
    tag: 'عاجل',
    dot: 'bg-[#E0561B]',
    title: 'أوقف عبارة «عطور رخيصة»',
    why: 'جابت 96 ضغطة في 30 يوم وما سجّلت ولا طلب.',
    save: '412',
  },
  {
    tag: 'مهم',
    dot: 'bg-brand-signal',
    title: 'حملة «أداء أقصى - عطور» تتوقف قبل العصر',
    why: 'آخر 7 أيام خلصت ميزانيتها قبل الساعة 2 العصر في 6 أيام، وأكثر طلباتك تجي بعد العصر.',
    save: null,
  },
  {
    tag: 'فرصة',
    dot: 'bg-brand-slate',
    title: 'أضف عبارة «عطر عود فاخر» لحملة البحث',
    why: 'تطلع في بحث الناس عندك، وجابت 4 طلبات من حملة ثانية بتكلفة أقل.',
    save: null,
  },
];

/** The «قرارات اليوم» list as the product shows it, drawn large in code. */
export function TodayDecisions({ className }: { className?: string }) {
  return (
    <figure className={className}>
      <div className="space-y-4">
        {todayDecisions.map((d) => (
          <div key={d.title} className="border border-brand-navy/15 bg-white p-5 shadow-[0_18px_40px_-28px_rgba(14,20,38,0.5)] sm:p-6 dark:border-white/10 dark:bg-[#161D33]">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-brand-slate dark:text-brand-paper/60">
              <span className={`h-2.5 w-2.5 rounded-full ${d.dot}`} /> {d.tag}
            </div>
            <div className="mt-2 text-[19px] font-bold leading-8 sm:text-[21px]">{d.title}</div>
            <p className="mt-1.5 text-[15.5px] leading-7 text-brand-slate dark:text-brand-paper/70">{d.why}</p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2">
                <span className="bg-brand-signal px-5 py-2.5 text-[15px] font-bold text-brand-navy">اعتمد</span>
                <span className="border border-brand-navy/25 px-4 py-2.5 text-[15px] font-semibold dark:border-white/20">مو الحين</span>
              </div>
              {d.save && (
                <span className="text-[14px] text-brand-slate dark:text-brand-paper/60">
                  توفر <b className="numeric text-brand-navy dark:text-brand-paper">{d.save}</b> ريال بالشهر
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="mt-4 text-[13px] text-brand-slate dark:text-brand-paper/60">
        من الشاشة الرئيسية في حساب تجريبي لمتجر عطور. الأرقام فيها للتوضيح.
      </figcaption>
    </figure>
  );
}
