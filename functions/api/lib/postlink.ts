/**
 * Where a published post lives on its network, so the dashboard and `GET /api/v1/posts` can offer "open this post".
 * Built only from what the sender saved in `posts.external_id` when it published (plus, for Telegram, the channel's chat):
 *
 *   mastodon  the sender stores the post's own https URL
 *   discord   the sender stores the message link https://discord.com/channels/<server>/<channel>/<message>
 *   devto     the sender stores the article's https://dev.to/… address
 *   bluesky   the sender stores the at:// URI; the web address is bsky.app/profile/<did>/post/<rkey>
 *   linkedin  the sender stores the post's urn (urn:li:share:… / urn:li:ugcPost:…); the web address is linkedin.com/feed/update/<urn>/
 *   threads   the sender stores the post's permalink (https on threads.net / threads.com)
 *   telegram  the sender stores the message id; a public channel (@name) opens at t.me/<name>/<id>, a channel
 *             saved by its numeric id (-100…) at t.me/c/<id>/<id> (that form opens for members, i.e. the owner)
 *
 * Anything else (private chats, groups, networks without a stable link) gives null: no link beats a wrong one.
 * Every URL returned is https and built from validated parts, so it is safe to put in an href.
 */
export function postUrl(platform: string, externalId: string | null, telegramChatId?: string | null): string | null {
  if (!externalId) return null;
  switch (platform) {
    case 'mastodon':
      return httpsUrl(externalId);
    case 'discord': {
      const m = /^https:\/\/discord\.com\/channels\/\d{5,25}\/\d{5,25}\/\d{5,25}$/.exec(externalId);
      return m ? externalId : null;
    }
    case 'devto': {
      const url = httpsUrl(externalId);
      return url && new URL(url).hostname === 'dev.to' ? url : null;
    }
    case 'bluesky': {
      const m = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/.exec(externalId);
      return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
    }
    case 'linkedin': {
      const m = /^urn:li:(share|ugcPost):(\d{5,30})$/.exec(externalId);
      return m ? `https://www.linkedin.com/feed/update/urn:li:${m[1]}:${m[2]}/` : null;
    }
    case 'threads': {
      const url = httpsUrl(externalId);
      return url && /(^|\.)threads\.(net|com)$/.test(new URL(url).hostname) ? url : null;
    }
    case 'reddit': {
      const url = httpsUrl(externalId);
      return url && /(^|\.)reddit\.com$/.test(new URL(url).hostname) ? url : null;
    }
    case 'facebook': {
      const url = httpsUrl(externalId);
      return url && /(^|\.)facebook\.com$/.test(new URL(url).hostname) ? url : null;
    }
    case 'telegram': {
      if (!/^\d{1,12}$/.test(externalId) || !telegramChatId) return null;
      const named = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(telegramChatId);
      if (named) return `https://t.me/${named[1]}/${externalId}`;
      const numeric = /^-100(\d{5,13})$/.exec(telegramChatId);
      return numeric ? `https://t.me/c/${numeric[1]}/${externalId}` : null;
    }
    default:
      return null;
  }
}

function httpsUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
