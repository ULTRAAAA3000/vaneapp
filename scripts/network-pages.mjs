/**
 * One page per network (/networks/<id>): what Vane publishes there, the real limits, how to connect, and a short FAQ.
 * Everything here is taken from what the code does (functions/api/posts/create.ts limits, functions/api/channels/*): when a limit
 * or a flow changes in the code, change it here too. `status`: live = works today, next = built, switched on when the network
 * approves Vane. Used by scripts/build-site-pages.mjs.
 */
export const NETWORK_PAGES = [
  {
    id: 'telegram', name: 'Telegram', product: 'Vane Post', status: 'live',
    h1: 'Schedule Telegram posts to channels and groups',
    lead: 'Write the post once, pick the time, and Vane sends it to your Telegram channel or group when it is due: text, images and video.',
    publishes: ['Text, with line breaks and links', 'One image or video per post', 'Channels and groups where the bot is an admin'],
    limits: [['Text', '4,096 characters'], ['Caption under an image or video', '1,024 characters'], ['Video', 'Supported'], ['Formatting', 'Plain text, as you wrote it']],
    connect: ['Open Channels in Vane Post and choose Telegram.', 'Quick Connect: add the Vane bot to your channel as an admin with permission to post, then paste the channel name. Or use your own bot: paste its token and the chat.', 'Vane checks it can post and saves the channel. The bot token is stored encrypted.'],
    faq: [
      ['Do I need my own Telegram bot?', 'No. Quick Connect uses the shared Vane bot: you only add it to your channel as an admin. If you prefer, you can connect your own bot with its token.'],
      ['What happens if my caption is too long?', 'Under an image or video Telegram allows 1,024 characters. Vane shows the limit next to the channel and refuses to schedule a post Telegram would reject.'],
      ['Can I schedule to several Telegram channels at once?', 'Yes. Each channel is a separate destination and there is no per-channel fee on any plan.'],
    ],
  },
  {
    id: 'bluesky', name: 'Bluesky', product: 'Vane Post', status: 'live',
    h1: 'Schedule Bluesky posts with an app password',
    lead: 'Vane posts to Bluesky for you at the time you choose, with clickable links and hashtags, and counts characters the way Bluesky does.',
    publishes: ['Text with links and hashtags as real links and tags', 'One image (up to 1 MB)'],
    limits: [['Text', '300 characters, counted as visible characters (an emoji is one)'], ['Image', 'One, up to 1 MB, JPEG or PNG'], ['Video', 'Not supported yet']],
    connect: ['Open Channels in Vane Post and choose Bluesky.', 'In Bluesky go to Settings → Privacy and security → App passwords and create one for Vane.', 'Paste your handle and the app password. It can post, but it never opens your main account, and you can delete it in Bluesky at any time.'],
    faq: [
      ['Is my Bluesky password safe?', 'Vane asks for an app password, not your main password. It is stored encrypted and can be revoked in Bluesky settings whenever you like.'],
      ['How does Vane count Bluesky characters?', 'Bluesky counts what a person sees, so an emoji counts as one. Vane counts the same way and shows the number next to the channel.'],
      ['Can I post a video to Bluesky?', 'Not yet. Attach an image or post text only.'],
    ],
  },
  {
    id: 'mastodon', name: 'Mastodon', product: 'Vane Post', status: 'live',
    h1: 'Schedule Mastodon posts on any server',
    lead: 'Connect your account on any Mastodon server and schedule posts with pictures. Vane counts links the way Mastodon does.',
    publishes: ['Text and links', 'Pictures'],
    limits: [['Text', '500 characters; every link counts as 23'], ['Pictures', 'Supported'], ['Video', 'Not supported yet']],
    connect: ['Open Channels in Vane Post and choose Mastodon.', 'Type the address of your server, for example mastodon.social.', 'Your server asks you to authorize Vane. Vane may only post and upload pictures for you; you can remove it in Preferences → Account → Authorized apps.'],
    faq: [
      ['Does it work on every Mastodon server?', 'Yes. You enter your own server and authorize Vane there.'],
      ['How are links counted?', 'Mastodon counts every link as 23 characters, however long it is. Vane does the same, so what you see is what Mastodon will accept.'],
      ['What can Vane do on my account?', 'Only post and upload pictures. It cannot read your timeline or follow and block people.'],
    ],
  },
  {
    id: 'discord', name: 'Discord', product: 'Vane Post', status: 'live',
    h1: 'Schedule Discord messages through a webhook',
    lead: 'Post to a channel on your Discord server at a set time. You paste a webhook link, so Vane never needs access to your server.',
    publishes: ['Text messages', 'One image'],
    limits: [['Text', '2,000 characters'], ['Mentions', 'Turned off, so @everyone and @here never ping people'], ['Video', 'Not supported yet']],
    connect: ['In Discord open the channel settings → Integrations → Webhooks and create a webhook.', 'Copy the webhook URL.', 'In Vane Post choose Discord and paste the link. Vane checks it and saves it encrypted.'],
    faq: [
      ['Why a webhook and not a login?', 'A webhook can only post to one channel. Vane gets no access to your account or the rest of the server.'],
      ['Can a scheduled post ping everyone?', 'No. Mentions are disabled on posts sent through Vane.'],
      ['How do I stop Vane posting?', 'Delete the webhook in Discord, or disconnect the channel in Vane.'],
    ],
  },
  {
    id: 'devto', name: 'Dev.to', product: 'Vane Post', status: 'live',
    h1: 'Publish to Dev.to as an article',
    lead: 'Each Vane post becomes a Dev.to article: the first line is the title, the rest is the body, and your hashtags become tags.',
    publishes: ['An article: the first line is the title, the rest is Markdown', 'A cover image', 'Up to 4 tags from your #hashtags'],
    limits: [['Text', '10,000 characters'], ['Tags', 'Up to 4, taken from #hashtags'], ['Video', 'Not supported yet']],
    connect: ['In Dev.to open Settings → Extensions and generate an API key.', 'In Vane Post choose Dev.to and paste the key.', 'Vane verifies it and shows your username. The key is stored encrypted.'],
    faq: [
      ['Does Vane publish drafts or live articles?', 'Articles are published at the scheduled time.'],
      ['How are tags chosen?', 'Your #hashtags become Dev.to tags, up to four, which is Dev.to’s limit.'],
      ['Is the API key safe?', 'It is stored encrypted and you can revoke it in Dev.to settings at any time.'],
    ],
  },
  {
    id: 'linkedin', name: 'LinkedIn', product: 'Vane Post', status: 'next',
    h1: 'Schedule LinkedIn posts to your profile',
    lead: 'Plan LinkedIn posts ahead and let Vane publish them for you, with clickable hashtags and an image.',
    publishes: ['Text with clickable hashtags', 'One image'],
    limits: [['Text', '3,000 characters'], ['Image', 'One'], ['Video', 'Not supported yet'], ['Where', 'Your personal profile (company pages later)']],
    connect: ['Open Channels in Vane Post and choose LinkedIn.', 'Press Continue with LinkedIn and Allow Vane to post for you.', 'You come back to Vane with the profile connected. A LinkedIn sign-in lasts 60 days; Vane shows Reconnect before it runs out.'],
    faq: [
      ['What can Vane do on my LinkedIn?', 'Only create posts on your profile and read your name to show it in Vane. It cannot read your feed, messages or connections.'],
      ['Can I post to a company page?', 'Not yet. Profiles first; company pages follow later.'],
      ['Why does LinkedIn ask me to reconnect?', 'LinkedIn sign-ins expire after 60 days. Vane warns you before it happens and reconnecting keeps your scheduled posts.'],
    ],
  },
  {
    id: 'threads', name: 'Threads', product: 'Vane Post', status: 'next',
    h1: 'Schedule Threads posts',
    lead: 'Write once and let Vane publish to Threads at the time you pick: text, an image or a video.',
    publishes: ['Text', 'One image or one video'],
    limits: [['Text', '500 characters (emoji count by size)'], ['Image or video', 'One per post']],
    connect: ['Open Channels in Vane Post and choose Threads.', 'Press Continue with Threads and Allow Vane to publish.', 'The sign-in renews itself, and you can remove access in Threads settings (Account → Website permissions).'],
    faq: [
      ['How are Threads characters counted?', 'Threads counts an emoji by the space it takes, so Vane counts the same way and warns you before you hit the limit.'],
      ['Does the connection expire?', 'Vane renews the Threads sign-in automatically before it runs out.'],
      ['What can Vane access?', 'Only your username and the permission to publish. It cannot read your messages or follow anyone.'],
    ],
  },
  {
    id: 'reddit', name: 'Reddit', product: 'Vane Post', status: 'next',
    h1: 'Schedule Reddit posts to a subreddit',
    lead: 'Prepare a Reddit post in advance and let Vane submit it to your subreddit at the right time. The first line becomes the title.',
    publishes: ['A text post: the first line is the title, the rest is the text', 'Links to your pictures inside the text'],
    limits: [['Title', 'Up to 300 characters (the first line)'], ['Text', 'Up to 10,000 characters'], ['Where', 'One subreddit per channel; add a channel for each one']],
    connect: ['Open Channels in Vane Post and choose Reddit.', 'Type the subreddit, for example r/webdev, then Continue with Reddit and Allow Vane.', 'Vane may only submit posts and read your username. It cannot read messages, vote or comment.'],
    faq: [
      ['Can I post to several subreddits?', 'Yes. Connect one channel per subreddit; the same Reddit account can have several.'],
      ['Why was my post refused?', 'Many subreddits ban self-promotion or require a flair. Reddit’s reason is shown in the post history, so you can fix it and retry.'],
      ['Does Vane break Reddit’s rate limits?', 'No. When Reddit asks to slow down, Vane waits and tries again later.'],
    ],
  },
  {
    id: 'facebook', name: 'Facebook Pages', product: 'Vane Post', status: 'next',
    h1: 'Schedule Facebook Page posts',
    lead: 'Plan posts for the Facebook Pages you manage. Every Page you allow becomes its own channel in Vane.',
    publishes: ['Text posts', 'Photo posts with your text as the caption', 'Video posts'],
    limits: [['Where', 'Pages you manage (personal profiles cannot be posted to by apps)'], ['Text', 'Up to 5,000 characters in the editor']],
    connect: ['Open Channels in Vane Post and choose Facebook Pages.', 'Press Continue with Facebook and choose the Pages Vane may post to.', 'Each Page you allow is added as a channel. You can remove access in Facebook: Settings → Business integrations.'],
    faq: [
      ['Can Vane post to my personal profile?', 'No. Facebook only lets apps publish to Pages, not personal profiles.'],
      ['I manage several Pages. Do I connect them one by one?', 'No. Choose them all in one step and each becomes its own channel.'],
      ['What can Vane read?', 'The names of your Pages and the permission to publish. It cannot read messages, comments or your profile.'],
    ],
  },
  {
    id: 'youtube', name: 'YouTube', product: 'Vane Studio', status: 'next',
    h1: 'Publish videos to YouTube from Vane Studio',
    lead: 'Upload a video once to your Studio library and publish it to your YouTube channel with a title, description, tags, category and your own cover.',
    publishes: ['The video, uploaded in chunks so large files work', 'Title, description, tags and category', 'Your cover as the thumbnail'],
    limits: [['Visibility', 'Private, unlisted or public (YouTube may keep videos private until Google approves Vane)'], ['Made for kids', 'You answer it for every video, as YouTube requires'], ['Permission', 'Upload only: Vane cannot read your videos or analytics']],
    connect: ['Open Channels in Vane Studio and choose YouTube.', 'Sign in with Google and allow Vane to upload videos.', 'Your channel appears in the list; publish any library video with Publish.'],
    faq: [
      ['Why is my video private?', 'Until Google approves Vane’s API access, YouTube forces uploads from unverified apps to private. Vane tells you what YouTube did with each video.'],
      ['What can Vane see on my channel?', 'Nothing. It only has the permission to upload a video you chose.'],
      ['What if the upload fails halfway?', 'Vane retries by itself. If YouTube’s daily quota is used up, you see a clear message instead of endless retries.'],
    ],
  },
  {
    id: 'instagram', name: 'Instagram Reels', product: 'Vane Studio', status: 'next',
    h1: 'Publish Instagram Reels from Vane Studio',
    lead: 'Publish a video from your Studio library as an Instagram Reel on a Business or Creator account, with a caption and your own cover.',
    publishes: ['A Reel with your caption', 'Your cover image (JPEG)', 'An option to also show it in your profile feed'],
    limits: [['Accounts', 'Business and Creator'], ['Visibility', 'Always public; Instagram has no private Reels'], ['File', 'MP4 or MOV up to 300 MB, 3 seconds to 15 minutes'], ['Daily limit', 'About 25 API publications per account']],
    connect: ['Open Channels in Vane Studio and choose Instagram Reels.', 'Sign in with Instagram and allow Vane to publish.', 'Publish any library video with Publish; Instagram fetches it from a temporary link that Vane removes afterwards.'],
    faq: [
      ['Does it work with a personal Instagram account?', 'No. Instagram only lets apps publish for Business and Creator accounts.'],
      ['Can I schedule a private Reel?', 'No. Instagram Reels are always public, so Vane requires Public for them.'],
      ['Is my video exposed on the internet?', 'Only for the moment Instagram downloads it, through a link nobody can guess. Vane deletes the link right after.'],
    ],
  },
];
