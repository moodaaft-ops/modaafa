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
  customerIds,
  currentCustomerId,
  isPending,
}: {
  customerIds: string[];
  currentCustomerId: string;
  isPending: boolean;
}) {
  const router = useRouter();
  // On pending (first-time linking) we don't pre-select anything so the user
  // must make an explicit choice. On active (switch) we pre-select the
  // currently-linked account.
  const [selected, setSelected] = useState<string>(
    isPending ? '' : currentCustomerId
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!selected) return;
    if (!isPending && selected === currentCustomerId) {
      // Switch mode + same account → nothing to change
      router.push('/dashboard');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل ربط الحساب');
      }
      router.push('/dashboard?connected=1');
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      {customerIds.map((id) => {
        const isCurrent = !isPending && id === currentCustomerId;
        const isSelected = selected === id;
        return (
          <label
            key={id}
            className={`block p-4 rounded-xl border-2 cursor-pointer transition ${
              isSelected
                ? 'border-brand-500 bg-brand-50'
                : 'border-ink-100 hover:border-ink-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name="customer"
                value={id}
                checked={isSelected}
                onChange={() => setSelected(id)}
                className="w-4 h-4 accent-brand-600"
              />
              <div className="flex-1">
                <div className="font-medium font-mono">{formatCustomerId(id)}</div>
                <div className="text-xs text-ink-500">
                  حساب Google Ads
                  {isCurrent && (
                    <span className="ms-2 inline-block px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                      المرتبط حالياً
                    </span>
                  )}
                </div>
              </div>
            </div>
          </label>
        );
      })}

      {error && <div className="text-red-500 text-sm text-center">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={!selected || submitting}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold disabled:opacity-50 mt-4"
      >
        {submitting
          ? 'جاري الربط...'
          : isPending
            ? 'ربط الحساب المختار'
            : selected === currentCustomerId
              ? 'استمر بالحساب الحالي'
              : 'تبديل للحساب المختار'}
      </button>
    </div>
  );
}
