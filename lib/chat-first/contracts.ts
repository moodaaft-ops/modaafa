/**
 * Contracts owned by the chat-first task (05). Anything marked "task 04" is a
 * hand-over: the chat reads it, it does not implement it.
 */

export type ChatRecommendation = {
  id: string;
  title: string;
  description: string | null;
  severity: 'critical' | 'medium' | 'growth' | null;
  status: 'pending' | 'approved' | 'executing' | 'applied' | 'dismissed' | 'failed';
  /** True only when the stored payload can actually be pushed to Google Ads. */
  executable: boolean;
};

export type ChatAuditSummary = {
  id: string;
  healthScore: number | null;
  findingsCount: number;
  estimatedMonthlyWaste: number | null;
  ranAt: string;
};

/** Everything the orchestrator may know. It never receives raw tokens or other users' rows. */
export type ChatState = {
  accountLinked: boolean;
  accountName: string | null;
  customerId: string | null;
  latestAudit: ChatAuditSummary | null;
  recommendations: ChatRecommendation[];
  subscriptionActive: boolean;
};

export type ChatAction =
  | { type: 'connect_account'; href: string }
  | { type: 'run_audit'; customerId: string }
  | { type: 'show_recommendation'; recommendationId: string }
  | { type: 'request_apply'; recommendationId: string }
  | { type: 'subscribe'; href: string }
  | { type: 'approve'; recommendationId: string }
  | { type: 'execute'; recommendationId: string }
  | { type: 'open_dashboard'; href: string }
  | { type: 'say'; text: string };

export type ChatCard =
  | { kind: 'status'; title: string; lines: string[] }
  | {
      kind: 'audit_result';
      healthScore: number | null;
      findingsCount: number;
      estimatedMonthlyWaste: number | null;
      ranAt: string;
    }
  | {
      kind: 'recommendation';
      id: string;
      title: string;
      description: string | null;
      severity: ChatRecommendation['severity'];
      status: ChatRecommendation['status'];
    }
  | { kind: 'subscription_required'; reason: string }
  | { kind: 'approval'; recommendationId: string; title: string; changes: string[] };

export type ChatQuickAction = { label: string; action: ChatAction };

export type ChatTurn = {
  intent: ChatIntent;
  reply: string;
  cards: ChatCard[];
  actions: ChatQuickAction[];
};

export type ChatIntent =
  | 'connect'
  | 'run_audit'
  | 'show_result'
  | 'recommend'
  | 'apply'
  | 'rerun'
  | 'explain'
  | 'guidance'
  | 'ambiguous';

/** How a turn was understood, so the UI and tests can tell rules from model. */
export type ChatLanguageMeta = {
  source: 'rules' | 'model';
  /** Set when the free/subscriber language allowance stopped the model. */
  limited?: { scope: 'free' | 'subscriber'; resetsAt: string | null };
  /** Set when the model path failed and the rules answered instead. */
  degraded?: boolean;
};

/**
 * Task 04 contract. The chat promises: the first full audit and ONE re-run per
 * account are free, applying needs an active subscription. Today the audit
 * route still demands a subscription for every run (consumeFeatureUsage), so a
 * visitor without one gets a 402 from it and the chat shows that answer as-is.
 * Task 04 must add a per-account free allowance there; nothing in the chat
 * has to change when it lands.
 */
export const FREE_AUDIT_POLICY = { freeFullAudits: 1, freeReruns: 1, applyRequiresSubscription: true } as const;

/**
 * Server-side allowance for the language layer (model calls) per user per
 * 24 hours. Free users still get every button and every rule-based answer
 * after the allowance ends, so the chat never closes before first value.
 */
export const LANGUAGE_ALLOWANCE = { free: 12, subscriber: 80, windowSeconds: 86_400 } as const;
