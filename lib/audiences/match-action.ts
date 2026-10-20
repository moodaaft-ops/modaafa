import { uploadCustomerMatch, type HashedMember } from './customer-match';
/** Approval payload carries hashes only. Every key and hash is checked again at execution. */
export function validateMatchUpload(raw: any, customerId: string) {
  if (!raw || raw.consent_confirmed !== true || raw.terms_confirmed !== true) return null;
  if (!new RegExp(`^customers/${customerId.replace(/\D/g, '')}/userLists/\\d+$`).test(String(raw.user_list_resource))) return null;
  if (!Array.isArray(raw.members) || raw.members.length < 100 || raw.members.length > 100000) return null;
  const members: HashedMember[] = [];
  for (const m of raw.members) {
    if (!m || Object.keys(m).some((k) => !['email_sha256', 'phone_sha256'].includes(k))) return null;
    if (!m.email_sha256 && !m.phone_sha256) return null;
    if ([m.email_sha256, m.phone_sha256].some((v) => v !== undefined && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)))) return null;
    members.push({ ...(m.email_sha256 ? { email_sha256: m.email_sha256 } : {}), ...(m.phone_sha256 ? { phone_sha256: m.phone_sha256 } : {}) });
  }
  return { user_list_resource: String(raw.user_list_resource), members, consent_confirmed: true, terms_confirmed: true };
}
export async function runMatchUpload(params: any, customer: any, validateOnly: boolean) {
  const cid = String(params.customer_id ?? '').replace(/\D/g, '');
  const checked = validateMatchUpload(params, cid);
  if (!checked) throw new Error('Invalid Customer Match upload');
  const listRows = await customer.query(`SELECT user_list.type FROM user_list WHERE user_list.resource_name = '${checked.user_list_resource}' LIMIT 1`);
  const kind = listRows[0]?.userList?.type ?? listRows[0]?.user_list?.type;
  if (kind !== 'CRM_BASED') throw new Error('Customer Match requires a CRM list');
  const [{ createAdminClient }, { loadGrantForAccount }, { extraAccessToken }, { customerMatchTransport }] = await Promise.all([
    import('../supabase/server'), import('../google-auth/store'), import('../google-auth/incremental'), import('./customer-match'),
  ]);
  const db = createAdminClient();
  // The caller's customer is already scoped by the approval handler. Resolve the corresponding owner grant.
  const { data: accounts, error } = await db.from('google_ads_accounts').select('id').eq('customer_id', cid).eq('id', params.account_id);
  if (error || accounts?.length !== 1) throw new Error('Account owner unavailable');
  const grant = await loadGrantForAccount(db, accounts[0].id, 'data_manager');
  if (!grant) throw new Error('Data Manager grant required');
  const transport = customerMatchTransport(await extraAccessToken(grant.refreshToken));
  const uploaded = await uploadCustomerMatch(checked.members, { customerId: cid, userListId: checked.user_list_resource.split('/').pop()!, consentConfirmed: true, termsConfirmed: true, validateOnly }, transport);
  const statuses = validateOnly ? [] : (await Promise.all(uploaded.request_ids.map((id) => transport.status!(id).catch(() => ['REQUEST_STATUS_UNKNOWN'])))).flat();
  return { validate_only: validateOnly ? 'passed' : undefined, ...uploaded,
    readback: { status: statuses.length && statuses.every((s) => s === 'SUCCESS') ? 'verified' : statuses.some((s) => s === 'FAILED' || s === 'PARTIAL_SUCCESS') ? 'mismatch' : 'processing', request_statuses: statuses },
    rollback_payload: { reversible: false, action_type: 'growth_not_reversible', note: 'uploaded_audience_members_not_automatically_removed', resource_names: [checked.user_list_resource] } };
}
