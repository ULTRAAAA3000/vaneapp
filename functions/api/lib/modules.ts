import type { Env } from '../../../types';
import { getSettings, invalidateSettings, saveSettings } from './settings';

export interface ModuleDef { id: string; name: string; group: string; about: string; api: string[] }

export const MODULES: ModuleDef[] = [
  { id: 'studio', name: 'Vane Studio', group: 'Products', about: 'Video uploads and publishing. Its API answers 503 while it is off.', api: ['/api/video', '/api/v1/video'] },
  { id: 'analytics', name: 'Vane Analytics', group: 'Products', about: 'Results of posts and followers, the Telegram bot. Its API answers 503 while it is off.', api: ['/api/analytics'] },
  { id: 'ai', name: 'AI tools', group: 'Dashboard', about: 'The AI writing tools and their history.', api: ['/api/ai'] },
  { id: 'library', name: 'Library', group: 'Dashboard', about: 'Uploaded files and the picker in the editor.', api: ['/api/library'] },
  { id: 'snippets', name: 'Snippets', group: 'Dashboard', about: 'Saved pieces of text.', api: ['/api/snippets'] },
  { id: 'drafts', name: 'Drafts', group: 'Dashboard', about: 'Unfinished posts.', api: ['/api/drafts'] },
  { id: 'agents', name: 'Agents log', group: 'Dashboard', about: 'The live log of what connected tools did.', api: ['/api/agent-log'] },
  { id: 'claude', name: 'Claude connector tab', group: 'Integration tabs', about: 'Only hides the setup page. To stop requests, use Integrations.', api: [] },
  { id: 'notion', name: 'Notion tab', group: 'Integration tabs', about: 'Only hides the setup page. To stop requests, use Integrations.', api: [] },
  { id: 'wordpress', name: 'WordPress tab', group: 'Integration tabs', about: 'Only hides the setup page. To stop requests, use Integrations.', api: [] },
  { id: 'automation', name: 'Make & Zapier tab', group: 'Integration tabs', about: 'Only hides the setup page. To stop requests, use Integrations.', api: [] },
  { id: 'obsidian', name: 'Obsidian tab', group: 'Integration tabs', about: 'Only hides the setup page. To stop requests, use Integrations.', api: [] },
];

export const isModuleId = (v: unknown): v is string => typeof v === 'string' && MODULES.some((m) => m.id === v);

export async function disabledModules(env: Env): Promise<string[]> {
  const raw = (await getSettings(env)).modules_off;
  return raw.split(',').map((x) => x.trim()).filter(isModuleId);
}

export function moduleOfPath(path: string): string | null {
  const p = path.replace(/\/+$/, '');
  return MODULES.find((m) => m.api.some((a) => p === a || p.startsWith(`${a}/`)))?.id ?? null;
}

export async function setModule(env: Env, id: string, enabled: boolean): Promise<string | null> {
  invalidateSettings();
  const off = new Set(await disabledModules(env));
  if (enabled) off.delete(id); else off.add(id);
  const err = await saveSettings(env, { modules_off: MODULES.filter((m) => off.has(m.id)).map((m) => m.id).join(',') });
  invalidateSettings();
  return err;
}
