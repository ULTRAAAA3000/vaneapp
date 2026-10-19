const hook = require('./hook');

module.exports = hook({
  key: 'post_failed',
  label: 'Post Failed',
  description: 'Triggers right when a post could not be published after all retries.',
  event: 'post.failed',
  status: 'failed',
  sample: {
    id: '55555555-5555-4555-8555-555555555555',
    groupId: '44444444-4444-4444-8444-444444444444',
    channelId: '11111111-1111-4111-8111-111111111111',
    channelName: 'My channel',
    platform: 'telegram',
    content: 'Hello from Vane',
    mediaUrl: null,
    mediaKind: null,
    scheduledAt: 1790000000,
    attempts: 5,
    error: 'The bot was removed from this chat or blocked.',
    sentAt: null,
    url: null,
  },
});
