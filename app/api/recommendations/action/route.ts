import { createRecommendationActionHandler } from '@/lib/recommendations/action-handler';

// The handler lives in lib/ so its control flow (approve, execute,
// approve_execute, dismiss) is testable with stubbed boundaries; route files
// cannot export helpers. See tests/jarvis-exec-ops.test.ts.
export const POST = createRecommendationActionHandler();
