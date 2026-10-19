/**
 * Four flags, all off unless the value is exactly "true":
 *  - DEMAND_GEN_ENABLED     Demand Gen / YouTube campaign builder (launch_demand_gen).
 *  - AUDIENCES_ENABLED      Website-visitor lists, Customer Match lists, attaching an audience.
 *  - EXPERIMENTS_ENABLED    Google campaign experiments (create, end, promote).
 *  - IMAGE_ASSETS_ENABLED   Image candidates from the landing page and ImageAsset creation.
 * With a flag off its operations are never executable and nothing reads or writes.
 */
type Env = Record<string, string | undefined>;

export const demandGenEnabled = (env: Env = process.env) => env.DEMAND_GEN_ENABLED === 'true';
export const audiencesEnabled = (env: Env = process.env) => env.AUDIENCES_ENABLED === 'true';
export const experimentsEnabled = (env: Env = process.env) => env.EXPERIMENTS_ENABLED === 'true';
export const imageAssetsEnabled = (env: Env = process.env) => env.IMAGE_ASSETS_ENABLED === 'true';

export const GROWTH_OPERATIONS = [
  'launch_demand_gen',
  'create_user_list',
  'attach_audience',
  'create_experiment',
  'end_experiment',
  'promote_experiment',
  'create_image_assets',
] as const;

export type GrowthOperation = (typeof GROWTH_OPERATIONS)[number];

const SET: ReadonlySet<string> = new Set(GROWTH_OPERATIONS);

export function isGrowthOperation(value: unknown): value is GrowthOperation {
  return typeof value === 'string' && SET.has(value);
}

/** Which flag gates an operation. attach_audience also needs the flag of the campaign type it attaches to. */
export function growthOperationEnabled(operation: string, env: Env = process.env): boolean {
  switch (operation) {
    case 'launch_demand_gen':
      return demandGenEnabled(env);
    case 'create_user_list':
      return audiencesEnabled(env);
    case 'attach_audience':
      return audiencesEnabled(env) && demandGenEnabled(env);
    case 'create_experiment':
    case 'end_experiment':
    case 'promote_experiment':
      return experimentsEnabled(env);
    case 'create_image_assets':
      return imageAssetsEnabled(env);
    default:
      return false;
  }
}

/** Rollback payloads of this family carry this action_type prefix. */
export const GROWTH_ROLLBACK_PREFIX = 'growth_';

export function isGrowthRollback(rollback: unknown): boolean {
  const type = (rollback as { action_type?: unknown } | null | undefined)?.action_type;
  return typeof type === 'string' && type.startsWith(GROWTH_ROLLBACK_PREFIX);
}

export const GROWTH_LABELS_AR: Readonly<Record<GrowthOperation, string>> = {
  launch_demand_gen: 'بناء حملة ديماند جن موقوفة',
  create_user_list: 'إنشاء قائمة جمهور',
  attach_audience: 'ربط جمهور بمجموعة إعلانية',
  create_experiment: 'بدء تجربة على حملة',
  end_experiment: 'إيقاف تجربة',
  promote_experiment: 'اعتماد نتيجة التجربة على الحملة',
  create_image_assets: 'رفع صور الإعلان من صفحتك',
};
