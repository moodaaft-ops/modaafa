import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { LayoutDashboard, ShieldCheck, Megaphone, Zap, BarChart3, CreditCard, Settings } from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
  { href: '/audit', label: 'فحص الحساب', icon: ShieldCheck, badge: 'جديد' },
  { href: '/campaigns', label: 'الحملات', icon: Megaphone },
  { href: '/optimizer', label: 'المُحسِّن', icon: Zap, status: 'active' },
  { href: '/reports', label: 'التقارير', icon: BarChart3 },
  { href: '/billing', label: 'الفوترة', icon: CreditCard },
  { href: '/settings', label: 'الإعدادات', icon: Settings },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('user_id', user.id)
    .single();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 bg-white border-l border-ink-100 flex flex-col flex-shrink-0">
        <div className="p-6 border-b border-ink-100">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 flex items-center justify-center text-white font-bold text-xl">×</div>
            <div>
              <div className="font-bold">مُضاعِف</div>
              <div className="text-xs text-ink-500">{business?.name ?? user.email}</div>
            </div>
          </Link>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto scrollbar-thin">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-6 py-3 text-sm text-ink-600 hover:bg-ink-50 transition"
              >
                <Icon className="w-5 h-5" />
                <span>{item.label}</span>
                {item.badge && (
                  <span className="mr-auto bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full">
                    {item.badge}
                  </span>
                )}
                {item.status === 'active' && (
                  <span className="mr-auto flex items-center gap-1 text-xs text-emerald-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    نشط
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-ink-100">
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="w-full text-sm text-ink-500 hover:text-ink-900 text-right">
              تسجيل الخروج
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-ink-50 scrollbar-thin">{children}</main>
    </div>
  );
}
