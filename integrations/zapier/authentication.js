const { BASE } = require('./lib');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText: 'Create it in the Vane dashboard under API keys. Start with a key that begins with `cpost_test_`: nothing is posted or counted. Use `cpost_live_` for real posts.',
    },
  ],
  test: { url: `${BASE}/me` },
  connectionLabel: '{{json.key.name}} ({{json.plan}}, {{json.key.mode}})',
};
