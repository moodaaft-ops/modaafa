'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function HandledButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    if (busy) return;
    setBusy(true);
    const res = await fetch('/api/operations/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) router.refresh();
  }
  return (
    <button type="button" onClick={run} disabled={busy} className="mt-2 h-8 border border-border px-3 text-xs font-semibold disabled:opacity-60">
      تم التواصل
    </button>
  );
}
