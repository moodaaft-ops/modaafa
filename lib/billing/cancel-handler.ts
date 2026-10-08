import { NextRequest, NextResponse } from 'next/server';

export type CancelAction = 'cancel' | 'resume';

export type CancelHandlerDependencies = {
  isSameOriginRequest: (req: NextRequest) => boolean;
  getUserId: () => Promise<string | null>;
  checkRateLimit: (userId: string, req: NextRequest) => Promise<boolean>;
  getActiveSubscriptionId: (userId: string) => Promise<string | null>;
  setCancelAtPeriodEnd: (subscriptionId: string, cancel: boolean) => Promise<unknown>;
};

/** A form field is the only input; anything but an explicit "resume" is a cancel request. */
export function parseCancelAction(value: FormDataEntryValue | null): CancelAction {
  return value === 'resume' ? 'resume' : 'cancel';
}

function back(req: NextRequest, query: string) {
  return NextResponse.redirect(new URL(`/billing?${query}#cancel`, req.url), 303);
}

export function createCancelSubscriptionHandler(deps: CancelHandlerDependencies) {
  return async function POST(req: NextRequest) {
    if (!deps.isSameOriginRequest(req)) return back(req, 'error=invalid_origin');

    const userId = await deps.getUserId();
    if (!userId) return NextResponse.redirect(new URL('/login', req.url), 303);

    try {
      if (!(await deps.checkRateLimit(userId, req))) return back(req, 'error=too_many_requests');
    } catch {
      return back(req, 'error=security_service_unavailable');
    }

    let action: CancelAction = 'cancel';
    try {
      action = parseCancelAction((await req.formData()).get('action'));
    } catch {
      // No readable form body: treat as a plain cancel request from our own button.
    }

    // The subscription id comes from OUR table, filtered by the signed-in user,
    // never from the request body. A customer can only ever touch their own.
    let subscriptionId: string | null;
    try {
      subscriptionId = await deps.getActiveSubscriptionId(userId);
    } catch (error) {
      console.error('Failed to look up the live subscription for cancellation', error);
      return back(req, 'error=cancel_failed');
    }
    if (!subscriptionId) return back(req, 'error=no_live_subscription');

    try {
      await deps.setCancelAtPeriodEnd(subscriptionId, action === 'cancel');
    } catch (error) {
      console.error('Failed to update Stripe cancel_at_period_end', error);
      return back(req, 'error=cancel_failed');
    }

    return back(req, `cancel=${action === 'cancel' ? 'scheduled' : 'resumed'}`);
  };
}
