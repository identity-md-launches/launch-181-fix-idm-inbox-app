/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useState } from 'react';
import { formatEther, stringToHex, type Address, type Hash } from 'viem';
import { FEE_REFRESH_MS, MAX_MESSAGE_BYTES } from './config';
import { latestPending, usePendingTx } from './pending';
import { codeWarning, mainnetClient, type CodeWarning } from './rpc';
import { requireMainnet, useWallet, walletError } from './wallet';
import { fetchEthPrice } from './Tips';

type Rpc = { request(args: { method: string; params?: unknown }): Promise<unknown> };
type FeeTx = { from: Address; to: Address; data: `0x${string}`; value: `0x${string}` };

const bytes = (value: string) => new TextEncoder().encode(value).length;

function lookalike(recipient: string, known: string[]) {
  const r = recipient.toLowerCase();
  return known.some((a) => {
    const x = a.toLowerCase();
    return x !== r && x.slice(2, 6) === r.slice(2, 6) && x.slice(-4) === r.slice(-4);
  });
}

/** Max fee on the given RPC; the composer always passes the mainnet public client. */
export async function quoteFee(rpc: Rpc, tx: FeeTx) {
  const [gas, block, priority] = await Promise.all([
    rpc.request({ method: 'eth_estimateGas', params: [tx] }),
    rpc.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
    rpc.request({ method: 'eth_maxPriorityFeePerGas' }),
  ]);
  const base = BigInt((block as { baseFeePerGas: string }).baseFeePerGas);
  return BigInt(gas as string) * (2n * base + BigInt(priority as string));
}

export function Composer({
  owner,
  counterparty,
  known = [],
}: {
  owner: Address;
  counterparty?: Address;
  known?: string[];
}) {
  const wallet = useWallet();
  const canReply = counterparty && wallet.account?.toLowerCase() === owner.toLowerCase();
  const recipient = (canReply ? counterparty : owner) as Address;
  const [text, setText] = useState('');
  const [fee, setFee] = useState<bigint>();
  const [feeUsd, setFeeUsd] = useState<number>();
  const [feeError, setFeeError] = useState(false);
  const [warning, setWarning] = useState<CodeWarning>();
  const [understood, setUnderstood] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState('');
  const { pending, setPending, track } = usePendingTx(wallet.provider);
  const count = bytes(text);
  const similar = lookalike(recipient, known);

  // Only this sender's message txs belong in the composer; tips have their own panel.
  useEffect(() => {
    setPending(latestPending('message', wallet.account));
  }, [wallet.account, setPending]);
  const sender = wallet.account?.toLowerCase();
  const shown =
    pending?.kind === 'message' && pending.from.toLowerCase() === sender ? pending : undefined;

  const estimate = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !text || count > MAX_MESSAGE_BYTES) {
      setFee(undefined);
      return;
    }
    const tx = { from: wallet.account, to: recipient, data: stringToHex(text), value: '0x0' as const };
    try {
      // Mainnet reads, whatever chain the wallet is on right now.
      const [next, code, price] = await Promise.all([
        quoteFee(mainnetClient, tx),
        mainnetClient.getCode({ address: recipient }),
        fetchEthPrice().catch(() => undefined),
      ]);
      setFee(next);
      setFeeUsd(price ? Number(formatEther(next)) * price.usd : undefined);
      setFeeError(false);
      setWarning(codeWarning(code));
    } catch {
      setFee(undefined);
      setFeeUsd(undefined);
      setFeeError(true);
    }
  }, [wallet.provider, wallet.account, text, count, recipient]);

  useEffect(() => {
    void estimate();
    const id = setInterval(() => void estimate(), FEE_REFRESH_MS);
    return () => clearInterval(id);
  }, [estimate]);

  const send = async () => {
    if (!wallet.provider || !wallet.account) return;
    if (similar && !armed) {
      setArmed(true);
      return;
    }
    setError('');
    try {
      await requireMainnet(wallet.provider);
      // Re-read the recipient on mainnet; an unacknowledged warning blocks the send.
      const found = codeWarning(await mainnetClient.getCode({ address: recipient }));
      if (found && (found !== warning || !understood)) {
        if (found !== warning) setUnderstood(false);
        setWarning(found);
        return;
      }
      const hash = (await wallet.provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: wallet.account, to: recipient, value: '0x0', data: stringToHex(text) }],
      })) as Hash;
      let nonce: number | undefined;
      try {
        const tx = (await wallet.provider.request({
          method: 'eth_getTransactionByHash',
          params: [hash],
        })) as { nonce?: string } | null;
        if (tx?.nonce) nonce = Number(BigInt(tx.nonce));
      } catch {
        /* watcher continues without nonce */
      }
      track({
        hash,
        from: wallet.account,
        kind: 'message',
        nonce,
        created: Date.now(),
        status: 'Pending',
        missingChecks: 0,
      });
      setText('');
      setArmed(false);
    } catch (e) {
      setError(walletError(e));
    }
  };

  if (!wallet.account) {
    return (
      <section className="composer">
        <p>
          {wallet.provider
            ? 'Connect your wallet to send'
            : 'Install or unlock a browser wallet to send'}
        </p>
        {globalThis.matchMedia?.('(pointer: coarse)').matches && (
          <p>
            Open this page in your wallet app's browser{' '}
            <button
              className="secondary"
              onClick={() => void navigator.clipboard.writeText(location.href)}
            >
              Copy link
            </button>
          </p>
        )}
        <button onClick={() => void wallet.connect()} disabled={wallet.connecting}>
          {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        <Safety />
      </section>
    );
  }

  const blocked =
    !text ||
    count > MAX_MESSAGE_BYTES ||
    fee === undefined ||
    feeError ||
    Boolean(warning && !understood);
  return (
    <section className="composer" aria-labelledby="compose-title">
      <h2 id="compose-title">{canReply ? `Reply to ${counterparty}` : `Message ${owner}`}</h2>
      <label htmlFor="message">Message</label>
      <textarea
        id="message"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setArmed(false);
        }}
        rows={5}
      />
      <div className={`byte-count ${count > MAX_MESSAGE_BYTES ? 'error' : ''}`}>
        {count.toLocaleString()} / {MAX_MESSAGE_BYTES.toLocaleString()} bytes
      </div>
      {feeError ? (
        <p className="error">This transaction would likely fail</p>
      ) : (
        fee !== undefined && (
          <p>
            Max fee ~ {formatEther(fee)} ETH {feeUsd !== undefined && `($${feeUsd.toFixed(2)})`}
          </p>
        )
      )}
      {warning && (
        <label className="understand">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>
            {warning === 'smart'
              ? 'This wallet runs smart-account code; your text may run it or fail.'
              : 'This address is a contract. Your text would be sent as a function call and may do something.'}{' '}
            I understand
          </span>
        </label>
      )}
      {similar && (
        <p className="warning">This address looks like another one you know. Check every character.</p>
      )}
      <button onClick={() => void send()} disabled={blocked}>
        {similar && !armed ? 'Send — review address' : 'Send'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <p className="tx-status" aria-live="polite">
          {shown.status}
        </p>
      )}
      <Safety />
    </section>
  );
}

function Safety() {
  return (
    <p className="safety">
      Messages are public forever and cannot be deleted. Never share a seed phrase.
    </p>
  );
}
