import Image from 'next/image';
import Link from 'next/link';
import { SquareField } from './square-field';

/**
 * The navy side of /register and /login on wide screens: what the visitor is
 * about to get, shown with real crops of the product (demo account). Plain
 * markup only, so the client login page can render it too.
 */
export function AuthPanel({ title, lines }: { title: string; lines: string[] }) {
  return (
    <aside className="relative isolate hidden overflow-hidden bg-brand-navy text-brand-paper dark:bg-[#0A0F1E] lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
      <SquareField tone="navy" id="sq-auth" fade="edges" />
      <Link href="/" aria-label="مُضاعِف، الصفحة الرئيسية" className="w-fit">
        <Image
          src="/brand/modaafa-lockup-reversed.svg"
          alt="مُضاعِف"
          width={153}
          height={36}
          style={{ width: 153, height: 36 }}
        />
      </Link>

      <div className="my-12">
        <p className="max-w-[30rem] font-display text-[2.1rem] font-semibold leading-[1.3] text-balance">{title}</p>
        <ol className="mt-8 max-w-[30rem] space-y-4">
          {lines.map((line, i) => (
            <li key={line} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 text-[16px] leading-8 text-brand-paper/80">
              <span className="mt-0.5 flex h-7 w-7 items-center justify-center border border-brand-paper/40 text-[13px] font-semibold numeric">
                {i + 1}
              </span>
              {line}
            </li>
          ))}
        </ol>
      </div>

      <figure className="max-w-[30rem]">
        <div className="max-w-[24rem] overflow-hidden rounded-[22px] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)]">
          <Image
            src="/landing/chat-decision-m.png"
            alt="قرار من مُضاعِف بسببه، مع زر اعتمد وزر مو الحين"
            width={720}
            height={488}
            sizes="24rem"
            className="block h-auto w-full"
          />
        </div>
        <figcaption className="mt-3 text-[12.5px] text-brand-paper/55">
          لقطة من المنصة بحساب تجريبي. ما يتغيّر شي في حسابك إلا باعتمادك.
        </figcaption>
      </figure>
    </aside>
  );
}
