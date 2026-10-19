/**
 * SHOPPING_HEALTH_ENABLED gates everything added by the shopping product
 * health work: the shopping_product reader, the Jarvis tool, the optimizer
 * snapshot block and the morning guard's disapproved-products rule. Only the
 * literal "true" turns it on; anything else leaves behaviour as it was.
 * (The listing-group tree actions are extended actions and need only
 * EXTENDED_ACTIONS_ENABLED.)
 */
export function isShoppingHealthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHOPPING_HEALTH_ENABLED === 'true';
}
