export function auditFindingTargetKey(details: Record<string, unknown>) {
  const directTarget =
    details.campaign_id ??
    details.budget_resource ??
    details.resource_name ??
    details.customer_id;
  if (directTarget !== undefined && directTarget !== null && directTarget !== '') {
    return String(directTarget);
  }

  const searchTerm = String(details.search_term ?? '').trim();
  if (searchTerm) {
    return [
      details.campaign_resource_name ?? details.campaign_id ?? '',
      details.ad_group_resource_name ?? '',
      searchTerm.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('ar'),
    ].join(':');
  }

  return stableStringify(details);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
