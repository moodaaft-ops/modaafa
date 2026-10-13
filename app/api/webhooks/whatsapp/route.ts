import { createWhatsAppWebhookHandler } from '@/lib/whatsapp/webhook';

export const runtime = 'nodejs';
// Meta expects an answer quickly and redelivers on failure. The handler does
// one lookup and one insert, so the default limit would be enough, but the
// explicit value keeps this route from silently inheriting a lower platform default.
export const maxDuration = 30;

const handler = createWhatsAppWebhookHandler();

export const GET = handler.GET;
export const POST = handler.POST;
