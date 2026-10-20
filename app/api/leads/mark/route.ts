import { NextRequest, NextResponse } from 'next/server';
import { authorizeLeadApi } from '@/lib/lead-loop/api';
import { parseMarkInput } from '@/lib/lead-loop/marking';
import { markLead } from '@/lib/lead-loop/store';

const PARSE_ERRORS: Record<string, string> = {
  invalid_status: 'اختر حالة صحيحة',
  invalid_value: 'القيمة لازم تكون رقم أكبر من صفر',
};

export async function POST(req: NextRequest) {
  const ctx = await authorizeLeadApi(req, 'lead_loop_mark');
  if (ctx instanceof NextResponse) return ctx;

  const leadId = String(ctx.body.lead_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return NextResponse.json({ error: 'invalid_lead' }, { status: 400 });

  const parsed = parseMarkInput(ctx.body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: PARSE_ERRORS[parsed.error] }, { status: 400 });
  }

  try {
    const result = await markLead(ctx.admin, ctx.account.id, leadId, parsed.input);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          message:
            result.error === 'locked_uploaded'
              ? 'هذا الليد انرفع لقوقل وما يتعدل'
              : 'ما لقينا هذا الليد',
        },
        { status: result.error === 'not_found' ? 404 : 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      status: result.patch.status,
      value_sar: result.patch.value_sar,
      upload_status: result.patch.upload_status,
    });
  } catch (error) {
    console.error('lead mark failed', { error: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ error: 'save_failed', message: 'ما انحفظ، جرب مرة ثانية' }, { status: 500 });
  }
}
