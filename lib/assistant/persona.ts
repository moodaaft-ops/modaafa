/**
 * The customer-facing assistant. One place for its name so a rename is one
 * line: the setup chat, the home screen, the brain's identity prompt and the
 * empty states all read it from here.
 *
 * The assistant carries the platform's own name: «مُضاعِف» is an agent noun
 * («the one who multiplies»), so the product and the one talking to the
 * customer are the same thing, and nobody mistakes it for a human employee.
 * It replaces the internal name «جارفس», which customers never see.
 */
export const ASSISTANT = {
  name: 'مُضاعِف',
  /** The one line under the name wherever the assistant introduces itself. */
  tagline: 'مساعدك في إعلانات قوقل',
} as const;
