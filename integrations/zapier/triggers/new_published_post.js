const hook = require('./hook');

module.exports = hook({
  key: 'new_published_post',
  label: 'New Published Post',
  description: 'Triggers right when Vane has published a post on a network.',
  event: 'post.published',
  status: 'sent',
  sample: {
    id: '33333333-3333-4333-8333-333333333333',
    groupId: '44444444-4444-4444-8444-444444444444',
    channelId: '11111111-1111-4111-8111-111111111111',
    channelName: 'My channel',
    platform: 'telegram',
    content: 'Hello from Vane',
    mediaUrl: null,
    mediaKind: null,
    scheduledAt: 1790000000,
    attempts: 1,
    error: null,
    sentAt: 1790000010,
    url: 'https://t.me/mychannel/77',
  },
});
