import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { installFetch, fakeWallet, json } from './test/network';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.ethereum;
});

const round = () => {
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
};

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('B7 shared price cache', () => {
  it('shares an in-flight quote and does not fetch again before 60 seconds', async () => {
    const { fetchEthPrice } = await import('./price');
    const { stub } = installFetch({ rpc: round });
    const first = fetchEthPrice();
    const second = fetchEthPrice();
    expect(first).toBe(second);
    await tick();
    await expect(first).resolves.toMatchObject({ usd: 2000 });
    expect(stub).toHaveBeenCalledTimes(1);
    await tick(59_999);
    await fetchEthPrice();
    expect(stub).toHaveBeenCalledTimes(1);
    await tick(1);
    const refreshed = fetchEthPrice();
    await tick();
    await refreshed;
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('shares the actual price request between composer and tips', async () => {
    const { Composer } = await import('./Composer');
    const { Tips } = await import('./Tips');
    const { WalletProvider } = await import('./wallet');
    const { calls } = installFetch({
      rpc: (method) => {
        if (method === 'eth_call') return round();
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
        if (method === 'eth_getCode') return '0x';
        return '0x1';
      },
    });
    const account = '0x3333333333333333333333333333333333333333';
    window.ethereum = fakeWallet(() => [account]).provider;
    render(<WalletProvider><Composer owner={account} /><Tips /></WalletProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    await tick();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tip the builders' }));
    await tick(500);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    const priceCalls = () => calls.filter((call) => call.rpc === 'eth_call');
    expect(priceCalls()).toHaveLength(1);
    await tick(45_000);
    expect(priceCalls()).toHaveLength(1);
    await tick(15_000);
    expect(priceCalls()).toHaveLength(2);
  });

  it('caches a failed price attempt too, and retries after 60 seconds', async () => {
    const { fetchEthPrice } = await import('./price');
    // A valid but zero Chainlink answer falls through to failing stats, without RPC retries.
    const zero = encodeAbiParameters(
      [
        { type: 'uint80' },
        { type: 'int256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint80' },
      ],
      [1n, 0n, 0n, 0n, 1n],
    );
    const { calls } = installFetch({ rpc: () => zero, http: () => json({}, 503) });
    const failed = expect(fetchEthPrice()).rejects.toThrow('Price unavailable');
    await tick();
    await failed;
    await tick(59_999);
    await expect(fetchEthPrice()).rejects.toThrow('Price unavailable');
    expect(calls).toHaveLength(2);
    await tick(1);
    const retry = expect(fetchEthPrice()).rejects.toThrow('Price unavailable');
    await tick();
    await retry;
    expect(calls).toHaveLength(4);
  });
});
