import { createServerClient } from '@/lib/supabase/server';
import { timeAgoAr } from '@/lib/utils';

export default async function OptimizerPage() {
  const supabase = createServerClient();
  const { data: recommendations } = await supabase
    .from('recommendations')
    .select('id, title, description, severity, status, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  const { data: actions } = await supabase
    .from('ai_actions')
    .select('id, action_type, description_ar, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 px-8 py-4 backdrop-blur-xl">
        <h1 className="text-xl font-bold">المُحسِّن</h1>
        <p className="text-sm text-ink-500">التوصيات والإجراءات التي نفذتها المنصة أو تنتظر موافقة.</p>
      </header>
      <div className="grid gap-6 p-8 lg:grid-cols-2">
        <section className="rounded-lg border border-ink-100 bg-white">
          <div className="border-b border-ink-100 p-5 font-bold">مركز الموافقات</div>
          <div className="divide-y divide-ink-100">
            {(recommendations ?? []).length === 0 ? (
              <div className="p-8 text-sm text-ink-500">لا توجد توصيات بعد.</div>
            ) : (
              (recommendations ?? []).map((item: any) => (
                <div key={item.id} className="p-5">
                  <div className="font-semibold">{item.title}</div>
                  <p className="mt-1 text-sm text-ink-500">{item.description}</p>
                  <div className="mt-3 text-xs text-ink-400">{item.severity} · {item.status}</div>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="rounded-lg border border-ink-100 bg-white">
          <div className="border-b border-ink-100 p-5 font-bold">سجل التنفيذ</div>
          <div className="divide-y divide-ink-100">
            {(actions ?? []).length === 0 ? (
              <div className="p-8 text-sm text-ink-500">لا توجد إجراءات منفذة بعد.</div>
            ) : (
              (actions ?? []).map((action: any) => (
                <div key={action.id} className="p-5">
                  <div className="font-semibold">{action.description_ar}</div>
                  <div className="mt-2 text-xs text-ink-400">{action.action_type} · {timeAgoAr(action.created_at)}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}
