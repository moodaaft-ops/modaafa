export default function OptimizerPage() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">المُحسِّن</h1>
      <p className="text-ink-500 mb-8">تحسينات تلقائية تجري يومياً على حساباتك</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-2xl border border-ink-100 p-6">
          <div className="flex items-center gap-2 text-emerald-600 mb-2"><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span className="text-sm font-medium">نشط</span></div>
          <div className="text-3xl font-bold">0</div>
          <div className="text-sm text-ink-500">إجراء منفّذ (الأسبوع)</div>
        </div>
        <div className="bg-white rounded-2xl border border-ink-100 p-6">
          <div className="text-sm text-ink-500 mb-1">توفير متوقع</div>
          <div className="text-3xl font-bold">— ر.س</div>
          <div className="text-sm text-ink-500 mt-1">على الحساب الشهري</div>
        </div>
        <div className="bg-white rounded-2xl border border-ink-100 p-6">
          <div className="text-sm text-ink-500 mb-1">آخر تشغيل</div>
          <div className="text-3xl font-bold">—</div>
          <div className="text-sm text-ink-500 mt-1">يومياً عند منتصف الليل</div>
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-ink-100 p-12 text-center">
        <div className="text-6xl mb-4">⚡</div>
        <h2 className="text-xl font-semibold mb-2">المُحسِّن بانتظار ربط حساب</h2>
        <p className="text-ink-500">عند ربط حساب Google Ads، سيبدأ المُحسِّن بإجراء تحسينات تلقائية يومياً</p>
      </div>
    </div>
  );
}
