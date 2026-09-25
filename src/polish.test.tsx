import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { Composer } from './Composer';
import { Tips } from './Tips';
import { WalletProvider } from './wallet';
import { mainnetClient } from './rpc';
import { fetchEthPrice } from './price';
import { savePending, type PendingTx } from './pending';
import { DROP_AFTER_MS, RECEIPT_POLL_MS } from './config';
import { fakeWallet } from './test/network';

vi.mock('./rpc', async (original) => ({
  ...await original<typeof import('./rpc')>(),
  mainnetClient: {
    request: vi.fn(),
    getCode: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(),
    getTransactionCount: vi.fn(),
  },
}));
vi.mock('./price', () => ({ fetchEthPrice: vi.fn() }));

const account = '0x3333333333333333333333333333333333333333' as Address;
const owner = '0x4444444444444444444444444444444444444444' as Address;
const similar = '0x4444555555555555555555555555555555554444';
const hash = `0x${'d'.repeat(64)}` as const;
let receipt: unknown;
let listeners: Map<string, (value: unknown) => void>;

function wallet() {
  const w = fakeWallet((method) => {
    if (method === 'eth_requestAccounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_sendTransaction') return hash;
    if (method === 'eth_getTransactionReceipt') return receipt;
    return null;
  });
  vi.mocked(w.provider.on).mockImplementation((event, listener) => {
    listeners.set(event, listener as (value: unknown) => void);
  });
  window.ethereum = w.provider;
  return w;
}

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function connect() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
  await tick();
}

async function compose(known: string[] = []) {
  const w = wallet();
  render(
    <WalletProvider>
      <Composer owner={owner} counterparty={account} known={known} />
      <Tips />
    </WalletProvider>,
  );
  await connect();
  return w;
}

async function type(value = 'hello there') {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value } });
  await tick(500);
}

async function tips() {
  const w = await compose();
  fireEvent.click(screen.getByRole('button', { name: 'Tip the builders' }));
  await tick();
  return w;
}

const sent = (w: ReturnType<typeof wallet>) =>
  w.calls.filter((call) => call.method === 'eth_sendTransaction');

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  localStorage.clear();
  receipt = null;
  listeners = new Map();
  vi.mocked(mainnetClient.request).mockImplementation(async ({ method }) => {
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    return '0x1';
  });
  vi.mocked(mainnetClient.getCode).mockResolvedValue('0x');
  vi.mocked(mainnetClient.getTransactionReceipt).mockRejectedValue(new Error('not found'));
  vi.mocked(mainnetClient.getTransaction).mockRejectedValue(new Error('not found'));
  vi.mocked(mainnetClient.getBlockNumber).mockResolvedValue(1n);
  vi.mocked(mainnetClient.getTransactionCount).mockResolvedValue(2);
  vi.mocked(fetchEthPrice).mockImplementation(async () => ({ usd: 2000, at: Date.now() }));
});

afterEach(() => {
  vi.useRealTimers();
  delete window.ethereum;
});

describe('B1/B2 tips', () => {
  it('confirms Lambo, traps both Tab directions, and restores focus on Esc without sending', async () => {
    const w = await tips();
    const lambo = screen.getByRole('button', { name: /Buy the builders a Lambo/ });
    lambo.focus();
    fireEvent.click(lambo);
    await tick();
    const dialog = screen.getByRole('dialog');
    const [yes, cancel] = within(dialog).getAllByRole('button');
    expect(yes).toHaveFocus();
    fireEvent.keyDown(yes, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(yes).toHaveFocus();
    fireEvent.keyDown(yes, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lambo).toHaveFocus();
    expect(sent(w)).toHaveLength(0);
  });

  it('sends the $5 preset without a dialog', async () => {
    const w = await tips();
    fireEvent.click(screen.getByRole('button', { name: /Buy us a coffee/ }));
    await tick();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent(w)).toHaveLength(1);
    expect(sent(w)[0].params).toEqual([expect.objectContaining({ data: '0x' })]);
  });

  it('rejects 0 and five decimals and sends the exact 0.0001 ETH minimum', async () => {
    const w = await tips();
    const input = screen.getByLabelText(/Custom ETH/);
    const send = screen.getByRole('button', { name: 'Send custom tip' });
    for (const value of ['0', '0.00015']) {
      fireEvent.change(input, { target: { value } });
      expect(send).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: '0.0001' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await tick();
    expect(sent(w)[0].params).toEqual([
      expect.objectContaining({ value: '0x5af3107a4000' }),
    ]);
  });

  it('disables all five presets on price failure and confirms custom ETH without $0', async () => {
    vi.mocked(fetchEthPrice).mockRejectedValue(new Error('offline'));
    await tips();
    const presets = document.querySelectorAll('.presets button');
    expect(presets).toHaveLength(5);
    presets.forEach((button) => expect(button).toBeDisabled());
    fireEvent.change(screen.getByLabelText(/Custom ETH/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send custom tip' }));
    expect(within(screen.getByRole('dialog')).getByText(
      'You are about to send 2 ETH (USD price unavailable). Are you sure?',
    )).toBeInTheDocument();
  });
});

describe('B3/B5 composer gates', () => {
  it('requires a second click for a lookalike', async () => {
    const w = await compose([similar]);
    await type();
    fireEvent.click(screen.getByRole('button', { name: 'Send — review address' }));
    await tick();
    expect(sent(w)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await tick();
    expect(sent(w)).toHaveLength(1);
  });

  it.each([
    ['0x60806040', 'This address is a contract.'],
    ['0xef01001234', 'This wallet runs smart-account code;'],
  ] as const)('requires acknowledgement for code %s', async (code, warning) => {
    vi.mocked(mainnetClient.getCode).mockResolvedValue(code);
    const w = await compose();
    await type();
    const checkbox = screen.getByRole('checkbox', { name: new RegExp(warning) });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await tick();
    expect(sent(w)).toHaveLength(1);
  });

  it('offers Message owner and no Reply when the connected sender is not the owner', async () => {
    await compose();
    expect(screen.getByRole('heading', { name: `Message ${owner}` })).toBeInTheDocument();
    expect(screen.queryByText(/Reply/)).toBeNull();
  });

  it('can send exactly 8192 UTF-8 bytes and blocks 8193', async () => {
    const w = await compose();
    const content = 'é'.repeat(4096);
    await type(content + 'a');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(mainnetClient.request).not.toHaveBeenCalled();
    await type(content);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await tick();
    const tx = (sent(w)[0].params as [{ data: string }])[0];
    expect(tx.data).toBe(`0x${'c3a9'.repeat(4096)}`);
  });
});

describe('B4 pending and failed estimates', () => {
  it('announces Pending then Sent after a receipt', async () => {
    await compose();
    await type();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await tick();
    expect(screen.getByText('Pending').closest('[aria-live="polite"]')).not.toBeNull();
    receipt = { status: '0x1' };
    await tick(RECEIPT_POLL_MS);
    expect(screen.getByText('Sent').closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('drops only after 30 minutes and two block-distinct missing polls', async () => {
    const tx: PendingTx = {
      hash,
      from: account,
      nonce: 1,
      kind: 'message',
      created: Date.now(),
      status: 'Pending',
      missingChecks: 0,
    };
    savePending([tx]);
    await compose();
    await tick(DROP_AFTER_MS - 1);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    await tick(1);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    vi.mocked(mainnetClient.getBlockNumber).mockResolvedValue(2n);
    await tick(RECEIPT_POLL_MS);
    expect(screen.getByText('Dropped or replaced - check your wallet')
      .closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('does not drop early even when two blocks and a replacement nonce are available', async () => {
    savePending([{
      hash,
      from: account,
      nonce: 1,
      kind: 'message',
      created: Date.now(),
      status: 'Pending',
      missingChecks: 0,
    }]);
    await compose();
    vi.mocked(mainnetClient.getBlockNumber).mockResolvedValue(2n);
    await tick(RECEIPT_POLL_MS);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    await tick(DROP_AFTER_MS - RECEIPT_POLL_MS);
    expect(screen.getByText('Dropped or replaced - check your wallet')).toBeInTheDocument();
  });

  it('shows an estimateGas revert and disables Send', async () => {
    vi.mocked(mainnetClient.request).mockRejectedValue(new Error('execution reverted'));
    await compose();
    await type();
    expect(screen.getByText('This transaction would likely fail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('B7 fees', () => {
  it('debounces five keystrokes to one estimate 500 ms after the final change', async () => {
    await compose();
    for (let count = 1; count <= 5; count++) {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'a'.repeat(count) } });
      await tick(90);
    }
    const estimates = () => (vi.mocked(mainnetClient.request).mock.calls as unknown as
      [{ method: string }][]).filter(([request]) => request.method === 'eth_estimateGas');
    await tick(409);
    expect(estimates()).toHaveLength(0);
    await tick(1);
    expect(estimates()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('ignores a slow old fee reply after a newer estimate completes', async () => {
    let finish!: (gas: `0x${string}`) => void;
    vi.mocked(mainnetClient.request).mockImplementation(async ({ method }) => {
      if (method === 'eth_estimateGas') {
        return new Promise<`0x${string}`>((resolve) => { finish = resolve; });
      }
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      return '0x1';
    });
    await compose();
    await type('first');
    const earlier = finish;
    await type('second');
    await act(async () => { finish('0x2'); });
    expect(screen.getByText(/Max fee ~/)).toHaveTextContent('0.000000000000000006 ETH');
    await act(async () => { earlier('0xffff'); });
    expect(screen.getByText(/Max fee ~/)).toHaveTextContent('0.000000000000000006 ETH');
  });
});

describe('B8 wallets', () => {
  it('lists both announced names, traps picker focus, and connects the selected provider', async () => {
    const first = wallet();
    const second = wallet();
    render(<WalletProvider><Composer owner={owner} /></WalletProvider>);
    act(() => {
      for (const [name, provider] of [['Alpha', first.provider], ['Beta', second.provider]] as const) {
        dispatchEvent(new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: name, name, icon: '', rdns: name }, provider },
        }));
      }
    });
    await connect();
    const picker = screen.getByRole('dialog', { name: 'Connect wallet' });
    const alpha = within(picker).getByRole('button', { name: 'Alpha' });
    const beta = within(picker).getByRole('button', { name: 'Beta' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'Tab', shiftKey: true });
    expect(beta).toHaveFocus();
    fireEvent.click(beta);
    await tick();
    expect(first.calls).toHaveLength(0);
    expect(second.calls[0].method).toBe('eth_requestAccounts');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rechecks fee and code on chainChanged and clears the lookalike arm', async () => {
    const w = await compose([similar]);
    await type();
    fireEvent.click(screen.getByRole('button', { name: 'Send — review address' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    vi.mocked(mainnetClient.request).mockClear();
    vi.mocked(mainnetClient.getCode).mockClear();
    act(() => listeners.get('chainChanged')?.('0x2105'));
    expect(screen.getByRole('button', { name: 'Send — review address' })).toBeDisabled();
    await tick(500);
    expect(mainnetClient.getCode).toHaveBeenCalledWith({ address: owner });
    expect(mainnetClient.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_estimateGas',
    }));
    expect(sent(w)).toHaveLength(0);
    act(() => listeners.get('accountsChanged')?.([]));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });
});
