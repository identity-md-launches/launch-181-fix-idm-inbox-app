import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, EIP1193Provider, Hash } from 'viem';
import { DROP_AFTER_MS, RECEIPT_POLL_MS } from './config';
import { mainnetClient as rpc } from './rpc';
import { safeStorage } from './storage';

export type PendingKind = 'message' | 'tip';
export type PendingStatus = 'Pending' | 'Sent' | 'Dropped or replaced - check your wallet';
export type PendingTx = {
  hash: Hash;
  from: Address;
  kind: PendingKind;
  nonce?: number;
  created: number;
  status: PendingStatus;
  lastMissingBlock?: bigint;
  missingChecks: number;
};

const key = 'idm:pending';
const kinds: readonly string[] = ['message', 'tip'];

function isPending(value: unknown): value is PendingTx {
  const x = value as Partial<PendingTx> | null;
  return (
    typeof x?.hash === 'string' &&
    typeof x.from === 'string' &&
    typeof x.kind === 'string' &&
    kinds.includes(x.kind)
  );
}

/** Stored pending txs; entries written before `from` and `kind` existed are dropped. */
export function loadPending(): PendingTx[] {
  try {
    const items = JSON.parse(safeStorage.get(key) ?? '[]') as unknown;
    return Array.isArray(items) ? items.filter(isPending) : [];
  } catch {
    return [];
  }
}

export function savePending(items: PendingTx[]) {
  const json = JSON.stringify(items, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  safeStorage.set(key, json);
}

export function storePending(tx: PendingTx) {
  savePending([...loadPending().filter((x) => x.hash !== tx.hash), tx]);
}

export function latestPending(kind: PendingKind, from?: string): PendingTx | undefined {
  if (!from) return undefined;
  const sender = from.toLowerCase();
  return loadPending()
    .filter((x) => x.kind === kind && x.from.toLowerCase() === sender)
    .at(-1);
}

export async function pollPending(
  tx: PendingTx,
  provider: EIP1193Provider | undefined,
  now = Date.now(),
): Promise<PendingTx> {
  let receipt: unknown = null;
  try {
    if (provider) {
      receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [tx.hash] });
    }
  } catch {
    /* try public RPC */
  }
  if (!receipt) {
    try {
      receipt = await rpc.getTransactionReceipt({ hash: tx.hash });
    } catch {
      /* still pending */
    }
  }
  if (receipt) return { ...tx, status: 'Sent' };

  let found: unknown = null;
  try {
    if (provider) {
      found = await provider.request({ method: 'eth_getTransactionByHash', params: [tx.hash] });
    }
  } catch {
    /* try public RPC */
  }
  if (!found) {
    try {
      found = await rpc.getTransaction({ hash: tx.hash });
    } catch {
      /* not found anywhere */
    }
  }
  if (found) return { ...tx, missingChecks: 0 };

  const block = await rpc.getBlockNumber().catch(() => tx.lastMissingBlock ?? 0n);
  const distinct = tx.lastMissingBlock === undefined || block > BigInt(tx.lastMissingBlock);
  const checks = distinct ? tx.missingChecks + 1 : tx.missingChecks;
  let replaced = false;
  if (tx.nonce !== undefined) {
    try {
      // The stored sender, not whichever account the wallet shows now.
      const count = await rpc.getTransactionCount({ address: tx.from, blockTag: 'latest' });
      replaced = count > tx.nonce;
    } catch {
      /* cannot establish replacement */
    }
  }
  const aged = now - tx.created >= DROP_AFTER_MS;
  const dropped = checks >= 2 && (aged || replaced);
  return {
    ...tx,
    lastMissingBlock: block,
    missingChecks: checks,
    status: dropped ? 'Dropped or replaced - check your wallet' : 'Pending',
  };
}

/**
 * Polls one tx every RECEIPT_POLL_MS until it leaves Pending. Progress is persisted after each
 * poll; `onStatus` runs only when the status changes. Returns a stop function.
 */
export function watchPending(
  tx: PendingTx,
  getProvider: () => EIP1193Provider | undefined,
  onStatus: (tx: PendingTx) => void,
) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current = tx;
  const run = async () => {
    timer = undefined;
    const next = await pollPending(current, getProvider());
    if (!active) return;
    const changed = next.status !== current.status;
    current = next;
    storePending(next);
    if (changed) onStatus(next);
    if (next.status === 'Pending') timer = setTimeout(() => void run(), RECEIPT_POLL_MS);
  };
  void run();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Pending-tx state with exactly one polling loop per tx hash. */
export function usePendingTx(provider: EIP1193Provider | undefined) {
  const [pending, setPending] = useState<PendingTx>();
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);
  const hash = pending?.hash;
  useEffect(() => {
    if (!hash || !pending || pending.status !== 'Pending') return;
    return watchPending(pending, () => providerRef.current, setPending);
    // The loop is keyed by the tx hash alone; status updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);
  const track = useCallback((tx: PendingTx) => {
    storePending(tx);
    setPending(tx);
  }, []);
  return { pending, setPending, track };
}
