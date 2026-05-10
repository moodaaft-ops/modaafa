'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const INDUSTRIES = [
  'تجارة إلكترونية',
  'عقار',
  'تعليم',
  'مطاعم وضيافة',
  'صحة وجمال',
  'خدمات احترافية',
  'صناعة',
  'سياحة وسفر',
  'أخرى',
];

export default function BusinessForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState(INDUSTRIES[0]);
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sector: industry, website }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'فشل حفظ البيانات');
      }
      router.push('/onboarding/connect');
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">
          اسم النشاط <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="مثل: متجر التميز"
          className="w-full px-4 py-3 rounded-xl border border-ink-200 focus:border-brand-500 outline-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">
          القطاع <span className="text-red-500">*</span>
        </label>
        <select
          required
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          className="w-full px-4 py-3 rounded-xl border border-ink-200 focus:border-brand-500 outline-none bg-white"
        >
          {INDUSTRIES.map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">
          الموقع الإلكتروني (اختياري)
        </label>
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://example.com"
          className="w-full px-4 py-3 rounded-xl border border-ink-200 focus:border-brand-500 outline-none"
        />
      </div>

      {error && <div className="text-red-500 text-sm text-center">{error}</div>}

      <button
        type="submit"
        disabled={submitting || !name}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold disabled:opacity-50 mt-2"
      >
        {submitting ? 'جاري الحفظ...' : 'متابعة'}
      </button>
    </form>
  );
}
