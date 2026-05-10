'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

function formatCustomerId(id: string): string {
  // Google Ads IDs are 10 digits — format as ###-###-####
  const digits = id.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return id;
}

export default function SelectAccountForm({
  sessionId,
  customerIds,
}: {
  sessionId: string;
  customerIds: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(customerIds[0] ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!selected) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/auth/google-ads/select-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, customerId: selected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'فشل ربط الحساب');
      }
      router.push('/dashboard?connected=1');
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      {customerIds.map((id) => (
        <label
          key={id}
          className={`block p-4 rounded-xl border-2 cursor-pointer transition ${
            selected === id
              ? 'border-brand-500 bg-brand-50'
              : 'border-ink-100 hover:border-ink-200'
          }`}
        >
          <div className="flex items-center gap-3">
            <input
              type="radio"
              name="customer"
              value={id}
              checked={selected === id}
              onChange={() => setSelected(id)}
              className="w-4 h-4 accent-brand-600"
            />
            <div>
              <div className="font-medium font-mono">{formatCustomerId(id)}</div>
              <div className="text-xs text-ink-500">حساب Google Ads</div>
            </div>
          </div>
        </label>
      ))}

      {error && <div className="text-red-500 text-sm text-center">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={!selected || submitting}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold disabled:opacity-50 mt-4"
      >
        {submitting ? 'جاري الربط...' : 'ربط الحساب المختار'}
      </button>
    </div>
  );
}
