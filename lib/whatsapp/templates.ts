/**
 * Message templates registered in WhatsApp Manager.
 *
 * WhatsApp only lets a business open a conversation with a pre-approved
 * template; free text is allowed only inside 24 hours after the user's last
 * message. The names here must match the approved template names exactly, and
 * `params` is the number of {{n}} placeholders in the approved body.
 *
 * The approved wording lives in Meta, not here. The proposed copy is in
 * claude/103-whatsapp-channel-20261013.md.
 */
export const WHATSAPP_TEMPLATES = {
  /** Signed up but never connected a Google Ads account. {{1}} = first name. */
  connect_reminder: { name: 'modaafa_connect_reminder', language: 'ar', params: 1 },
  /** The first audit finished. {{1}} = first name. */
  audit_ready: { name: 'modaafa_audit_ready', language: 'ar', params: 1 },
} as const;

export type WhatsAppTemplateId = keyof typeof WHATSAPP_TEMPLATES;
