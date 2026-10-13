/**
 * The customer-facing assistant. One place for its name so a rename is one
 * line: the setup chat, the home screen, the brain's identity prompt and the
 * empty states all read it from here.
 *
 * «زياد» comes from «زيادة», the same idea as «مُضاعِف» said as a person. It
 * replaces the internal name «جارفس», which customers never see.
 */
export const ASSISTANT = {
  name: 'زياد',
  /** The one line under the name wherever the assistant introduces itself. */
  tagline: 'مساعدك في إعلانات قوقل',
} as const;
