'use client';

import { useState } from 'react';

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older in-app browsers: the field is selectable, so the link can still be copied by hand.
    }
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        readOnly
        value={link}
        dir="ltr"
        onFocus={(e) => e.currentTarget.select()}
        aria-label="رابط الإحالة"
        className="h-11 min-w-0 flex-1 border border-border bg-background px-3 font-mono text-sm text-foreground"
      />
      <button type="button" onClick={copy} className="h-11 bg-foreground px-5 text-sm font-semibold text-background">
        {copied ? 'اننسخ' : 'انسخ الرابط'}
      </button>
    </div>
  );
}
