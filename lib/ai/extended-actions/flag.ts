/**
 * EXTENDED_ACTIONS_ENABLED gates every action type added by the media-buyer
 * upgrade (ad schedule, device and location modifiers, geo target type,
 * network settings, shared negative lists, Google recommendation triage).
 * Anything but the literal string "true" leaves behaviour exactly as before.
 */
export function isExtendedActionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXTENDED_ACTIONS_ENABLED === 'true';
}
