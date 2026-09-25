import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockscoutClient, mapFallback, type Fetcher } from './blockscout';
import { BLOCKSCOUT, FALLBACK_INDEXER } from './config';
import { installFetch, json } from './test/network';

const owner = '0x1111111111111111111111111111111111111111';
const row = (hash: string) => ({
  hash,
  block_number: 1,
  timestamp: '2026-01-01T00:00:00Z',
  result: 'success',
  value: '0',
  raw_input: '0x6869',
  from: { hash: owner },
  to: { hash: owner, is_contract: false },
});
const fallbackRow = (hash: string) => ({
  hash,
  blockNumber: '1',
  timeStamp: '1',
  isError: '0',
  txreceipt_status: '',
  value: '0',
  input: '0x6869',
  from: owner,
  to: owner,
});
const response = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
const page = (hashes: string[], next: Record<string, string | number> | null = null) =>
  response({ items: hashes.map(row), next_page_params: next });
const fallbackPage = (count: number) =>
  response({ result: Array.from({ length: count }, (_, i) => fallbackRow(`f${i}`)) });
const urls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String(c[0]));
const asFetcher = (f: ReturnType<typeof vi.fn>) => f as unknown as Fetcher;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BlockscoutClient', () => {
  it('maps fallback empty receipt status as success and empty to as null', () => {
    const tx = mapFallback({ ...fallbackRow('h'), input: '0x', to: '' });
    expect(tx.successful).toBe(true);
    expect(tx.to).toBeNull();
  });

  it('merges by hash and refresh stops at cached hash', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(page(['a']))
      .mockResolvedValueOnce(page(['b', 'a'], { block_number: 1 }));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    await c.refresh();
    expect(c.state.transactions.map((t) => t.hash)).toEqual(['a', 'b']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('reports loaded only after the first load settles', async () => {
    let resolve: (r: Response) => void = () => undefined;
    const f = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const c = new BlockscoutClient(owner, asFetcher(f));
    const changes: boolean[] = [];
    c.onChange = () => changes.push(c.state.loading);
    const pending = c.loadInitial();
    expect(c.state.loading).toBe(true);
    expect(c.state.loaded).toBe(false);
    expect(changes).toEqual([true]);
    resolve(page(['a']));
    await pending;
    expect(c.state.loaded).toBe(true);
    expect(changes).toEqual([true, false]);
  });
});

describe('A1 browser fetch binding', () => {
  it('the stub rejects method-style calls like Chromium does', async () => {
    installFetch({ http: () => json({}) });
    const holder = { fetcher: globalThis.fetch };
    await expect(holder.fetcher('https://example.test')).rejects.toThrow('Illegal invocation');
  });

  it('loadInitial succeeds with the default fetcher', async () => {
    const { calls } = installFetch({ http: () => json({ items: [row('a')], next_page_params: null }) });
    const c = new BlockscoutClient(owner);
    await c.loadInitial();
    expect(c.state.error).toBeNull();
    expect(c.state.transactions.map((t) => t.hash)).toEqual(['a']);
    expect(calls[0].url.startsWith(`${BLOCKSCOUT}/api/v2/addresses/${owner}/transactions`)).toBe(true);
  });

  it('the FALLBACK_INDEXER path succeeds with the default fetcher', async () => {
    const { calls } = installFetch({
      http: (url) =>
        url.startsWith(FALLBACK_INDEXER) ? json({ result: [fallbackRow('f')] }) : json({}, 503),
    });
    const c = new BlockscoutClient(owner);
    await c.loadInitial();
    expect(c.state.error).toBeNull();
    expect(c.state.usingFallback).toBe(true);
    expect(c.state.transactions.map((t) => t.hash)).toEqual(['f']);
    expect(calls.map((x) => x.url.startsWith(FALLBACK_INDEXER))).toEqual([false, false, true]);
  });
});

describe('A6 retry, fallback and rate limit', () => {
  it('retries one failed request at once and stays on Blockscout', async () => {
    const f = vi.fn().mockResolvedValueOnce(response({}, 502)).mockResolvedValueOnce(page(['a']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(f).toHaveBeenCalledTimes(2);
    expect(urls(f).every((u) => u.startsWith(BLOCKSCOUT))).toBe(true);
    expect(c.state.usingFallback).toBe(false);
    expect(c.state.transactions).toHaveLength(1);
  });

  it('retries a network error once', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(page(['a']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.state.error).toBeNull();
  });

  it('switches to FALLBACK_INDEXER on the 2nd consecutive failure in the same load', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(fallbackPage(1));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(f).toHaveBeenCalledTimes(3);
    expect(urls(f)[2].startsWith(FALLBACK_INDEXER)).toBe(true);
    expect(c.state.usingFallback).toBe(true);
    expect(c.state.error).toBeNull();
    expect(c.state.transactions[0].hash).toBe('f0');
  });

  it('treats a 429 wait over 30 s as a failure', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(response({}, 429, { 'x-ratelimit-reset': '45000' }))
      .mockResolvedValueOnce(page(['a']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.state.transactions).toHaveLength(1);
  });

  it('reads x-ratelimit-reset 968 as 968 ms', async () => {
    vi.useFakeTimers();
    const f = vi
      .fn()
      .mockResolvedValueOnce(response({}, 429, { 'x-ratelimit-reset': '968' }))
      .mockResolvedValueOnce(page([]));
    const c = new BlockscoutClient(owner, asFetcher(f));
    const pending = c.loadInitial();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.retryInMs).toBe(968);
    await vi.advanceTimersByTimeAsync(967);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.state.retryInMs).toBe(0);
  });

  it('Retry tries Blockscout first when on the fallback', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(fallbackPage(1))
      .mockResolvedValueOnce(page(['a']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(c.state.usingFallback).toBe(true);
    await c.retry();
    expect(urls(f)[3].startsWith(BLOCKSCOUT)).toBe(true);
    expect(c.state.usingFallback).toBe(false);
  });
});

describe('paging', () => {
  it('has no next page and never refetches page 1 when Blockscout returns no cursor', async () => {
    const f = vi.fn().mockResolvedValueOnce(page(['a']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(c.state.hasMore).toBe(false);
    await c.loadOlder();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('continues from the cursor when older pages exist', async () => {
    const f = vi.fn();
    for (let i = 0; i < 4; i++) f.mockResolvedValueOnce(page([`p${i}`], { block_number: 10 - i }));
    f.mockResolvedValueOnce(page(['old']));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(c.state.hasMore).toBe(true);
    await c.loadOlder();
    expect(urls(f)[4]).toContain('block_number=7');
    expect(c.state.hasMore).toBe(false);
  });

  it('in fallback mode has a next page only after a full 1,000-row page', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(fallbackPage(1000))
      .mockResolvedValueOnce(fallbackPage(3));
    const c = new BlockscoutClient(owner, asFetcher(f));
    await c.loadInitial();
    expect(c.state.hasMore).toBe(true);
    await c.loadOlder();
    expect(urls(f)[3]).toContain('page=2');
    expect(c.state.hasMore).toBe(false);
    await c.loadOlder();
    expect(f).toHaveBeenCalledTimes(4);
  });
});
