/**
 * Landing page check (gap item 5/45). Ships dark: with the flag off the Jarvis
 * tool is not registered and nothing here runs.
 */
export function landingCheckEnabled(env: Record<string, string | undefined> = process.env) {
  return env.LANDING_CHECK_ENABLED === 'true';
}
