type UsersReader = {
  from(table: 'users'): {
    select(columns: 'registered_at'): {
      eq(column: 'id', value: string): { maybeSingle(): PromiseLike<{ data: { registered_at: string | null } | null; error: unknown }> };
    };
  };
};

/**
 * True when the user has finished registering (name, email, phone).
 *
 * Fails OPEN on a read error. If the migration is not applied yet the column
 * does not exist and the query errors; locking every existing customer out of
 * the dashboard because of that would be far worse than letting a newcomer
 * through for a few minutes.
 */
export async function isRegistrationComplete(supabase: unknown, userId: string) {
  try {
    const { data, error } = await (supabase as UsersReader)
      .from('users')
      .select('registered_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[registration] gate read failed, allowing access');
      return true;
    }
    if (!data) return true;
    return data.registered_at != null;
  } catch {
    return true;
  }
}

export const REGISTRATION_COMPLETE_PATH = '/register/complete';
