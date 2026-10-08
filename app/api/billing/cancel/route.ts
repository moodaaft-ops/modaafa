import { createServerClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { setStripeCancelAtPeriodEnd } from '@/lib/billing/stripe';
import { createCancelSubscriptionHandler } from '@/lib/billing/cancel-handler';

export const POST = createCancelSubscriptionHandler({
  isSameOriginRequest,
  getUserId: async () => {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.id ?? null;
  },
  checkRateLimit: async (userId, req) => {
    const result = await checkRateLimit({
      req,
      scope: 'billing_cancel',
      limit: 10,
      windowSeconds: 300,
      identifier: userId,
    });
    return result.allowed;
  },
  getActiveSubscriptionId: async (userId) => {
    const supabase = await createServerClient();
    const context = await getBillingCheckoutContext(supabase, userId);
    return context.activeSubscriptionId;
  },
  setCancelAtPeriodEnd: setStripeCancelAtPeriodEnd,
});
