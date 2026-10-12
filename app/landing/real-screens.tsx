import Image from 'next/image';

/*
 * Real product screens for the landing page. Every image here is a
 * screenshot of the actual app (approvals centre and dashboard cards),
 * rendered against the synthetic demo account "متجر عطور (حساب تجريبي)".
 * The captions say so; no number in them belongs to a real client.
 */

const card = 'bg-white shadow-[0_0_0_1px_rgba(14,20,38,0.45)]';

export function HeroStage() {
  return (
    <figure className="relative mx-auto w-full max-w-[34rem] lg:max-w-none">
      <div className="relative pb-[15%]">
        <div className="relative ms-auto w-[84%]">
          <Image
            src="/landing/ayman-portrait-v4.jpg"
            alt="أيمن أمين، مؤسس مُضاعِف، بالثوب والشماغ وجواله في يده"
            width={892}
            height={1189}
            priority
            sizes="(min-width: 1024px) 34vw, (min-width: 640px) 28rem, 84vw"
            className="block h-auto w-full"
          />
          {/* the logo's yellow lamp, on the photo's corner nearest the text */}
          <span aria-hidden className="absolute right-0 top-0 h-5 w-5 bg-brand-signal motion-safe:animate-lamp sm:h-6 sm:w-6" />
        </div>

        <div className={`absolute right-0 top-[27%] hidden w-[40%] sm:block motion-safe:animate-fade-up motion-safe:[animation-delay:350ms] ${card}`}>
          <Image
            src="/landing/ui-leak-card.png"
            alt="بطاقة «تسريب الميزانية الشهري» من لوحة مُضاعِف: 1,840 ر.س تقدير محافظ قابل للتوفير"
            width={538}
            height={276}
            sizes="(min-width: 1024px) 14vw, 40vw"
            className="block h-auto w-full"
          />
        </div>

        <div className={`absolute bottom-0 left-0 w-[94%] sm:w-[90%] motion-safe:animate-fade-up motion-safe:[animation-delay:600ms] ${card}`}>
          <Image
            src="/landing/ui-rec-card.png"
            alt="توصية من مركز الموافقات: أوقف عبارة «عطور رخيصة» في حملة البحث، مع زري اعتماد وتجاهل"
            width={1316}
            height={320}
            sizes="(min-width: 1024px) 34vw, 90vw"
            className="block h-auto w-full"
          />
        </div>
      </div>
      <figcaption className="mt-4 text-[12.5px] text-brand-paper/50">البطاقات لقطات من المنصة نفسها، بحساب تجريبي.</figcaption>
    </figure>
  );
}

export function RealScreen() {
  return (
    <figure className="mt-10 sm:mt-14">
      {/* desktop and tablet: the approvals centre in a plain browser frame */}
      <div className="hidden border border-brand-navy/25 bg-white md:block">
        <div className="flex h-10 items-center justify-center border-b border-brand-navy/10 bg-[#FAF9F6]">
          <span dir="ltr" className="border border-brand-navy/10 bg-white px-5 py-0.5 font-numeric text-[12.5px] text-brand-slate">
            ai.modaafa.com/optimizer
          </span>
        </div>
        <div className="relative">
          <Image
            src="/landing/ui-approvals-desktop.png"
            alt="مركز الموافقات في مُضاعِف: ثلاث توصيات لحساب متجر عطور، لكل وحدة سببها وزر اعتماد وزر تجاهل"
            width={2880}
            height={1800}
            sizes="(min-width: 1280px) 1200px, 100vw"
            className="block h-auto w-full"
          />
          {/* the first decision, outlined; box measured on the 1440x900 capture */}
          <span
            aria-hidden
            className="pointer-events-none absolute border-2 border-brand-signal"
            style={{ left: '34.4%', top: '25.6%', width: '45.9%', height: '18%' }}
          >
            <span className="absolute -top-4 right-3 inline-flex items-center gap-1.5 bg-brand-navy px-2.5 py-1 text-[12px] font-bold text-brand-paper">
              <span className="h-1.5 w-1.5 bg-brand-signal" />
              أهم قرار اليوم
            </span>
          </span>
        </div>
      </div>

      {/* phones: the same screen as it looks on a phone */}
      <div className="mx-auto w-[80%] max-w-[300px] overflow-hidden rounded-[36px] border-[9px] border-brand-navy bg-white md:hidden">
        <div className="relative aspect-[1170/2050] overflow-hidden">
          <Image
            src="/landing/ui-approvals-mobile.png"
            alt="مركز الموافقات على الجوال: توصيات بسببها وزر اعتماد وزر تجاهل"
            width={1170}
            height={2532}
            sizes="300px"
            className="absolute inset-x-0 top-0 block h-auto w-full"
          />
        </div>
      </div>

      <figcaption className="mt-4 text-center text-[13px] text-brand-slate md:text-start">
        لقطة من المنصة نفسها، بحساب تجريبي لمتجر عطور. الأرقام فيها للتوضيح.
      </figcaption>
    </figure>
  );
}
