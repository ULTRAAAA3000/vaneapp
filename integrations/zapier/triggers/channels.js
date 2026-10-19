const { BASE } = require('../lib');

// Hidden: only feeds the "Channels" dropdown of the action.
module.exports = {
  key: 'channels',
  noun: 'Channel',
  display: { label: 'New Channel', description: 'Lists your connected Vane channels.', hidden: true },
  operation: {
    perform: async (z) => {
      const res = await z.request({ url: `${BASE}/channels` });
      return (res.data.channels || []).filter((c) => c.isActive).map((c) => ({ id: c.id, name: `${c.name} (${c.platform})` }));
    },
    sample: { id: '11111111-1111-4111-8111-111111111111', name: 'My channel (telegram)' },
  },
};
