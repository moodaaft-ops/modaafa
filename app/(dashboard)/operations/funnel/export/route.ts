import { NextResponse } from 'next/server';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { funnelToCsv } from '@/lib/stages/funnel';
import { loadFunnelReport } from '@/lib/stages/load-funnel';
import { loadEmailReport } from '@/lib/lifecycle/load-email-report';
import type { EmailReport } from '@/lib/lifecycle/email-report';

export const dynamic = 'force-dynamic';

/** CSV of the stage funnel. Operators only; anyone else gets a plain 404. */
export async function GET() {
  const { user } = await getRequestAuthContext();
  if (!user || !isModaafaOperator(user.email)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const admin = createAdminClient();
    const report = await loadFunnelReport(admin);
    // The email table is extra: if it cannot be read the stage table still downloads, with one line saying so.
    let email: EmailReport | null = null;
    let emailNote: string | undefined;
    try {
      email = await loadEmailReport(admin);
    } catch (error) {
      console.error('[funnel-export] email report failed', error instanceof Error ? error.message : 'unknown');
      emailNote = 'تعذر قراءة أرقام رسائل البريد';
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(funnelToCsv(report, email, emailNote), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="modaafa-funnel-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[funnel-export] failed', error instanceof Error ? error.message : 'unknown');
    return new NextResponse('تعذر إنشاء الملف', { status: 500 });
  }
}
