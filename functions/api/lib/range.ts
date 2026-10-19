/** Small helpers shared by the admin reports. */

export function daysParam(url: URL, def = 30): number {
  const n = Number(url.searchParams.get('days'));
  return [1, 7, 14, 30, 90, 180].includes(n) ? n : def;
}

/** ['2026-10-10', …, today] — so charts get a point for days with no data. */
export function dayLabels(days: number): string[] {
  const out: string[] = [];
  const today = Math.floor(Date.now() / 86400_000);
  for (let i = days - 1; i >= 0; i--) out.push(new Date((today - i) * 86400_000).toISOString().slice(0, 10));
  return out;
}

export function fillSeries<T extends { d: string }>(labels: string[], rows: T[], pick: (r: T) => number): number[] {
  const m = new Map(rows.map((r) => [r.d, pick(r)]));
  return labels.map((l) => m.get(l) ?? 0);
}

/** Escapes % and _ for a LIKE ... ESCAPE '\' query. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
