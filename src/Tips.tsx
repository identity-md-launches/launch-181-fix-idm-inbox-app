/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { parseEther, type Address, type EIP1193Provider, type Hash } from 'viem';
import { CUSTOM_TIP_MIN_ETH, PRICE_REFRESH_MS, TIP_TO } from './config';
import { requireMainnet, useWallet, walletError } from './wallet';
import { usePendingTx } from './pending';
import { fetchEthPrice, type Price } from './price';
import { useDialogFocus } from './useDialogFocus';

const presets = [
  ['Buy the builders a Lambo', 250000],
  ['First-class flight to Token2049', 8000],
  ['Pizza for the builders', 50],
  ['Gas money for a week', 10],
  ['Buy us a coffee', 5],
] as const;

export async function sendTip(provider: EIP1193Provider, from: Address, eth: string) {
  await requireMainnet(provider);
  return provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: TIP_TO, value: `0x${parseEther(eth).toString(16)}`, data: '0x' }],
  });
}

export function Tips() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<Price>();
  const [priceFailed, setPriceFailed] = useState(false);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ eth: string; usd?: number }>();
  const { pending, track } = usePendingTx(wallet.provider);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog, Boolean(confirm), () => setConfirm(undefined), opener);
  // The tip panel reports tip txs only.
  const status = pending?.kind === 'tip' ? pending.status : '';

  const refresh = async () => {
    try {
      const next = await fetchEthPrice();
      setPrice(next);
      setPriceFailed(false);
      return next;
    } catch {
      setPrice(undefined);
      setPriceFailed(true);
      return undefined;
    }
  };

  useEffect(() => {
    if (open && !price && !priceFailed) void refresh();
  }, [open, price, priceFailed]);

  const execute = async (eth: string) => {
    if (!wallet.provider || !wallet.account) {
      setError('Install or unlock a browser wallet to send');
      return;
    }
    setError('');
    try {
      const hash = (await sendTip(wallet.provider, wallet.account, eth)) as Hash;
      let nonce: number | undefined;
      try {
        const tx = (await wallet.provider.request({
          method: 'eth_getTransactionByHash',
          params: [hash],
        })) as { nonce?: string } | null;
        if (tx?.nonce) nonce = Number(BigInt(tx.nonce));
      } catch {
        /* watcher can continue without nonce */
      }
      track({
        hash,
        from: wallet.account,
        kind: 'tip',
        nonce,
        created: Date.now(),
        status: 'Pending',
        missingChecks: 0,
      });
      setConfirm(undefined);
    } catch (e) {
      setError(walletError(e));
    }
  };

  const choose = async (usd: number, button: HTMLButtonElement) => {
    opener.current = button;
    let current = price;
    if (!current || Date.now() - current.at > PRICE_REFRESH_MS) current = await refresh();
    if (!current) return;
    const eth = (usd / current.usd).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (Number(eth) > 1) setConfirm({ eth, usd });
    else await execute(eth);
  };

  const customValid =
    /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(custom) && Number(custom) >= Number(CUSTOM_TIP_MIN_ETH);
  const sendCustom = (button: HTMLButtonElement) => {
    opener.current = button;
    if (Number(custom) > 1) {
      setConfirm({ eth: custom, usd: price ? Number(custom) * price.usd : undefined });
    } else {
      void execute(custom);
    }
  };

  return (
    <>
      <button className="tip-toggle secondary" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        Tip the builders
      </button>
      {open && (
        <section className="tips" aria-label="Tip the builders">
          <p>
            Tips go to the IDM Inbox builders at {TIP_TO}, not to IdentityMD or its dev.{' '}
            <button
              className="secondary copy"
              aria-label="Copy tip address"
              onClick={() => void navigator.clipboard.writeText(TIP_TO)}
            >
              Copy
            </button>
          </p>
          <div className="presets">
            {presets.map(([label, usd]) => (
              <button
                key={label}
                disabled={priceFailed}
                onClick={(e) => void choose(usd, e.currentTarget)}
              >
                <span>{label}</span>
                <small>
                  ${usd.toLocaleString()} {price && <b>· {(usd / price.usd).toFixed(6)} ETH</b>}
                </small>
              </button>
            ))}
          </div>
          <label htmlFor="custom-tip">
            Custom ETH (minimum {CUSTOM_TIP_MIN_ETH}, up to 4 decimals)
          </label>
          <div className="custom-tip">
            <input
              id="custom-tip"
              name="custom-tip"
              autoComplete="off"
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button disabled={!customValid} onClick={(e) => sendCustom(e.currentTarget)}>
              Send custom tip
            </button>
          </div>
          {priceFailed && <p className="error">USD price unavailable. Custom still works.</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <p aria-live="polite">{status}</p>
        </section>
      )}
      {confirm && (
        <div className="dialog-backdrop">
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tip-confirm"
            className="dialog"
          >
            <h2 id="tip-confirm">Confirm tip</h2>
            <p>
              {confirm.usd === undefined
                ? `You are about to send ${confirm.eth} ETH (USD price unavailable). Are you sure?`
                : `You are about to send ${confirm.eth} ETH ` +
                  `(about $${confirm.usd.toLocaleString()}). Are you sure?`}
            </p>
            <div>
              <button onClick={() => void execute(confirm.eth)}>Yes, send tip</button>
              <button className="secondary" onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
