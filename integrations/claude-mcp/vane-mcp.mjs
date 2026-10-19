#!/usr/bin/env node
/**
 * @vane/mcp-server: the Claude Desktop side of the Vane connector.
 *
 * Claude Desktop starts local MCP servers over stdin/stdout. This file is that local server, and it holds no logic:
 * every JSON-RPC message is forwarded to Vane's own MCP endpoint (POST /api/v1/mcp) with the API key attached.
 * No dependencies, Node 18+.
 *
 *   VANE_API_KEY   required, cpost_live_… (or cpost_test_… to try it without posting anything)
 *   VANE_API_URL   optional, defaults to https://vaneapp.dev/api/v1/mcp
 */
import { createInterface } from 'node:readline';

const KEY = process.env.VANE_API_KEY ?? '';
const URL_ = process.env.VANE_API_URL ?? 'https://vaneapp.dev/api/v1/mcp';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const fail = (id, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } });

if (!KEY) process.stderr.write('VANE_API_KEY is not set: Vane will answer every tool call with an error.\n');

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, 'Invalid JSON'); }
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: line,
    });
    if (res.status === 202) return;
    const text = await res.text();
    try { send(JSON.parse(text)); } catch { fail(msg.id, `Vane answered ${res.status}`); }
  } catch (err) {
    fail(msg.id, `Could not reach Vane: ${err.message}`);
  }
}

const rl = createInterface({ input: process.stdin });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = forward(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.all(pending); process.exit(0); });
