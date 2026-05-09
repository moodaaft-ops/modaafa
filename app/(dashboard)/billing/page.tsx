export default function BillingPage() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">الفوترة</h1>
      <p className="text-ink-500 mb-8">إدارة الاشتراك ووسائل الدفع</p>
      <div className="bg-white rounded-2xl border border-ink-100 p-8 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">خطتك الحالية</h2>
          <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">نشط</span>
        </div>
        <div className="text-3xl font-bold mb-1">الباقة التجريبية</div>
        <p className="text-ink-500">جرّب كل ميزات Modaafa لمدة 14 يوماً مجاناً</p>
      </div>
      <div className="bg-white rounded-2xl border border-ink-100 p-12 text-center">
        <div className="text-6xl mb-4">💳</div>
        <h2 className="text-xl font-semibold mb-2">الدفع قريباً</h2>
        <p className="text-ink-500">Stripe و Moyasar سيفعلان عند إضافة مفاتيح API الحقيقية</p>
      </div>
    </div>
  );
}
