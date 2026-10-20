export function shadowModeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.SHADOW_MODE_ENABLED === 'true';
}
