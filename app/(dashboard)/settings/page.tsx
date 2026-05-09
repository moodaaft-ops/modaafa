export default function SettingsPage() {
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-3xl font-bold mb-2">الإعدادات</h1>
      <p className="text-ink-500 mb-8">إدارة حسابك وربط Google Ads</p>
      <div className="bg-white rounded-2xl border border-ink-100 p-8 mb-6">
        <h2 className="text-xl font-semibold mb-4">ربط Google Ads</h2>
        <p className="text-ink-500 mb-6">اربط حساب Google Ads الخاص بك للبدء بالأتمتة</p>
        <a href="/api/auth/google-ads/start" className="inline-block px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold text-sm">ربط حساب Google Ads</a>
      </div>
      <div className="bg-white rounded-2xl border border-ink-100 p-8 mb-6">
        <h2 className="text-xl font-semibold mb-4">إعدادات التحسينات</h2>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">وضع الطيار الآلي</div>
            <p className="text-sm text-ink-500">السماح للمُحسِّن بتنفيذ تحسينات تلقائياً</p>
          </div>
          <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-xs">غير مفعل</span>
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-ink-100 p-8">
        <h2 className="text-xl font-semibold mb-4">الحساب</h2>
        <form action="/api/auth/signout" method="post">
          <button type="submit" className="px-5 py-2.5 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 font-semibold text-sm">تسجيل الخروج</button>
        </form>
      </div>
    </div>
  );
}
