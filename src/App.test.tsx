import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { getAddress } from 'viem';
import fixture from '../fixtures/dev-board.json';
import App from './App';
import { BlockscoutClient } from './blockscout';
import { BLOCKSCOUT, DEV_BOARD, FALLBACK_INDEXER } from './config';
import { installFetch, json } from './test/network';

const pages = fixture.pages as { items: unknown[]; next_page_params: unknown }[];
const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const hex = (s: string) =>
  `0x${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const item = (from: string, to: string, text: string, extra: Record<string, unknown> = {}) => ({
  hash: `0x${'a'.repeat(64)}`,
  block_number: 100,
  timestamp: '2026-03-01T00:00:00Z',
  result: 'success',
  value: '0',
  raw_input: hex(text),
  from: { hash: from },
  to: { hash: to, is_contract: false },
  ...extra,
});

/** Serves the committed dev-board fixture from a mocked Blockscout. */
function boardResponse(url: string) {
  if (!url.includes(`/addresses/${DEV_BOARD}/`)) return json({ items: [], next_page_params: null });
  return json(url.includes('index=') ? pages[1] : pages[0]);
}

async function navigate(hash: string) {
  await act(async () => {
    location.hash = hash;
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the fixture board with Posts first and no axe violations', async () => {
    const { calls } = installFetch({ http: boardResponse });
    location.hash = '#/';
    const { container } = render(<App />);
    expect(
      screen.getByRole('heading', { name: 'IMD dev board - read via IDM Inbox (independent)' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Open an address or ENS name')).toBeInTheDocument();
    expect((await screen.findByText(/threads loaded/)).textContent).not.toBe('0 threads loaded');
    expect(calls[0].url).toContain(`${BLOCKSCOUT}/api/v2/addresses/${DEV_BOARD}/transactions`);
    const rows = screen.getAllByRole('link');
    expect(rows.some((row) => row.textContent?.includes('0x9073…1859'))).toBe(true);
    expect(screen.getByText('Posts').closest('a')).toBe(container.querySelector('.thread'));
    const results = await axe(container);
    const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
    expect(serious).toEqual([]);
  });

  it('shows not found', () => {
    installFetch({ http: boardResponse });
    location.hash = '#/wrong';
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('refreshes only the visible open inbox every 60 seconds', async () => {
    installFetch({ http: boardResponse });
    vi.useFakeTimers();
    location.hash = '#/';
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const refresh = vi.spyOn(BlockscoutClient.prototype, 'refresh').mockResolvedValue();
    render(<App />);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('A2 live dev board and loading state', () => {
  it('shows "Loading messages…" on a thread deep link while the first fetch is pending', async () => {
    installFetch({ http: () => new Promise<Response>(() => undefined) });
    const party = getAddress('0x90738abe9b04622dc0b3d015a3964cc7d1fd1859');
    location.hash = `#/a/${DEV_BOARD}/${party}`;
    render(<App />);
    await act(async () => undefined);
    expect(screen.getByText('Loading messages…')).toBeInTheDocument();
    expect(screen.queryByText('Not found')).toBeNull();
    expect(screen.queryByText('No messages yet')).toBeNull();
  });

  it('shows no dev-board threads and never "No messages yet" before the first load', async () => {
    installFetch({ http: () => new Promise<Response>(() => undefined) });
    location.hash = '#/';
    render(<App />);
    await act(async () => undefined);
    expect(screen.getByText('Loading messages…')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(document.querySelector('.thread')).toBeNull();
  });

  it('shows "Not found" for a thread only after the load finishes', async () => {
    installFetch({ http: () => json({ items: [], next_page_params: null }) });
    location.hash = `#/a/${owner}/${other}`;
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });
});

describe('A3 navigation', () => {
  it('moving from #/ to another inbox creates a fresh client and fetches it', async () => {
    const { calls } = installFetch({ http: boardResponse });
    location.hash = '#/';
    render(<App />);
    await screen.findByText(/threads loaded/);
    expect(screen.getAllByRole('link').some((a) => a.textContent?.includes('0x9073…1859'))).toBe(true);
    const before = calls.length;
    await navigate(`#/a/${other}`);
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    expect(calls.slice(before).some((c) => c.url.includes(`/addresses/${other}/`))).toBe(true);
    expect(screen.queryByText(/0x9073…1859/)).toBeNull();
    expect(screen.queryByText('Posts')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
  });
});

describe('A6 backup source banner', () => {
  it('shows Retry on the fallback banner, and Retry calls Blockscout first on a thread route', async () => {
    let blockscoutUp = false;
    const fallbackRow = {
      hash: `0x${'b'.repeat(64)}`,
      blockNumber: '100',
      timeStamp: '1767225600',
      isError: '0',
      txreceipt_status: '1',
      value: '0',
      input: hex('hello there'),
      from: other,
      to: owner,
    };
    const { calls } = installFetch({
      http: (url) => {
        if (url.startsWith(FALLBACK_INDEXER)) return json({ result: [fallbackRow] });
        return blockscoutUp ? json({ items: [], next_page_params: null }) : json({}, 503);
      },
    });
    location.hash = `#/a/${owner}/${other}`;
    render(<App />);
    expect(await screen.findByText('Using backup data source')).toBeInTheDocument();
    expect(screen.getByText('hello there')).toBeInTheDocument();
    const before = calls.length;
    blockscoutUp = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/thread loaded/);
    expect(calls[before].url.startsWith(BLOCKSCOUT)).toBe(true);
    expect(screen.queryByText('Using backup data source')).toBeNull();
  });
});

describe('A7 threads', () => {
  const received = item(other, owner, 'hello there');

  it('opening a Requests thread moves it to Inbox and clears New without a refresh', async () => {
    localStorage.setItem(`idm:baseline:${owner}`, '1');
    const { calls } = installFetch({ http: () => json({ items: [received], next_page_params: null }) });
    location.hash = `#/a/${owner}`;
    render(<App />);
    await screen.findByText('1 thread loaded');
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
    const row = screen.getByRole('link', { name: /hello there/ });
    expect(within(row).getByText('New')).toBeInTheDocument();

    await navigate(`#/a/${owner}/${other}`);
    expect(screen.getByRole('heading', { name: '0x2222…2222' })).toBeInTheDocument();
    await navigate(`#/a/${owner}`);
    const inboxRow = screen.getByRole('link', { name: /hello there/ });
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
    expect(within(inboxRow).queryByText('New')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('labels a thread by the sender of its last, received message', async () => {
    const sent = item(owner, other, 'first from owner', {
      hash: `0x${'c'.repeat(64)}`,
      timestamp: '2026-02-01T00:00:00Z',
      from: { hash: owner, ens_domain_name: 'owner.eth' },
      to: { hash: other, ens_domain_name: 'alice.eth' },
    });
    const reply = item(other, owner, 'reply from alice', {
      from: { hash: other, ens_domain_name: 'alice.eth' },
      to: { hash: owner, ens_domain_name: 'owner.eth' },
    });
    installFetch({ http: () => json({ items: [reply, sent], next_page_params: null }) });
    location.hash = `#/a/${owner}`;
    render(<App />);
    await screen.findByText('1 thread loaded');
    expect(screen.getByText('alice.eth · 0x2222…2222')).toBeInTheDocument();
    expect(screen.queryByText(/owner\.eth/)).toBeNull();
  });

  it('shows no Load older or latest-N line without a next page', async () => {
    installFetch({ http: () => json({ items: [received], next_page_params: null }) });
    location.hash = `#/a/${owner}`;
    render(<App />);
    await screen.findByText('1 thread loaded');
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
  });

  it('shows Load older when a next page exists and continues from the cursor', async () => {
    // Each page points 10 blocks further back; block 20 is the last page.
    const { calls } = installFetch({
      http: (url) => {
        const cursor = Number(new URL(url).searchParams.get('block_number') ?? 60);
        const next = cursor > 20 ? { block_number: cursor - 10 } : null;
        return json({ items: cursor === 60 ? [received] : [], next_page_params: next });
      },
    });
    location.hash = `#/a/${owner}`;
    render(<App />);
    await screen.findByText('1 thread loaded');
    expect(calls).toHaveLength(4);
    expect(screen.getByText('Showing the latest 1 transactions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await act(async () => undefined);
    expect(calls.slice(4).map((c) => new URL(c.url).searchParams.get('block_number'))).toEqual([
      '20',
    ]);
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });
});

describe('B6 keyboard order and ENS; B8 URL copying', () => {
  it('orders search before the first row before Load older, with no positive tabindex', async () => {
    const row = item(DEV_BOARD, DEV_BOARD, 'hello board');
    installFetch({
      http: (url) => {
        const cursor = Number(new URL(url).searchParams.get('block_number') ?? 100);
        return json({ items: [row], next_page_params: { block_number: cursor - 10 } });
      },
    });
    location.hash = '#/';
    const { container } = render(<App />);
    await screen.findByText('1 thread loaded');
    const focusables = [...container.querySelectorAll<HTMLElement>(
      'a[href], button, input, [tabindex]',
    )];
    const search = screen.getByLabelText('Open an address or ENS name');
    const first = container.querySelector<HTMLElement>('.thread')!;
    const older = screen.getByRole('button', { name: 'Load older' });
    expect(focusables.indexOf(search)).toBeLessThan(focusables.indexOf(first));
    expect(focusables.indexOf(first)).toBeLessThan(focusables.indexOf(older));
    focusables.forEach((element) => expect(element.tabIndex).toBeLessThanOrEqual(0));
  });

  it('moves selection and focus in both directions between Inbox and Requests', async () => {
    installFetch({ http: boardResponse });
    location.hash = '#/';
    render(<App />);
    await screen.findByText(/threads loaded/);
    const inbox = screen.getByRole('tab', { name: 'Inbox' });
    const requests = screen.getByRole('tab', { name: 'Requests' });
    inbox.focus();
    fireEvent.keyDown(inbox, { key: 'ArrowRight' });
    expect(requests).toHaveFocus();
    expect(requests).toHaveAttribute('aria-selected', 'true');
    expect(inbox).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(requests, { key: 'ArrowLeft' });
    expect(inbox).toHaveFocus();
    expect(inbox).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the required error for an ENS OffchainLookup revert', async () => {
    const { mainnetClient } = await import('./rpc');
    const resolve = vi.spyOn(mainnetClient, 'getEnsAddress')
      .mockRejectedValue(new Error('execution reverted: OffchainLookup'));
    installFetch({ http: boardResponse });
    location.hash = '#/';
    render(<App />);
    fireEvent.change(screen.getByLabelText('Open an address or ENS name'), {
      target: { value: 'offchain.eth' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't resolve this name");
    expect(resolve).toHaveBeenCalledWith({ name: 'offchain.eth' });
  });

  it.each(['http://example.test/a', 'https://example.test/b', 'www.example.test/c'])(
    'warns for %s and copies each URL alone',
    async (url) => {
      const copy = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copy } });
      const second = 'https://second.test/d';
      const row = item(other, owner, `hello see ${url} and ${second} please`);
      installFetch({ http: () => json({ items: [row], next_page_params: null }) });
      location.hash = `#/a/${owner}/${other}`;
      render(<App />);
      expect(await screen.findByText('Links in messages may be scams.')).toBeInTheDocument();
      const buttons = screen.getAllByRole('button', { name: 'Copy' });
      expect(buttons).toHaveLength(2);
      fireEvent.click(buttons[0]);
      expect(copy).toHaveBeenLastCalledWith(url);
      fireEvent.click(buttons[1]);
      expect(copy).toHaveBeenLastCalledWith(second);
    },
  );
});
