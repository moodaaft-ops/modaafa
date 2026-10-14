import type { NextRequest } from 'next/server';
import { handleEmailLifecycleCron } from '@/lib/lifecycle/cron';

/**
 * Journeys, the weekly report and broadcasts in one call (replaces
 * /api/cron/stage-followups). Everything that matters is in lib/lifecycle/cron.ts.
 * Off by default: a real run needs EMAIL_LIFECYCLE_ENABLED=true; ?dry=1 plans
 * without sending or writing.
 */
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handleEmailLifecycleCron(req);
}
