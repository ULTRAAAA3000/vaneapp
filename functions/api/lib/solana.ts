/**
 * Finds a payment of USDT / USDC on Solana without any third-party service: it asks a Solana RPC node which transfers reached
 * the Vane wallet and picks the one with the exact amount of the order. The wallet's token account is looked up with
 * getTokenAccountsByOwner, so no address maths is needed.
 */
import type { Env } from '../../../types';
import { callJson } from './httpcall';

export const SOLANA_ASSETS = {
  usdt: { label: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  usdc: { label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
} as const;
export type CryptoAsset = keyof typeof SOLANA_ASSETS;

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TX_PER_CHECK = 15;

export const cryptoWallet = (env: Pick<Env, 'CRYPTO_WALLET'>): string | null => {
  const w = (env.CRYPTO_WALLET ?? '').trim();
  return ADDRESS_RE.test(w) ? w : null;
};
export const cryptoEnabled = (env: Pick<Env, 'CRYPTO_WALLET'>): boolean => cryptoWallet(env) !== null;
export const assetOfMint = (mint: string): CryptoAsset | null => (Object.keys(SOLANA_ASSETS) as CryptoAsset[]).find((k) => SOLANA_ASSETS[k].mint === mint) ?? null;

async function rpc<T>(env: Pick<Env, 'SOLANA_RPC_URL'>, method: string, params: unknown[]): Promise<T | null> {
  const url = (env.SOLANA_RPC_URL ?? '').trim();
  const res = await callJson<{ result?: T; error?: unknown }>(/^https:\/\//.test(url) ? url : DEFAULT_RPC, {
    method: 'POST',
    json: { jsonrpc: '2.0', id: 1, method, params },
    timeoutMs: 12_000,
  });
  if (!res.ok || !res.data || res.data.error) return null;
  return res.data.result ?? null;
}

interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface ParsedTx { blockTime: number | null; meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null }

/** How many token units (millionths) the wallet received in this transaction, for one mint. */
export function receivedMicro(tx: ParsedTx, wallet: string, mint: string): number {
  if (!tx.meta || tx.meta.err) return 0;
  const sum = (list: TokenBalance[] | undefined): number =>
    (list ?? []).filter((b) => b.owner === wallet && b.mint === mint).reduce((n, b) => n + Number(b.uiTokenAmount.amount), 0);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}

export interface PendingCrypto { id: string; mint: string; payMicro: number; createdAt: number }

/**
 * For each waiting order, the signature of the transaction that paid exactly its amount (not yet used by another order), or null.
 * One batch of RPC calls serves every order of the same token.
 */
export async function findCryptoPayments(env: Pick<Env, 'CRYPTO_WALLET' | 'SOLANA_RPC_URL'>, orders: PendingCrypto[], used: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const wallet = cryptoWallet(env);
  if (!wallet || !orders.length) return found;
  for (const mint of new Set(orders.map((o) => o.mint))) {
    const list = orders.filter((o) => o.mint === mint);
    const accounts = await rpc<{ value: { pubkey: string }[] }>(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const since = Math.min(...list.map((o) => o.createdAt)) - 120;
    const sigs: string[] = [];
    for (const a of accounts?.value ?? []) {
      const rows = await rpc<{ signature: string; err: unknown; blockTime: number | null }[]>(env, 'getSignaturesForAddress', [a.pubkey, { limit: 25, commitment: 'confirmed' }]);
      for (const r of rows ?? []) if (!r.err && (r.blockTime === null || r.blockTime >= since) && !used.has(r.signature)) sigs.push(r.signature);
    }
    for (const sig of sigs.slice(0, MAX_TX_PER_CHECK)) {
      const tx = await rpc<ParsedTx>(env, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx) continue;
      const got = receivedMicro(tx, wallet, mint);
      const hit = list.find((o) => o.payMicro === got && !found.has(o.id) && (tx.blockTime === null || tx.blockTime >= o.createdAt - 120));
      if (hit) { found.set(hit.id, sig); used.add(sig); }
    }
  }
  return found;
}

/** A link that Phantom, Solflare and other wallets open to prefill the payment. */
export function solanaPayUrl(wallet: string, mint: string, payMicro: number, label: string): string {
  const amount = (payMicro / 1e6).toFixed(6);
  return `solana:${wallet}?amount=${amount}&spl-token=${mint}&label=${encodeURIComponent(label)}`;
}
export const formatMicro = (payMicro: number): string => (payMicro / 1e6).toFixed(6);
