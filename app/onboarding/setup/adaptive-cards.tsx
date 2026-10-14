'use client';

import { useId } from 'react';
import { Check, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { whatsappHelpUrl } from '@/lib/support/contact';
import type { FirstCampaignPlan, UnderstoodRow } from '@/lib/setup/adaptive/types';
import { SOURCE_TAG } from './adaptive-flow';

/**
 * The cards of the adaptive tree inside the transcript: what «مُضاعِف» saw in
 * the account, what he understood, the first-campaign plan and the two cards
 * of the agency ending. Same flat card language as the rest of the setup chat
 * (hairline border, 18px corners), no new colours or fonts.
 */

const card = 'rounded-[18px] border border-border/80 bg-card';

/** «اللي شفته»: plain facts from the account, small and muted, one row each. */
export function SeenBox({ rows }: { rows: string[] }) {
  return (
    <div className={cn(card, 'p-4')}>
      <p className="text-[12.5px] font-semibold text-muted-foreground">اللي شفته</p>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <li key={row} className="flex items-start justify-between gap-3 text-[13.5px] leading-6 text-muted-foreground">
            <span className="min-w-0">{row}</span>
            <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** «فهمت عليك»: one row per thing the tree knows, in the customer's words, with where it came from. */
export function UnderstoodCard({ rows }: { rows: UnderstoodRow[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(card, 'overflow-hidden')}>
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <h2 id={titleId} className="text-[19px] font-bold leading-8">
          فهمت عليك
        </h2>
        <span className="h-2.5 w-2.5 flex-shrink-0 bg-signal" aria-hidden />
      </div>
      <dl className="px-4 pb-2">
        {rows.map((row, index) => (
          <div key={`${row.label}-${index}`} className="border-t border-border/60 py-3 first:border-t-0">
            <dt className="text-[12.5px] leading-5 text-muted-foreground">{row.label}</dt>
            <dd className="mt-0.5 flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-[15.5px] font-semibold leading-7">{row.value}</span>
              <span className="flex-shrink-0 text-[11.5px] text-muted-foreground">{SOURCE_TAG[row.source]}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** «خطة أول حملة»: for an account that has no campaigns yet, or no account yet. */
export function FirstCampaignCard({ plan }: { plan: FirstCampaignPlan }) {
  const titleId = useId();
  return (
    <section id="plan-card" aria-labelledby={titleId} className={cn(card, 'scroll-mt-4 overflow-hidden')}>
      <div className="px-4 pb-4 pt-5">
        <h2 id={titleId} className="text-[24px] font-bold leading-10">
          {plan.title}
        </h2>
        <p className="mt-1 text-[16px] font-semibold leading-8">{plan.campaign}</p>
        <p className="mt-2 inline-flex max-w-full rounded-full border border-border-strong/60 px-3 py-0.5 text-[12.5px] leading-6 text-foreground">
          الميزانية: {plan.budgetLine}
        </p>
      </div>
      <ul className="space-y-3.5 border-t border-border/70 px-4 py-4">
        {plan.items.map((item) => (
          <li key={item.label}>
            <p className="text-[14.5px] font-semibold leading-7">{item.label}</p>
            <p className="mt-0.5 text-[14px] leading-7 text-muted-foreground">{item.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «أسئلة تسألها وكالتك»: for an account somebody else manages. Questions to put to them, nothing to execute. */
export function AgencyQuestionsCard({ questions }: { questions: string[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(card, 'overflow-hidden')}>
      <div className="px-4 pb-1 pt-4">
        <h2 id={titleId} className="text-[19px] font-bold leading-8">
          أسئلة تسألها وكالتك
        </h2>
        <p className="mt-0.5 text-[13px] leading-6 text-muted-foreground">من اللي طلع في فحص حسابك</p>
      </div>
      <ul className="px-4 pb-2">
        {questions.map((question) => (
          <li key={question} className="flex items-start gap-2.5 border-t border-border/60 py-3 first:border-t-0">
            <span className="mt-3 h-1.5 w-1.5 flex-shrink-0 bg-signal" aria-hidden />
            <span className="min-w-0 text-[14.5px] leading-7">{question}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «خل فريق مُضاعفة يديرها عنك»: one line and a WhatsApp link, no other pitch. */
export function FullManagementCard({ email }: { email: string | null }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(card, 'p-4')}>
      <h2 id={titleId} className="text-[17px] font-bold leading-8">
        خل فريق مُضاعفة يديرها عنك
      </h2>
      <p className="mt-1 text-[14px] leading-7 text-muted-foreground">لو تبي فريقنا يدير حسابك لك، كلمنا على الواتساب ونرتبها.</p>
      <a
        href={whatsappHelpUrl('full_management', email)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex min-h-[52px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-start text-[15px] font-semibold text-foreground transition-colors hover:bg-muted"
      >
        <MessageCircle className="h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden />
        كلمنا على الواتساب
      </a>
    </section>
  );
}
