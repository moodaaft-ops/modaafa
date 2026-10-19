import type { LandingCheckReport, LandingCheckStore } from './run';

/** Supabase-backed store. The service role writes; owners never read this table directly. */
export function supabaseLandingCheckStore(admin: any): LandingCheckStore {
  return {
    async latest(accountId) {
      const { data, error } = await admin
        .from('landing_checks')
        .select('checked_at, report')
        .eq('account_id', accountId)
        .order('checked_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const report = data.report as LandingCheckReport | null;
      if (!report || report.version !== 1 || !Array.isArray(report.pages)) return null;
      return { checked_at: String(data.checked_at), report };
    },
    async save(accountId, report) {
      const { error } = await admin
        .from('landing_checks')
        .insert({ account_id: accountId, checked_at: report.checkedAt, report });
      if (error) throw error;
    },
  };
}
