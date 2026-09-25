import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, type Address } from 'viem';
import { Composer } from './Composer';
import { loadPending, savePending, type PendingTx } from './pending';
import { WalletProvider } from './wallet';
import { fakeWallet, installFetch } from './test/network';

const account = '0x3333333333333333333333333333333333333333' as Address;
const stranger = '0x5555555555555555555555555555555555555555' as Address;
const owner = '0x4444444444444444444444444444444444444444' as Address;
const hash = `0x${'d'.repeat(64)}` as const;

type Entry = { at: number; source: 'wallet' | 'rpc'; method: string };

/** Mainnet RPC answers for a tx that stays pending and unseen. */
function mainnetRpc(log: Entry[], code: () => string) {
  return (method: string) => {
    log.push({ at: Date.now(), source: 'rpc', method });
    switch (method) {
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas':
        return '0x1';
      case 'eth_getCode':
        return code();
      case 'eth_call': {
        const now = BigInt(Math.floor(Date.now() / 1000));
        return encodeAbiParameters(
          [
            { type: 'uint80' },
            { type: 'int256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint80' },
          ],
          [1n, 2000n * 10n ** 8n, now, now, 1n],
        );
      }
      case 'eth_blockNumber':
        return `0x${(0x10 + log.length).toString(16)}`;
      case 'eth_getTransactionCount':
        return '0x0';
      default:
        return null;
    }
  };
}

function wallet(log: Entry[], chain = '0x1') {
  let current = chain;
  let lookups = 0;
  const w = fakeWallet((method, params) => {
    log.push({ at: Date.now(), source: 'wallet', method });
    switch (method) {
      case 'eth_requestAccounts':
        return [account];
      case 'eth_chainId':
        return current;
      case 'wallet_switchEthereumChain':
        current = (params as [{ chainId: string }])[0].chainId;
        return null;
      case 'eth_sendTransaction':
        return hash;
      case 'eth_getTransactionByHash':
        // The composer's nonce lookup sees the tx once; afterwards it is gone.
        return lookups++ === 0 ? { nonce: '0x1' } : null;
      default:
        return null;
    }
  });
  window.ethereum = w.provider;
  return { ...w, chain: () => current };
}

const stored = (patch: Partial<PendingTx>): PendingTx => ({
  hash,
  from: account,
  kind: 'message',
  created: Date.now(),
  status: 'Pending',
  missingChecks: 0,
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('A4 pending watcher', () => {
  const fakeClock = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // Lets fetch/Response promises settle, then runs due timers.
  const flush = async (ms = 0) => {
    await act(async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    });
  };

  async function connect() {
    await flush(500);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    await flush();
  }

  it('caps polling at 7 calls per 15 s and stops on unmount', async () => {
    fakeClock();
    const log: Entry[] = [];
    installFetch({ rpc: mainnetRpc(log, () => '0x') });
    wallet(log);
    const view = render(
      <WalletProvider>
        <Composer owner={owner} />
      </WalletProvider>,
    );
    await connect();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello there' } });
    await flush(500);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await flush();
    expect(screen.getByText('Pending')).toBeInTheDocument();

    // Count from the first watcher poll, i.e. after the send's own nonce lookup.
    const start = log.findIndex((e) => e.method === 'eth_getTransactionByHash') + 1;
    for (let s = 0; s < 120; s++) await flush(1_000);
    const polling = log.slice(start);
    for (const first of polling) {
      const inWindow = polling.filter((e) => e.at >= first.at && e.at < first.at + 15_000);
      expect(inWindow.length).toBeLessThanOrEqual(7);
    }
    const polls = polling.filter((e) => e.method === 'eth_blockNumber').length;
    expect(polls).toBeGreaterThanOrEqual(8);
    expect(polls).toBeLessThanOrEqual(9);
    // The replacement check uses the stored sender, never eth_accounts.
    expect(polling.some((e) => e.method === 'eth_accounts')).toBe(false);

    view.unmount();
    const after = log.length;
    for (let s = 0; s < 60; s++) await flush(1_000);
    expect(log.length).toBe(after);
  });

  it('ignores a stored tip and a pending tx from another account, and drops legacy entries', async () => {
    fakeClock();
    const log: Entry[] = [];
    installFetch({ rpc: mainnetRpc(log, () => '0x') });
    wallet(log);
    const legacy = { hash: `0x${'e'.repeat(64)}`, created: Date.now(), status: 'Pending', missingChecks: 0 };
    savePending([
      stored({ kind: 'tip', hash: `0x${'1'.repeat(64)}` }),
      stored({ from: stranger, hash: `0x${'2'.repeat(64)}` }),
      legacy as unknown as PendingTx,
    ]);
    expect(loadPending()).toHaveLength(2);
    const { container } = render(
      <WalletProvider>
        <Composer owner={owner} />
      </WalletProvider>,
    );
    await connect();
    for (let s = 0; s < 30; s++) await flush(1_000);
    expect(container.querySelector('.tx-status')).toBeNull();
    expect(log.some((e) => e.method === 'eth_getTransactionReceipt')).toBe(false);
  });

  it('shows and resumes a stored message pending from the connected sender', async () => {
    fakeClock();
    const log: Entry[] = [];
    installFetch({ rpc: mainnetRpc(log, () => '0x') });
    wallet(log);
    savePending([stored({})]);
    render(
      <WalletProvider>
        <Composer owner={owner} />
      </WalletProvider>,
    );
    await connect();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(log.some((e) => e.method === 'eth_getTransactionReceipt')).toBe(true);
  });
});

describe('A5 chain safety', () => {
  async function ready(log: Entry[], chain: string, code: () => string) {
    installFetch({ rpc: mainnetRpc(log, code) });
    const w = wallet(log, chain);
    render(
      <WalletProvider>
        <Composer owner={owner} />
      </WalletProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hello there' } });
    return w;
  }

  it('reads getCode on mainnet and requires "I understand" for a contract even from Base', async () => {
    const log: Entry[] = [];
    const w = await ready(log, '0x2105', () => '0x6080604052');
    const box = await screen.findByRole('checkbox', { name: /This address is a contract/ });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Pending');
    const methods = w.calls.map((c) => c.method);
    expect(methods.indexOf('wallet_switchEthereumChain'))
      .toBeLessThan(methods.indexOf('eth_sendTransaction'));
    expect(w.chain()).toBe('0x1');
    const rpcCode = log.filter((e) => e.source === 'rpc' && e.method === 'eth_getCode');
    expect(rpcCode.length).toBeGreaterThanOrEqual(2);
    expect(methods).not.toContain('eth_getCode');
    expect(methods).not.toContain('eth_estimateGas');
  });

  it('switches chain, re-reads mainnet code and blocks until the warning is acknowledged', async () => {
    const log: Entry[] = [];
    let code = '0x';
    const w = await ready(log, '0x2105', () => code);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.queryByRole('checkbox')).toBeNull();
    code = '0x6080604052';
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('checkbox', { name: /This address is a contract/ });
    const methods = () => w.calls.map((c) => c.method);
    expect(methods()).toContain('wallet_switchEthereumChain');
    expect(methods()).not.toContain('eth_sendTransaction');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Pending');
    expect(methods()).toContain('eth_sendTransaction');
    expect(methods()).not.toContain('eth_getCode');
  });
});
