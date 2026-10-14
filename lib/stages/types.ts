/**
 * Shared vocabulary for user stages. These names are fixed across every
 * agent working on the platform: do not rename or add to them here without
 * changing the SQL in db/migrations/20261013_user_stages.sql as well.
 */
export const USER_STAGES = ['registered', 'connected', 'analysis_viewed', 'subscribed'] as const;
export type UserStage = (typeof USER_STAGES)[number];

export const USER_EVENT_TYPES = [
  'registration_completed',
  'welcome_email_sent',
  'onboarding_viewed',
  'connect_clicked',
  'ads_account_connected',
  'first_analysis_viewed',
  'subscription_paid',
] as const;
export type UserEventType = (typeof USER_EVENT_TYPES)[number];

/** The event that puts a user INTO a stage. `registered` is the starting point. */
export const STAGE_ENTRY_EVENT: Record<UserStage, UserEventType> = {
  registered: 'registration_completed',
  connected: 'ads_account_connected',
  analysis_viewed: 'first_analysis_viewed',
  subscribed: 'subscription_paid',
};

export function stageRank(stage: string | null | undefined): number {
  const index = USER_STAGES.indexOf(stage as UserStage);
  return index === -1 ? 0 : index + 1;
}

/** Mirrors public.stage_for_event(): only three events move the stage. */
export function stageForEvent(event: string): UserStage | null {
  switch (event) {
    case 'ads_account_connected':
      return 'connected';
    case 'first_analysis_viewed':
      return 'analysis_viewed';
    case 'subscription_paid':
      return 'subscribed';
    default:
      return null;
  }
}

export const STAGE_LABEL_AR: Record<UserStage, string> = {
  registered: 'سجّل',
  connected: 'ربط حساب الإعلانات',
  analysis_viewed: 'شاف نتيجة التحليل',
  subscribed: 'دفع الاشتراك',
};
