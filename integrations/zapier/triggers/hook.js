const { BASE } = require('../lib');

/**
 * A REST-hook trigger: Zapier gives a URL (bundle.targetUrl), Vane calls it the moment the event happens.
 * performList is only used while building a Zap (sample data) and as a fallback: it reads the history list.
 */
module.exports = ({ key, label, description, event, status, sample }) => ({
  key,
  noun: 'Post',
  display: { label, description },
  operation: {
    type: 'hook',
    performSubscribe: async (z, bundle) => {
      const res = await z.request({ url: `${BASE}/webhooks`, method: 'POST', body: { url: bundle.targetUrl, events: [event] } });
      return { id: res.data.webhook.id };
    },
    performUnsubscribe: async (z, bundle) => {
      try {
        await z.request({ url: `${BASE}/webhooks/${bundle.subscribeData.id}`, method: 'DELETE' });
      } catch (err) {
        // Already gone (deleted by hand, or the receiver answered 410): nothing left to undo.
        if (!/\[404\]/.test(String(err && err.message))) throw err;
      }
      return {};
    },
    perform: async (z, bundle) => {
      const e = bundle.cleanedRequest;
      return e && e.data && e.data.post ? [e.data.post] : [];
    },
    performList: async (z) => {
      const res = await z.request({ url: `${BASE}/posts`, params: { view: 'history' } });
      return (res.data.posts || []).filter((p) => p.status === status);
    },
    sample: { ...sample, status },
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
});
