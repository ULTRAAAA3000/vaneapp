/** Creating the users row: shared by the plain sign-up and the one confirmed with an emailed code. */
import type { Env } from '../../../types';

export type CreateUserResult = { ok: true } | { ok: false; taken: boolean };

export async function createUser(
  env: Env,
  u: { id: string; email: string; passwordHash: string; name: string | null; timezone: string },
): Promise<CreateUserResult> {
  try {
    await env.DB
      .prepare('INSERT INTO users (id, email, password_hash, name, timezone) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(u.id, u.email, u.passwordHash, u.name, u.timezone)
      .run();
    return { ok: true };
  } catch (err) {
    // Lost a race with a parallel sign-up for the same email.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return { ok: false, taken: true };
    console.error('user insert failed', err instanceof Error ? err.message : 'unknown');
    return { ok: false, taken: false };
  }
}
