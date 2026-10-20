/** Insert first. A unique conflict can only refresh the SAME owner's connection. */
export async function saveStoreConnection(db: any, row: Record<string, unknown>): Promise<'saved' | 'store_taken'> {
  const { error } = await db.from('store_connections').insert(row);
  if (!error) return 'saved';
  if (error.code !== '23505') throw error;
  const { data, error: updateError } = await db.from('store_connections').update(row)
    .eq('platform', row.platform).eq('external_store_id', row.external_store_id).eq('user_id', row.user_id)
    .select('id').maybeSingle();
  if (updateError) throw updateError;
  return data ? 'saved' : 'store_taken';
}
