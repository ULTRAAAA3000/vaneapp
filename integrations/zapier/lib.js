const { createHash } = require('node:crypto');

const BASE = process.env.VANE_API_BASE || 'https://vaneapp.dev/api/v1';

/** Adds the key to every request. */
const addKey = (request, z, bundle) => {
  request.headers = request.headers || {};
  request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
  request.headers.Accept = 'application/json';
  return request;
};

/** Turns an API error into a Zapier error whose text is the one Vane sent: "[402] message (quota_exceeded)". */
const handleErrors = (response, z) => {
  if (response.status === 401) {
    throw new z.errors.RefreshAuthError('Vane rejected the API key. Create a new key in the Vane dashboard and reconnect.');
  }
  if (response.status >= 400) {
    const body = response.data && typeof response.data === 'object' ? response.data : {};
    const code = body.code ? ` (${body.code})` : '';
    throw new z.errors.Error(`[${response.status}] ${body.error || 'Vane returned an error'}${code}`, body.code || 'vane_error', response.status);
  }
  return response;
};

/** Zapier datetime values may come without a timezone; read those as UTC. Empty means one minute from now. */
const toIso = (value) => {
  if (!value) return new Date(Date.now() + 60_000).toISOString();
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
};

const idempotencyKey = (obj) => `zap-${createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40)}`;

module.exports = { BASE, addKey, handleErrors, toIso, idempotencyKey };
