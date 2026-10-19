import { createPartner, payOutPartner, resolveHeldCommission, setPartnerStatus } from './store';

type Db = any;
export type OpsResult = { status: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['active', 'paused', 'banned']);
const METHODS = new Set(['bank_transfer', 'wise', 'stripe_connect', 'other']);
const bad = (error: string): OpsResult => ({ status: 400, body: { ok: false, error } });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * What the operations page can do to the programme. Every input is checked here
 * before anything touches the database; the money itself is decided by the SQL
 * functions, never by the browser. `actorId` is the signed-in operator.
 */
export async function runPartnerAction(db: Db, actorId: string, input: unknown): Promise<OpsResult> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (body.action) {
    case 'create': {
      const rate = body.commission_rate === '' || body.commission_rate == null ? null : Number(body.commission_rate);
      if (rate !== null && !(rate >= 0 && rate <= 0.5)) return bad('bad_rate');
      const created = await createPartner(db, {
        code: str(body.code, 40),
        displayName: str(body.display_name, 80),
        email: str(body.email, 200),
        phone: str(body.phone, 30) || null,
        commissionRate: rate,
      });
      return created.ok ? { status: 200, body: { ok: true, code: created.code } } : { status: created.error === 'duplicate' ? 409 : 400, body: { ok: false, error: created.error } };
    }
    case 'status': {
      const id = str(body.partner_id, 40);
      const status = str(body.status, 12);
      if (!UUID.test(id) || !STATUSES.has(status)) return bad('bad_input');
      await setPartnerStatus(db, id, status as 'active' | 'paused' | 'banned');
      return { status: 200, body: { ok: true } };
    }
    case 'resolve_held': {
      const id = str(body.commission_id, 40);
      if (!UUID.test(id) || typeof body.release !== 'boolean') return bad('bad_input');
      const result = await resolveHeldCommission(db, id, body.release, str(body.note, 80) || null);
      return { status: 200, body: { ok: true, result } };
    }
    case 'pay_out': {
      const id = str(body.partner_id, 40);
      const currency = str(body.currency, 3).toUpperCase();
      const method = str(body.method, 20);
      const reference = str(body.reference, 120);
      if (!UUID.test(id) || !/^[A-Z]{3}$/.test(currency) || !METHODS.has(method)) return bad('bad_input');
      // The transfer reference is what makes a payout traceable later.
      if (reference.length < 3) return bad('reference_required');
      const result = await payOutPartner(db, { partnerId: id, currency, method, reference, note: str(body.note, 200) || null, paidBy: actorId });
      return { status: 200, body: { ok: true, ...result } };
    }
    default:
      return bad('unknown_action');
  }
}
