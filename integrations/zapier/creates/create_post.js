const { BASE, toIso, idempotencyKey } = require('../lib');

module.exports = {
  key: 'create_post',
  noun: 'Post',
  display: { label: 'Create Social Post', description: 'Schedules a post to one or more of your Vane channels.' },
  operation: {
    inputFields: [
      { key: 'content', label: 'Text', type: 'text', required: true },
      { key: 'channelIds', label: 'Channels', required: true, list: true, dynamic: 'channels.id.name' },
      { key: 'scheduledAt', label: 'Publish at', type: 'datetime', helpText: 'Leave empty to publish in about a minute.' },
      { key: 'mediaUrl', label: 'Image URL', type: 'string', helpText: 'Optional. A public https link to one image.' },
    ],
    perform: async (z, bundle) => {
      const d = bundle.inputData;
      const body = { content: d.content, channelIds: [].concat(d.channelIds || []), scheduledAt: toIso(d.scheduledAt) };
      if (d.mediaUrl) body.mediaUrl = d.mediaUrl;
      // A Zap that is retried must not post twice. Only when the time is fixed: otherwise "now" would make every retry look new.
      const headers = d.scheduledAt ? { 'Idempotency-Key': idempotencyKey(body) } : {};
      const res = await z.request({ url: `${BASE}/posts`, method: 'POST', body, headers });
      const r = res.data;
      return { id: r.groupId, groupId: r.groupId, scheduledAt: new Date(r.scheduledAt * 1000).toISOString(), channels: r.posts.length, test: !!r.test, posts: r.posts };
    },
    sample: { id: '44444444-4444-4444-8444-444444444444', groupId: '44444444-4444-4444-8444-444444444444', scheduledAt: '2026-10-20T09:00:00.000Z', channels: 1, test: false },
    outputFields: [
      { key: 'groupId', label: 'Group ID' },
      { key: 'scheduledAt', label: 'Scheduled at' },
      { key: 'channels', label: 'Number of channels', type: 'integer' },
      { key: 'test', label: 'Test key (nothing posted)', type: 'boolean' },
    ],
  },
};
