export function agencyHandoffEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENCY_HANDOFF_ENABLED === 'true';
}
