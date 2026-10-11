// Stack posture and privilege parity (run through verify.sh so the env is loaded).
// 1) Docker: three labelled containers, no host networking, every published port on 127.0.0.1.
// 2) Privileges: the local database must match what the migrations intend for production. The checks
//    read has_*_privilege() for anon, authenticated and service_role, so a blanket GRANT anywhere
//    (the bug this replaces) makes them fail.
import { execFileSync, spawnSync } from 'node:child_process';

const LABEL = 'com.modaafa.local-stack=true';
let total = 0;
let failures = 0;
function check(name, ok, note = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  [${note}]` : ''}`);
}

// ---- Docker ----
const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
const info = ids.length ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' })) : [];
check('three labelled containers (postgres, auth, rest)', info.length === 3, `found ${info.length}`);
check('no container uses host networking', info.every((c) => c.HostConfig.NetworkMode !== 'host'));
const bindings = info.flatMap((c) => Object.values(c.HostConfig.PortBindings ?? {}).flat());
check('every published port is bound to 127.0.0.1', bindings.length > 0 && bindings.every((b) => b.HostIp === '127.0.0.1'), `${bindings.length} bindings`);
const nets = info.map((c) => Object.keys(c.NetworkSettings.Networks));
check('each container sits only on the labelled private bridge', nets.every((n) => n.length === 1 && n[0] === 'modaafa-ls-net'));
const netInfo = JSON.parse(execFileSync('docker', ['network', 'inspect', 'modaafa-ls-net'], { encoding: 'utf8' }))[0];
check('the network is a user-defined bridge carrying the label', netInfo.Driver === 'bridge' && netInfo.Labels?.['com.modaafa.local-stack'] === 'true');

// ---- Privileges ----
function sql(text) {
  const r = spawnSync('psql', [process.env.LOCAL_APP_DB, '-w', '-Atq', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', text], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('FAIL privilege query: ' + (r.stderr || '').split('\n')[0]);
    process.exit(1);
  }
  return r.stdout.trim();
}
const ALL = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
const tp = (role, table, privs) =>
  `(select coalesce(bool_or(has_table_privilege('${role}','public.${table}',p)), false) from unnest(array[${privs.map((p) => `'${p}'`).join(',')}]) p)`;
const fp = (role, sig) => `has_function_privilege('${role}','${sig}','execute')`;
const fpublic = (sig) => `(select proacl is null or exists(select 1 from aclexplode(proacl) a where a.grantee = 0) from pg_proc where oid = '${sig}'::regprocedure)`;
const probes = {
  ledger_anon_any: tp('anon', 'free_audit_ledger', ALL),
  ledger_auth_any: tp('authenticated', 'free_audit_ledger', ALL),
  ledger_service_select: tp('service_role', 'free_audit_ledger', ['select']),
  ledger_service_write: tp('service_role', 'free_audit_ledger', ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']),
  ledger_rls: `(select relrowsecurity from pg_class where oid = 'public.free_audit_ledger'::regclass)`,
  events_exists: `(to_regclass('public.free_audit_events') is not null)`,
  consume_anon: fp('anon', 'public.consume_free_audit(uuid)'),
  consume_auth: fp('authenticated', 'public.consume_free_audit(uuid)'),
  consume_service: fp('service_role', 'public.consume_free_audit(uuid)'),
  consume_public: fpublic('public.consume_free_audit(uuid)'),
  complete_anon: fp('anon', 'public.complete_free_audit(uuid,uuid,uuid)'),
  complete_auth: fp('authenticated', 'public.complete_free_audit(uuid,uuid,uuid)'),
  complete_service: fp('service_role', 'public.complete_free_audit(uuid,uuid,uuid)'),
  complete_public: fpublic('public.complete_free_audit(uuid,uuid,uuid)'),
  refund_anon: fp('anon', 'public.refund_free_audit(uuid)'),
  refund_auth: fp('authenticated', 'public.refund_free_audit(uuid)'),
  refund_service: fp('service_role', 'public.refund_free_audit(uuid)'),
  refund_public: fpublic('public.refund_free_audit(uuid)'),
  biz_delete: `(${tp('anon', 'businesses', ['delete'])} or ${tp('authenticated', 'businesses', ['delete'])})`,
  gads_delete: `(${tp('anon', 'google_ads_accounts', ['delete'])} or ${tp('authenticated', 'google_ads_accounts', ['delete'])})`,
  autopilot_anon: `(${tp('anon', 'autopilot_settings', ALL)} or ${tp('anon', 'autopilot_decisions', ALL)})`,
  autopilot_auth_select: `(${tp('authenticated', 'autopilot_settings', ['select'])} and ${tp('authenticated', 'autopilot_decisions', ['select'])})`,
  autopilot_auth_write: `(${tp('authenticated', 'autopilot_settings', ['insert', 'update', 'delete', 'truncate'])} or ${tp('authenticated', 'autopilot_decisions', ['insert', 'update', 'delete', 'truncate'])})`,
  usage_anon: fp('anon', 'public.consume_feature_usage(uuid,text,uuid,integer,timestamptz,timestamptz,jsonb)'),
  usage_auth: fp('authenticated', 'public.consume_feature_usage(uuid,text,uuid,integer,timestamptz,timestamptz,jsonb)'),
  tables_without_rls: `(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> '_modaafa_migrations')`,
};
const rows = sql(Object.entries(probes).map(([k, v]) => `select '${k}', (${v})::text`).join(' union all '));
const v = Object.fromEntries(rows.split('\n').map((line) => line.split('|')));
const t = (k) => v[k] === 'true';
const events = t('events_exists');
check('free_audit_ledger: anon and authenticated hold no privilege at all', !t('ledger_anon_any') && !t('ledger_auth_any'));
check('free_audit_ledger: service_role has SELECT and nothing else', t('ledger_service_select') && !t('ledger_service_write'));
check('free_audit_ledger: RLS enabled', t('ledger_rls'));
check(
  'free_audit_events: does not exist in the schema (the repo only has free_audit_ledger)',
  !events,
  events ? 'table exists, review it' : 'absent, so there is nothing to grant'
);
check('consume_free_audit: authenticated only', t('consume_auth') && !t('consume_anon') && !t('consume_service') && !t('consume_public'));
check('complete_free_audit: service_role only', t('complete_service') && !t('complete_anon') && !t('complete_auth') && !t('complete_public'));
check('refund_free_audit: service_role only', t('refund_service') && !t('refund_anon') && !t('refund_auth') && !t('refund_public'));
check('businesses and google_ads_accounts: no DELETE for anon or authenticated (20260929)', !t('biz_delete') && !t('gads_delete'));
check('autopilot tables: authenticated SELECT only, anon nothing (20260825)', t('autopilot_auth_select') && !t('autopilot_auth_write') && !t('autopilot_anon'));
check('consume_feature_usage: authenticated yes, anon no (20260929)', t('usage_auth') && !t('usage_anon'));
check('every public table has RLS enabled', v.tables_without_rls === '0', `${v.tables_without_rls} without`);

console.log('ledger ACL as stored: ' + sql(`select coalesce(relacl::text,'(default)') from pg_class where oid='public.free_audit_ledger'::regclass`));
console.log(`${total - failures} of ${total} passed`);
process.exit(failures ? 1 : 0);
