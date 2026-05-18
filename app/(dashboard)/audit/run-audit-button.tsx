'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RunAuditButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function handleRun() {
    setRunning(true);
    setError('');
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل تشغيل الفحص');
      }
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setRunning(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleRun}
        disabled={running}
        className="inline-block px-6 py-3 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-medium disabled:opacity-50"
      >
        {running ? 'جاري الفحص... (قد يستغرق دقيقة)' : 'تشغيل الفحص الآن'}
      </button>
      {error && (
        <div className="mt-4 text-sm text-red-600 max-w-md mx-auto">{error}</div>
      )}
    </div>
  );
}
