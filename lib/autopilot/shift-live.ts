/** A fresh, fail-closed read on each side of a paired move. */
export async function assertShiftBudgetsUnchanged(customer: { query(sql: string): Promise<any[]> }, params: Record<string, any>) {
  for (const side of ['from', 'to']) {
    const resource = params[`${side}_budget_resource`];
    if (typeof resource !== 'string' || !/^customers\/\d+\/campaignBudgets\/\d+$/.test(resource)) throw new Error('Invalid shift budget');
    const rows = await customer.query(`SELECT campaign_budget.resource_name, campaign_budget.amount_micros,
      campaign_budget.reference_count, campaign_budget.explicitly_shared
      FROM campaign_budget WHERE campaign_budget.resource_name = '${resource}' LIMIT 1`);
    const b = rows[0]?.campaignBudget ?? rows[0]?.campaign_budget;
    const amount = Number(b?.amountMicros ?? b?.amount_micros);
    const references = Number(b?.referenceCount ?? b?.reference_count);
    const shared = b?.explicitlyShared ?? b?.explicitly_shared;
    if (references !== 1 || shared !== false || !Number.isSafeInteger(amount) || amount !== params[`${side}_current_micros`]) {
      throw new Error('Shift budget changed or became shared; propose a fresh card');
    }
  }
}
