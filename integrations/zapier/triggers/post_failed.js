const { BASE } = require('../lib');

// Polling: the history list (newest first). Zapier skips ids it has already seen.
module.exports = {
  key: 'post_failed',
  noun: 'Post',
  display: { label: 'Post Failed', description: 'Triggers when a post could not be published after all retries.' },
  operation: {
    perform: async (z) => {
      const res = await z.request({ url: `${BASE}/posts`, params: { view: 'history' } });
      return (res.data.posts || []).filter((p) => p.status === 'failed');
    },
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
      status: 'failed',
      attempts: 1,
      error: null,
      sentAt: 1790000010,
      url: null,
    },
    outputFields: [
      { key: 'id', label: 'Post ID' },
      { key: 'groupId', label: 'Group ID' },
      { key: 'channelName', label: 'Channel' },
      { key: 'platform', label: 'Network' },
      { key: 'content', label: 'Text' },
      { key: 'status', label: 'Status' },
      { key: 'error', label: 'Error' },
      { key: 'url', label: 'Link to the post' },
      { key: 'sentAt', label: 'Sent at (unix seconds)', type: 'integer' },
    ],
  },
};
