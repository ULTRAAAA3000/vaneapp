const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAIL_RE = /[.,;:!?)\]}]+$/;

export function tagUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.searchParams.has('utm_source')) return raw;
  const hash = url.hash;
  url.hash = '';
  const base = url.toString();
  const glue = url.search ? '&' : '?';
  const medium = url.searchParams.has('utm_medium') ? '' : '&utm_medium=social';
  return `${base}${glue}utm_source=${encodeURIComponent(source)}${medium}${hash}`;
}

export function tagLinks(text: string, source: string): string {
  return text.replace(URL_RE, (match) => {
    const tail = TRAIL_RE.exec(match)?.[0] ?? '';
    const url = tail ? match.slice(0, -tail.length) : match;
    return url ? tagUrl(url, source) + tail : match;
  });
}
