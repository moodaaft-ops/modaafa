import { createHmac } from 'node:crypto';
import { zidStoreUrlSecret } from './signature';
export const ZID_ORDER_EVENTS = ['order.create', 'order.status.update', 'order.payment_status.update'] as const;
export const zidAutoRegistrationEnabled = (env: NodeJS.ProcessEnv = process.env) => env.ZID_WEBHOOK_AUTO_REGISTER_ENABLED === 'true';
export function zidWebhookDetails(storeId: string, env: Record<string, string | undefined> = process.env) {
  const { ZID_WEBHOOK_URL_SECRET: secret, ZID_WEBHOOK_USERNAME: username, ZID_WEBHOOK_PASSWORD: password } = env;
  const app = env.NEXT_PUBLIC_APP_URL;
  if (!secret || !username || !password || !app?.startsWith('https://')) return null;
  const url = new URL('/api/webhooks/zid', app);
  url.searchParams.set('s', zidStoreUrlSecret(secret, storeId)); url.searchParams.set('store', storeId);
  // Never reveal the master Basic Auth password to a merchant.
  const perStore = createHmac('sha256', password).update(`zid-basic:${storeId}`).digest('hex');
  return { url: url.toString(), username, password: perStore };
}
export async function registerZidWebhooks(args: { storeId: string; accessToken: string; authorization: string; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }) {
  const details = zidWebhookDetails(args.storeId, args.env);
  if (!details) return { status: 'manual' as const, registered: [] as string[] };
  const fetchImpl = args.fetchImpl ?? fetch;
  const registered: string[] = [];
  // Read before create: reconnecting should not duplicate subscriptions.
  const headers = { Authorization: `Bearer ${args.authorization}`, 'X-Manager-Token': args.accessToken, 'Content-Type': 'application/json', 'Accept-Language': 'en' };
  const listed = await fetchImpl('https://api.zid.sa/v1/managers/webhooks', { headers, signal: AbortSignal.timeout(10000) });
  if (!listed.ok) return { status: 'manual' as const, registered };
  const body = await listed.json(); const existing = Array.isArray(body.data) ? body.data : body.data?.webhooks ?? [];
  for (const event of ZID_ORDER_EVENTS) {
    if (existing.some((h: any) => h.event === event && h.target_url === details.url && h.active !== false)) { registered.push(event); continue; }
    const response = await fetchImpl('https://api.zid.sa/v1/managers/webhooks', { method: 'POST', headers,
      body: JSON.stringify({ event, target_url: details.url, original_id: args.storeId, conditions: {}, username: details.username, password: details.password }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: 'manual' as const, registered };
    registered.push(event);
  }
  return { status: 'registered' as const, registered };
}
