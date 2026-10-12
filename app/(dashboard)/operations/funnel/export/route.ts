import { NextResponse } from 'next/server';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { funnelToCsv } from '@/lib/stages/funnel';
import { loadFunnelReport } from '@/lib/stages/load-funnel';

export const dynamic = 'force-dynamic';

/** CSV of the stage funnel. Operators only; anyone else gets a plain 404. */
export async function GET() {
  const { user } = await getRequestAuthContext();
  if (!user || !isModaafaOperator(user.email)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const report = await loadFunnelReport(createAdminClient());
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(funnelToCsv(report), {
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
