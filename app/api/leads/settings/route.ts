import { NextRequest, NextResponse } from 'next/server';
import { authorizeLeadApi } from '@/lib/lead-loop/api';
import { saveSettings } from '@/lib/lead-loop/store';
import { buildLinkSnippet, cleanWhatsappText, normalizeWhatsappNumber, publicLinkUrl } from '@/lib/lead-loop/whatsapp';

const NUMBER_ERRORS: Record<string, string> = {
  empty: 'اكتب رقم الواتساب',
  invalid: 'الرقم مو صحيح، اكتبه بالشكل 05xxxxxxxx',
  not_mobile: 'الرقم السعودي لازم يكون جوال يبدأ بـ 05',
};

function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://ai.modaafa.com').replace(/\/+$/, '');
}

export async function POST(req: NextRequest) {
  const ctx = await authorizeLeadApi(req, 'lead_loop_settings');
  if (ctx instanceof NextResponse) return ctx;

  const number = normalizeWhatsappNumber(ctx.body.whatsapp_number);
  if (!number.ok) {
    return NextResponse.json({ error: `number_${number.reason}`, message: NUMBER_ERRORS[number.reason] }, { status: 400 });
  }
  const text = cleanWhatsappText(ctx.body.default_text);

  try {
    const settings = await saveSettings(ctx.admin, ctx.account.id, { whatsapp_number: number.number, default_text: text });
    const base = appBaseUrl();
    return NextResponse.json({
      ok: true,
      link: publicLinkUrl(base, settings.slug),
      snippet: buildLinkSnippet(base),
      whatsapp_number: settings.whatsapp_number,
      default_text: settings.default_text,
    });
  } catch (error) {
    console.error('lead loop settings save failed', { error: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ error: 'save_failed', message: 'ما انحفظ، جرب مرة ثانية' }, { status: 500 });
  }
}
