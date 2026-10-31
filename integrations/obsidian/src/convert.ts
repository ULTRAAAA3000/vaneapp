/**
 * Turns the Markdown of a note into the plain text of a post. Pure functions, no Obsidian API: tested in scripts/obsidian-unit.mjs.
 *
 * Social networks do not render Markdown, so `**bold**`, `[[wikilinks]]` and `# headings` would arrive as noise. What is kept on
 * purpose: #hashtags, @mentions, line breaks, links (written out in full) and numbered lists.
 */
export interface ConvertOptions {
  /** Cut the properties block (`---` … `---`) at the top of the note. */
  stripFrontmatter: boolean;
  /** Turn Markdown into plain text. When off, only the properties and comments are removed. */
  plainText: boolean;
}

export const DEFAULT_CONVERT: ConvertOptions = { stripFrontmatter: true, plainText: true };

const FRONTMATTER = /^\uFEFF?---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

export function noteToPost(markdown: string, options: ConvertOptions = DEFAULT_CONVERT): string {
  let t = markdown.replace(/\r\n?/g, '\n');
  if (options.stripFrontmatter) t = t.replace(FRONTMATTER, '');

  // Obsidian comments and HTML comments are for the author, never for readers.
  t = t.replace(/%%[\s\S]*?%%/g, '').replace(/<!--[\s\S]*?-->/g, '');

  if (options.plainText) {
    // Code blocks: keep the code, drop the fences. Done first so nothing inside is rewritten as Markdown.
    const code: string[] = [];
    t = t.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/gm, (_m, _f, body: string) => { code.push(body); return `\u0000${code.length - 1}\u0000`; });
    t = t.replace(/`([^`\n]+)`/g, (_m, body: string) => { code.push(body); return `\u0000${code.length - 1}\u0000`; });

    t = t
      .replace(/!\[\[[^\]]*\]\]/g, '')                                   // embedded notes and images
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                              // images
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, (_m, _page: string, alias: string) => alias)            // [[Page|alias]]
      .replace(/\[\[([^\]#|^]*)(?:[#^][^\]|]*)?\]\]/g, (_m, page: string) => page.trim())              // [[Page#Heading]]
      .replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) =>
        /^https?:\/\//i.test(url) ? (text.trim() === url ? url : `${text} (${url})`) : text)          // [text](url)
      .replace(/^[ \t]*\[\^[^\]]+\]:.*$/gm, '')                          // footnote texts (before the marks, which they contain)
      .replace(/\[\^[^\]]+\]/g, '')                                      // footnote marks
      .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')              // horizontal rules
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, '$1') // headings
      .replace(/^[ \t]*>[ \t]*\[![^\]]*\][+-]?[ \t]*/gm, '> ')           // callout marker: "> [!note] Title" → "Title"
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')                              // quotes
      .replace(/^([ \t]*)[-*+][ \t]+\[[xX]\][ \t]+/gm, '$1✓ ')           // done tasks
      .replace(/^([ \t]*)[-*+][ \t]+\[ \][ \t]+/gm, '$1• ')              // open tasks
      .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')                         // bullets
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')                   // bold
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')                          // strikethrough
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '$1')                          // highlight
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*[^\s*])\*(?![\w*])/gm, '$1$2') // italics with * (no look-behind: older iOS cannot parse it)
      .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*[^\s_])_(?![\w_])/gm, '$1$2')   // italics with _
      .replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '');                    // block ids

    t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');
  }

  return t
    .split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
