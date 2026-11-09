import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { disabledModules, isModuleId, MODULES, setModule } from '../lib/modules';
import { invalidateSettings } from '../lib/settings';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  invalidateSettings();
  const off = new Set(await disabledModules(env));
  return json({ ok: true, modules: MODULES.map((m) => ({ id: m.id, name: m.name, group: m.group, about: m.about, enforced: m.api.length > 0, enabled: !off.has(m.id) })) });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || !isModuleId(b.id)) return fail(404, 'Unknown module.');
  if (typeof b.enabled !== 'boolean') return fail(400, 'enabled must be true or false.');
  const err = await setModule(env, b.id, b.enabled);
  if (err) return fail(500, err);
  await audit(env, request, b.enabled ? 'module.enable' : 'module.disable', b.id, {});
  return json({ ok: true, id: b.id, enabled: b.enabled });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, PUT');
