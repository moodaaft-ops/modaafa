export default function ReportsPage() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">التقارير</h1>
      <p className="text-ink-500 mb-8">تقارير أسبوعية وشهرية لأداء حساباتك</p>
      <div className="bg-white rounded-2xl border border-ink-100 p-12 text-center">
        <div className="text-6xl mb-4">📊</div>
        <h2 className="text-xl font-semibold mb-2">لا توجد تقارير بعد</h2>
        <p className="text-ink-500">التقرير الأول سيصدر بعد أسبوع من ربط حساب Google Ads</p>
      </div>
    </div>
  );
}
