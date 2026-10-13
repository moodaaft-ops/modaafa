import { readSendConfig, type WhatsAppSendConfig } from './config';
import { toWhatsAppId } from './phone';
import { WHATSAPP_TEMPLATES, type WhatsAppTemplateId } from './templates';

export type WhatsAppSendResult =
  | { status: 'sent'; wamid: string }
  | { status: 'not_configured' }
  | { status: 'invalid_number' }
  | { status: 'invalid_params' }
  | {
      status: 'failed';
      /** Meta's error code when the API answered, otherwise undefined. */
      code?: number;
      message: string;
      /** True for network errors, 429 and 5xx: the same call may succeed later. */
      retryable: boolean;
    };

type ClientDeps = {
  fetchImpl?: typeof fetch;
  config?: WhatsAppSendConfig | null;
  timeoutMs?: number;
};

/** Open a conversation (or message outside the 24 hour window) with an approved template. */
export async function sendWhatsAppTemplate(
  input: { to: string; template: WhatsAppTemplateId; params: string[] },
  deps: ClientDeps = {},
): Promise<WhatsAppSendResult> {
  const spec = WHATSAPP_TEMPLATES[input.template];
  if (input.params.length !== spec.params || input.params.some((p) => !p.trim())) {
    return { status: 'invalid_params' };
  }

  return post(
    input.to,
    {
      type: 'template',
      template: {
        name: spec.name,
        language: { code: spec.language },
        components: [
          {
            type: 'body',
            parameters: input.params.map((text) => ({ type: 'text', text: text.trim() })),
          },
        ],
      },
    },
    deps,
  );
}

/**
 * Free text reply. WhatsApp rejects it unless the user wrote to us in the last
 * 24 hours, in which case the result is `failed` with Meta's error code.
 */
export async function sendWhatsAppText(
  input: { to: string; body: string },
  deps: ClientDeps = {},
): Promise<WhatsAppSendResult> {
  const body = input.body.trim();
  if (!body || body.length > 4096) return { status: 'invalid_params' };
  return post(input.to, { type: 'text', text: { body, preview_url: false } }, deps);
}

async function post(
  to: string,
  message: Record<string, unknown>,
  deps: ClientDeps,
): Promise<WhatsAppSendResult> {
  const config = deps.config === undefined ? readSendConfig() : deps.config;
  if (!config) return { status: 'not_configured' };

  const recipient = toWhatsAppId(to);
  if (!recipient) return { status: 'invalid_number' };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        ...message,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'network_error',
      retryable: true,
    };
  }

  const data = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { code?: number; message?: string };
  };

  const wamid = data.messages?.[0]?.id;
  if (response.ok && wamid) return { status: 'sent', wamid };

  return {
    status: 'failed',
    code: data.error?.code,
    message: (data.error?.message ?? `http_${response.status}`).slice(0, 300),
    retryable: response.status === 429 || response.status >= 500,
  };
}
