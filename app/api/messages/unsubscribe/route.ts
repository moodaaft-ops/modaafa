import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { verifyUnsubscribeToken } from '@/lib/messaging/unsubscribe';

/**
 * Unsubscribe from follow-up emails.
 *
 * GET shows a confirmation page (mail scanners open links, so a bare GET must
 * not change anything). POST performs the opt-out, from that page's button or
 * from a mail client's one-click List-Unsubscribe.
 */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

export async function GET(req: NextRequest) {
  const { u, t } = readParams(req);
  if (!u || !t || !verifyUnsubscribeToken(u, t)) return page('الرابط غير صالح', 'افتح الرابط من آخر رسالة وصلتك.', 400);

  const action = `/api/messages/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`;
  return page(
    'إيقاف رسائل المتابعة',
    'اضغط الزر وما توصلك رسائل متابعة من مُضاعِف. الرسائل المتعلقة بحسابك واشتراكك تبقى تصلك.',
    200,
    `<form method="post" action="${escapeAttr(action)}"><button type="submit" style="background:#0E1426;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:16px;font-weight:700;cursor:pointer">أوقف الرسائل</button></form>`
  );
}

export async function POST(req: NextRequest) {
  const { u, t } = readParams(req);
  if (!u || !t || !verifyUnsubscribeToken(u, t)) return page('الرابط غير صالح', 'افتح الرابط من آخر رسالة وصلتك.', 400);

  try {
    const admin = createAdminClient();
    const { error } = await admin.from('users').update({ messages_opt_out: true }).eq('id', u);
    if (error) throw error;
  } catch (error) {
    console.error('[unsubscribe] could not save opt-out', error instanceof Error ? error.message : 'unknown');
    return page('تعذر الحفظ', 'جرّب مرة ثانية بعد شوي.', 500);
  }
  return page('تم الإيقاف', 'ما توصلك رسائل متابعة بعد الحين.', 200);
}

function readParams(req: NextRequest) {
  return {
    u: req.nextUrl.searchParams.get('u') ?? '',
    t: req.nextUrl.searchParams.get('t') ?? '',
  };
}

function page(title: string, body: string, status: number, extra = '') {
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeAttr(title)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.8;color:#0E1426;max-width:480px;margin:60px auto;padding:0 20px"><h1 style="font-size:22px">${escapeAttr(title)}</h1><p>${escapeAttr(body)}</p>${extra}</body></html>`;
  return new NextResponse(html, { status, headers: PAGE_HEADERS });
}

function escapeAttr(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
