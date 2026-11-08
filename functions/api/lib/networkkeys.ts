/**
 * The variables a network needs on the server before users can connect it (LinkedIn, Threads). Names only: a value never leaves
 * the server, not even to the admin.
 *
 *   networkKeys(env, id)   { vars: [{ name, set }], complete, where, similar } for a network that needs keys, otherwise null
 *   keysMessage(keys)      the admin's hint when something is missing (null when complete)
 *
 * `complete` is the same test as linkedinConfigured / threadsConfigured (every variable has a value), so what the admin sees is
 * exactly what turns the connect button on for users (/api/auth/me → features). `similar` lists variables whose name mentions the
 * network but is not one the code reads (THREADS_CLIENT_ID instead of THREADS_APP_ID): the usual reason keys that "are there" are
 * not seen. The other usual one is a variable added without a redeploy, or added to Pages while the site runs somewhere else.
 */
export interface NetworkKeys {
  vars: { name: string; set: boolean }[];
  complete: boolean;
  /** where the variables must be set */
  where: string;
  similar: string[];
}

const SPECS: Record<string, { vars: readonly string[]; where: string; match: RegExp }> = {
  linkedin: { vars: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'], where: 'Pages and the cron worker', match: /linkedin/i },
  threads: { vars: ['THREADS_APP_ID', 'THREADS_APP_SECRET'], where: 'Pages', match: /threads/i },
};

export function networkKeys(env: object, id: string): NetworkKeys | null {
  const spec = SPECS[id];
  if (!spec) return null;
  const vars = spec.vars.map((name) => ({ name, set: Boolean((env as Record<string, unknown>)[name]) }));
  const similar = Object.keys(env).filter((k) => spec.match.test(k) && !spec.vars.includes(k)).sort();
  return { vars, complete: vars.every((v) => v.set), where: spec.where, similar };
}

export function keysMessage(keys: NetworkKeys): string | null {
  if (keys.complete) return null;
  const missing = keys.vars.filter((v) => !v.set).map((v) => v.name);
  const similar = keys.similar.length
    ? ` Variables with a similar name exist (${keys.similar.join(', ')}), but the code reads exactly ${keys.vars.map((v) => v.name).join(' and ')}.`
    : '';
  return `Code is ready. Add ${missing.join(' and ')} (${keys.where}) to open it for users.${similar} A new variable reaches the site after a redeploy.`;
}
