import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createMessageForAgent, hasAIBackend } from '@/lib/ai/client';
import { planTurn } from '@/lib/chat-first/orchestrator';
import { understandMessage, type ModelCall } from '@/lib/chat-first/understand';
import type { ChatState } from '@/lib/chat-first/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const TOKEN_HASH = '4197d677fd10c21d67f20d6fdca98c79107af47d2bea49f2b0ef118c3a6a48db';
const headers = { 'Cache-Control': 'no-store' };

const state: ChatState = {
  accountLinked: true,
  accountName: 'متجر تجريبي',
  customerId: '0000000000',
  latestAudit: { id: 'demo', healthScore: 62, findingsCount: 7, estimatedMonthlyWaste: 340, ranAt: '2026-10-08T10:00:00Z' },
  recommendations: [
    { id: 'demo-1', title: 'أوقف كلمة تصرف ولا تبيع', description: 'الكلمة صرفت 90 دولار ولا جابت تحويل', severity: 'critical', status: 'pending', executable: true },
    { id: 'demo-2', title: 'قلل ميزانية حملة ضعيفة', description: 'تصرف 40% من الميزانية وتجيب 8% من التحويلات', severity: 'medium', status: 'pending', executable: true },
  ],
  subscriptionActive: false,
};

const SENTENCES = [
  'انا جديد وما اعرف من وين ابدا',
  'ليش اعلاناتي تصرف وما تجيب مبيعات',
  'وش اهم شي لازم اصلحه اول',
  'خلاص سوها بدالي كلها',
  'كيف اعرف اني اخسر فلوس على الاعلانات',
];


export async function GET(request: Request) {
  if (process.env.VERCEL_ENV !== 'preview') return new NextResponse(null, { status: 404, headers });
  const token = request.headers.get('x-live-check-token');
  if (!token || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(TOKEN_HASH, 'hex'))) {
    return new NextResponse(null, { status: 404, headers });
  }
  if (!hasAIBackend()) return NextResponse.json({ error: 'BACKEND_UNAVAILABLE' }, { status: 503, headers });
  const call: ModelCall = async ({ system, user, maxTokens }) => {
    const r = await createMessageForAgent('assistant', { max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    return r.content.filter((p) => p.type === 'text').map((p) => p.type === 'text' ? p.text : '').join('\n').trim() || null;
  };
  try {
    const results = [];
    for (const sentence of SENTENCES) {
      const u = await understandMessage(sentence, state, call);
      const turn = planTurn(sentence, state, u);
      results.push({ sentence, understood: u?.intent ?? 'null(fallback to rules)', turnIntent: turn.intent, actions: turn.actions.map((a) => a.action.type), executesDirectly: turn.actions.some((a) => a.action.type === 'execute'), reply: turn.reply });
    }
    return NextResponse.json(results, { headers });
  } catch {
    return NextResponse.json({ error: 'LIVE_CHECK_FAILED' }, { status: 502, headers });
  }
}
