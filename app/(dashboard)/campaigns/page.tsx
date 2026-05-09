export default function CampaignsPage() {
  const TITLE = "الحملات";
  const SUB = "إدارة حملات Google Ads";
  const EMPTY_TITLE = "لا توجد حملات بعد";
  const EMPTY_DESC = "ابدأ بإنشاء حملتك الأولى لإدارتها بذكاء عبر Modaafa";
  const NEW_BTN = "+ حملة جديدة";
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">{TITLE}</h1>
      <p className="text-ink-500 mb-8">{SUB}</p>
      <div className="bg-white rounded-2xl border border-ink-100 p-12 text-center">
        <div className="text-6xl mb-4">📢</div>
        <h2 className="text-xl font-semibold mb-2">{EMPTY_TITLE}</h2>
        <p className="text-ink-500 mb-6">{EMPTY_DESC}</p>
        <a href="/campaigns/new" className="inline-block px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold text-sm">{NEW_BTN}</a>
      </div>
    </div>
  );
}
