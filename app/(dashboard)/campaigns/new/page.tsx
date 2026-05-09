'use client';
import { useState } from 'react';

export default function NewCampaignPage() {
  const [brief, setBrief] = useState('');
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-3xl font-bold mb-2">حملة جديدة</h1>
      <p className="text-ink-500 mb-8">صف فكرتك بالعربية وسيقوم Claude ببناء هيكل الحملة الكامل</p>
      <div className="bg-white rounded-2xl border border-ink-100 p-8">
        <label className="block text-sm font-medium mb-2">وصف الحملة</label>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="مثال: أبغى حملة لمنتج عطر رجالي بميزانية 3000 ر.س — استهدف الرياض وجدة"
          className="w-full h-40 px-4 py-3 rounded-xl border border-ink-200 focus:border-brand-500 outline-none resize-none"
        />
        <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
          ⚠️ منشئ الحملات الذكي يحتاج Anthropic API Key. أضفه في إعدادات Vercel ثم أعد المحاولة.
        </div>
        <button disabled className="mt-6 px-6 py-3 rounded-xl bg-ink-200 text-ink-500 font-semibold cursor-not-allowed">
          بناء الحملة (قريباً)
        </button>
      </div>
    </div>
  );
}
