import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { verifyLeadOptOutToken } from '@/lib/messaging/opt-out';

/**
 * Unsubscribe link in the lead follow-up email. Same two-step as
 * /api/messages/opt-out: GET only shows a button (mail scanners open every
 * link), the state change is the POST that mail clients also send for
 * List-Unsubscribe-Post.
 */
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

function page(body: string, status = 200) {
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>إيقاف رسائل المتابعة</title></head><body style="margin:0;background:#F6F7F9;font-family:Arial,sans-serif;color:#0E1426"><main style="max-width:480px;margin:12vh auto;padding:0 16px;line-height:1.9"><h1 style="font-size:22px;margin:0 0 16px">مُضاعِف</h1>${body}</main></body></html>`;
  return new NextResponse(html, { status, headers: HTML_HEADERS });
}

const INVALID = '<p>الرابط غير صالح أو ناقص. رد على أي إيميل منا وبنوقف الرسائل لك يدوياً.</p>';

export function GET(req: NextRequest) {
  const l = req.nextUrl.searchParams.get('l');
  const t = req.nextUrl.searchParams.get('t');
  if (!verifyLeadOptOutToken(l, t)) return page(INVALID, 400);
  const action = `/api/leads/opt-out?l=${encodeURIComponent(l!)}&t=${encodeURIComponent(t!)}`;
  return page(
    `<p>تبي نوقف رسائل المتابعة اللي توصلك على إيميلك؟</p><form method="post" action="${action}"><button type="submit" style="background:#0E1426;color:#fff;border:0;border-radius:6px;padding:12px 24px;font-size:16px;font-weight:700;cursor:pointer">إيقاف الرسائل</button></form>`
  );
}

export async function POST(req: NextRequest) {
  const l = req.nextUrl.searchParams.get('l');
  const t = req.nextUrl.searchParams.get('t');
  if (!verifyLeadOptOutToken(l, t)) return page(INVALID, 400);

  try {
    const { error } = await createAdminClient()
      .from('visitor_leads')
      .update({ messages_opt_out: true, messages_opt_out_at: new Date().toISOString() })
      .eq('id', l!)
      .eq('messages_opt_out', false);
    if (error) throw error;
  } catch (error) {
    console.error('lead opt-out failed', error);
    return page('<p>صار خلل عندنا وما قدرنا نوقف الرسائل. جرّب بعد شوي أو رد على الإيميل.</p>', 500);
  }
  return page('<p>تم. ما راح تصلك رسائل المتابعة بعد اليوم.</p>');
}
