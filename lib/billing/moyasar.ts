/**
 * Moyasar payments for Saudi customers (mada, STC Pay, Apple Pay, Visa/MC).
 * https://moyasar.com/docs
 *
 * For SaaS subscriptions, we use the "tokenization + recurring charge" pattern.
 */

const MOYASAR_BASE = 'https://api.moyasar.com/v1';

interface MoyasarPaymentParams {
  amount_sar: number; // SAR
  description: string;
  callback_url: string;
  metadata?: Record<string, string>;
}

export async function createPayment(params: MoyasarPaymentParams) {
  const apiKey = process.env.MOYASAR_API_KEY;
  if (!apiKey) throw new Error('MOYASAR_API_KEY missing');

  const response = await fetch(`${MOYASAR_BASE}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.round(params.amount_sar * 100), // halalas
      currency: 'SAR',
      description: params.description,
      callback_url: params.callback_url,
      metadata: params.metadata ?? {},
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Moyasar payment creation failed: ${err}`);
  }

  return response.json();
}

export async function getPayment(paymentId: string) {
  const apiKey = process.env.MOYASAR_API_KEY;
  const response = await fetch(`${MOYASAR_BASE}/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}` },
  });
  return response.json();
}

/**
 * Verify webhook signature from Moyasar.
 * Moyasar sends signed webhooks via the Moyasar-Signature header.
 */
export function verifyMoyasarWebhook(payload: string, signature: string): boolean {
  // TODO: implement HMAC-SHA256 verification per Moyasar docs
  // For now, return true and implement once you have webhook secret
  return Boolean(signature && payload);
}
