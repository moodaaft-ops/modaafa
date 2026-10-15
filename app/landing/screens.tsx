import Image from 'next/image';
import { cn } from '@/lib/utils';

/*
 * Real product screens for the public pages. Every image here is a screenshot
 * of the actual app (the chat home, the setup chat and the plan card) rendered
 * against the synthetic demo account «متجر عطور (حساب تجريبي)». Captions say
 * so; no number in them belongs to a real client.
 */

const lift = 'shadow-[0_18px_40px_-18px_rgba(0,0,0,0.55)] ring-1 ring-black/10';

export function Phone({
  src,
  alt,
  crop = 2050,
  className,
  priority,
}: {
  src: string;
  alt: string;
  /** How much of the 1688px-tall capture to show, in px of a 1170-wide basis. */
  crop?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[290px] overflow-hidden rounded-[38px] border-[9px] border-brand-navy bg-white shadow-[0_30px_60px_-30px_rgba(14,20,38,0.55)] dark:border-[#2A3350]',
        className
      )}
    >
      <div className="relative overflow-hidden" style={{ aspectRatio: `1170 / ${crop}` }}>
        <Image
          src={src}
          alt={alt}
          width={780}
          height={1688}
          priority={priority}
          sizes="290px"
          className="absolute inset-x-0 top-0 block h-auto w-full"
        />
      </div>
    </div>
  );
}

/** The chat home on a laptop, with the two things a first-time visitor should notice. */
export function HomeScreen() {
  return (
    <figure>
      <div className="hidden overflow-hidden rounded-xl border border-border bg-white shadow-[0_30px_70px_-40px_rgba(14,20,38,0.6)] md:block">
        <div className="flex h-10 items-center justify-center gap-2 border-b border-black/5 bg-[#FAF9F6]">
          <span dir="ltr" className="rounded-md bg-white px-5 py-0.5 text-[12.5px] text-brand-slate ring-1 ring-black/5 numeric">
            ai.modaafa.com/home
          </span>
        </div>
        <div className="relative">
          <Image
            src="/landing/chat-home-desktop.png"
            alt="الرئيسية في مُضاعِف: رسالة فيها صرف آخر 7 أيام ونتائجها، وتحتها قرارات اليوم، لكل قرار سببه وزر اعتمد وزر مو الحين"
            width={2880}
            height={1800}
            sizes="(min-width: 1280px) 1150px, 100vw"
            className="block h-auto w-full"
          />
          {/* boxes measured on the 1440x900 capture */}
          <Callout box={{ left: '15.4%', top: '18.6%', width: '47.6%', height: '10.6%' }} label="الأرقام من حسابك أنت" />
          <Callout box={{ left: '15.4%', top: '34.6%', width: '47.6%', height: '21.6%' }} label="القرار مع سببه، وأنت تعتمد" />
        </div>
      </div>
      <div className="md:hidden">
        <Phone
          src="/landing/chat-home-mobile.png"
          alt="الرئيسية في مُضاعِف على الجوال: رسالة اليوم وقرارات اليوم بزر اعتمد"
          crop={2300}
        />
      </div>
      <figcaption className="mt-4 text-center text-[13px] text-muted-foreground md:text-start">
        لقطة من المنصة نفسها، بحساب تجريبي لمتجر عطور. الأرقام فيها للتوضيح.
      </figcaption>
    </figure>
  );
}

function Callout({
  box,
  label,
}: {
  box: { left: string; top: string; width: string; height: string };
  label: string;
}) {
  return (
    <span aria-hidden className="pointer-events-none absolute rounded-2xl border-2 border-brand-signal" style={box}>
      <span className="absolute -top-3.5 right-4 inline-flex items-center gap-1.5 rounded-sm bg-brand-navy px-2.5 py-1 text-[12px] font-bold text-brand-paper">
        <span className="h-1.5 w-1.5 bg-brand-signal" />
        {label}
      </span>
    </span>
  );
}
