'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';

export type RecentChangeItem = {
  id: string;
  /** What changed, as stored when it ran. */
  text: string;
  /** «قبل 3 ساعات», worded on the server so the first paint and the hydrated page agree. */
  when: string;
};

/** The approvals screen's execution log: where the rest of the changes live. */
export const ALL_CHANGES_HREF = '/optimizer#execution-log';

/**
 * «التغييرات الأخيرة»: what Modaafa changed on the account that can still be
 * undone, each with «رجّعه». It is the simple shell's only undo, so it renders
 * for someone without a subscription too (undoing is never gated).
 *
 * «رجّعه» asks once more in one line, then the plain form posts to the SAME
 * guarded route as the approvals screen. The route re-checks the owner, the
 * 30 days and the account, and comes back to /home with the result.
 */
export function RecentChanges({
  items,
  more,
  className,
}: {
  items: RecentChangeItem[];
  more: boolean;
  className?: string;
}) {
  const titleId = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className={className}>
      <h2 id={titleId} className="text-[15px] font-bold">
        التغييرات الأخيرة
      </h2>
      <p className="mt-0.5 text-[13px] leading-6 text-muted-foreground">تقدر ترجّع أي تغيير خلال 30 يوم.</p>
      <ul className="mt-2.5 space-y-1 rounded-[18px] border border-border/80 bg-card p-2">
        {items.map((item) => (
          <ChangeRow key={item.id} item={item} />
        ))}
      </ul>
      {more && (
        <Link
          href={ALL_CHANGES_HREF}
          className="mt-1.5 inline-flex min-h-9 items-center rounded-full px-3 text-[13.5px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          شوف كل التغييرات
        </Link>
      )}
    </section>
  );
}

function ChangeRow({ item }: { item: RecentChangeItem }) {
  const [confirming, setConfirming] = useState(false);
  const textId = useId();
  return (
    <li className="rounded-[14px] bg-muted/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[13rem]">
          <p id={textId} className="line-clamp-2 text-[14.5px] font-semibold leading-7">
            {item.text}
          </p>
          <p className="text-[12.5px] leading-5 text-muted-foreground">{item.when}</p>
        </div>
        {!confirming && (
          <button
            type="button"
            aria-describedby={textId}
            onClick={() => setConfirming(true)}
            className="inline-flex h-9 flex-shrink-0 items-center rounded-full border border-border bg-background px-4 text-[13.5px] font-bold hover:bg-muted"
          >
            رجّعه
          </button>
        )}
      </div>
      {confirming && (
        <form method="post" action="/api/actions/rollback" className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="action_id" value={item.id} />
          <input type="hidden" name="next" value="/home" />
          <p className="w-full text-[13.5px] leading-6">ترجّع هذا التعديل؟</p>
          <PendingSubmitButton
            pendingLabel="جاري التراجع..."
            className="h-9 rounded-full bg-primary px-4 text-[13.5px] font-bold text-primary-foreground"
          >
            إيه، رجّعه
          </PendingSubmitButton>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="inline-flex h-9 items-center rounded-full border border-border bg-background px-4 text-[13.5px] font-bold hover:bg-muted"
          >
            لا، خلّه
          </button>
        </form>
      )}
    </li>
  );
}
