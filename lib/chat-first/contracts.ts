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
  /** action_payload.operation, used only to name the change on the approval card. */
  operation?: string | null;
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
  /**
   * Free-audit allowance as the SERVER sees it (PR57 ledger). Optional: absent
   * or 'unknown' means "could not read", which is never shown as exhausted;
   * the audit route stays the only authority.
   */
  freeAudit?: 'unknown' | 'exhausted' | 'in_progress' | 'available';
};

export type ChatAction =
  | { type: 'connect_account'; href: string }
  | { type: 'run_audit'; customerId: string }
  | { type: 'show_recommendation'; recommendationId: string }
  | { type: 'request_apply'; recommendationId: string }
  | { type: 'subscribe'; href: string }
  | { type: 'approve'; recommendationId: string }
  | { type: 'execute'; recommendationId: string }
  /** Approve and execute in one press (PR-J5 intent). Rendered as a form post, never sent to the chat route. */
  | { type: 'approve_execute'; recommendationId: string }
  /** «مو الحين»: dismisses the pending recommendation through the same guarded route. */
  | { type: 'dismiss'; recommendationId: string }
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
  | { kind: 'approval'; recommendationId: string; title: string; changes: string[] }
  /**
   * A change the brain prepared (prepare_change). Every number and name in it
   * was built on the server from evidence rows, never typed by the model.
   */
  | {
      kind: 'proposal';
      recommendationId: string;
      title: string;
      why: string;
      changes: string[];
      warnings: string[];
      /** V1 classification, shown only: 'small' could run on autopilot later, 'large' always asks. */
      size: 'small' | 'large';
      evidence: Array<{ label: string; value: string }>;
      /** False when this is an older open proposal the brain found instead of creating a duplicate. */
      created: boolean;
      /** Subscriber at the time of the turn: the card shows «اعتمد», otherwise a subscribe link. */
      canApprove: boolean;
      /** Live status, filled in when history is replayed so stale buttons disappear. */
      status?: ChatRecommendation['status'];
      /** ai_actions id of the execution, when it can still be rolled back from the chat. */
      undoActionId?: string;
    }
  /** Steps the customer does by hand (geo, schedule, tracking, new campaign). No execute button. */
  | { kind: 'manual_steps'; title: string; steps: string[] }
  /** A business fact saved from the customer's own words, with a delete button. */
  | { kind: 'memory_saved'; factId: string; fact: string; quote?: string }
  /**
   * The one permission question (spec 83, 5.2). The answer is stored by
   * /api/autopilot/consent; it never changes anything from voice.
   */
  | { kind: 'consent'; accountCustomerId: string; answered?: 'auto_small' | 'always_ask' };

export type ChatQuickAction = { label: string; action: ChatAction };

export type ChatTurn = {
  intent: ChatIntent;
  reply: string;
  cards: ChatCard[];
  actions: ChatQuickAction[];
  /** Short text for the voice reply (max 600 chars). Absent: the voice path speaks `reply`. */
  spoken?: string;
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
  /** 'jarvis' when the turn went through the Jarvis brain (or its fallback). */
  engine?: 'jarvis';
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
