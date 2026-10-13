import { isConfiguredEnv } from '@/lib/platform/env';

/**
 * WhatsApp channel configuration. The whole channel ships dark: nothing is
 * sent and the webhook refuses traffic until WHATSAPP_ENABLED is "true" and
 * the credentials below are set in the deployment environment.
 *
 * Secrets are read at call time, never at import time, so a missing value
 * degrades the channel instead of breaking the build.
 */

// Meta retires Graph API versions roughly two years after release. Override
// with WHATSAPP_GRAPH_VERSION when this one gets close to retirement.
export const DEFAULT_GRAPH_VERSION = 'v23.0';

export type WhatsAppSendConfig = {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
};

export type WhatsAppWebhookConfig = {
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
};

type Env = Record<string, string | undefined>;

function enabled(env: Env) {
  return env.WHATSAPP_ENABLED?.trim().toLowerCase() === 'true';
}

export function readSendConfig(env: Env = process.env): WhatsAppSendConfig | null {
  if (!enabled(env)) return null;
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!isConfiguredEnv(accessToken) || !isConfiguredEnv(phoneNumberId)) return null;
  const version = env.WHATSAPP_GRAPH_VERSION;
  return {
    accessToken: accessToken.trim(),
    phoneNumberId: phoneNumberId.trim(),
    graphVersion: isConfiguredEnv(version) ? version.trim() : DEFAULT_GRAPH_VERSION,
  };
}

export function readWebhookConfig(env: Env = process.env): WhatsAppWebhookConfig | null {
  if (!enabled(env)) return null;
  const appSecret = env.WHATSAPP_APP_SECRET;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (
    !isConfiguredEnv(appSecret) ||
    !isConfiguredEnv(verifyToken) ||
    !isConfiguredEnv(phoneNumberId)
  ) {
    return null;
  }
  return {
    appSecret: appSecret.trim(),
    verifyToken: verifyToken.trim(),
    phoneNumberId: phoneNumberId.trim(),
  };
}

export function inboundAlertsEnabled(env: Env = process.env) {
  return env.WHATSAPP_INBOUND_ALERT?.trim().toLowerCase() === 'true';
}
