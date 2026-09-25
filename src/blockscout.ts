import {
  BLOCKSCOUT,
  DEFAULT_RETRY_MS,
  FALLBACK_INDEXER,
  FALLBACK_PAGE_SIZE,
  HISTORY_LIMIT,
  MAX_429_WAIT_MS,
  MAX_CONCURRENT,
  PAGE_BATCH,
  PAGE_SIZE,
} from './config';
import type { Transaction } from './types';

export type Fetcher = (url: string) => Promise<Response>;
type Params = Record<string, string | number>;
type Page = { items?: Record<string, any>[]; next_page_params?: Params | null };

export interface ClientState {
  transactions: Transaction[];
  loading: boolean;
  /** True once the first load has finished, successfully or with a final error. */
  loaded: boolean;
  error: string | null;
  retryInMs: number;
  usingFallback: boolean;
  partial: boolean;
  historyLimit: boolean;
  /** True when an older page can be requested. */
  hasMore: boolean;
}

const emptyState = (): ClientState => ({
  transactions: [],
  loading: false,
  loaded: false,
  error: null,
  retryInMs: 0,
  usingFallback: false,
  partial: false,
  historyLimit: false,
  hasMore: false,
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Browsers throw "Illegal invocation" when fetch is called with another `this`, so never store
// the bare function and call it as a method.
const browserFetch: Fetcher = (url) => globalThis.fetch(url);

/** A Blockscout failure that is retried once and then hands over to the fallback indexer. */
class RetryableError extends Error {}

export function mapBlockscout(row: Record<string, any>): Transaction {
  return {
    hash: String(row.hash),
    block_number: Number(row.block_number),
    timestamp: String(row.timestamp),
    result: String(row.result ?? ''),
    value: String(row.value ?? '0'),
    raw_input: String(row.raw_input ?? '0x'),
    from: {
      hash: String(row.from?.hash ?? ''),
      ens_domain_name: row.from?.ens_domain_name ?? null,
    },
    to: row.to
      ? {
          hash: String(row.to.hash),
          ens_domain_name: row.to.ens_domain_name ?? null,
          is_contract: Boolean(row.to.is_contract),
        }
      : null,
    successful: String(row.result).toLowerCase() === 'success',
  };
}

export function mapFallback(row: Record<string, any>): Transaction {
  const success = String(row.isError) === '0' && String(row.txreceipt_status) !== '0';
  return {
    hash: String(row.hash),
    block_number: Number(row.blockNumber),
    timestamp: new Date(Number(row.timeStamp) * 1000).toISOString(),
    result: success ? 'success' : 'error',
    value: String(row.value ?? '0'),
    raw_input: String(row.input ?? '0x'),
    from: { hash: String(row.from ?? '') },
    to: row.to ? { hash: String(row.to) } : null,
    successful: success,
  };
}

export class BlockscoutClient {
  state = emptyState();
  /** Called whenever loading starts or stops or the rate-limit wait changes. */
  onChange?: () => void;
  private next: Params | null = null;
  private fallbackPage = 1;
  private active = 0;
  private queued: (() => void)[] = [];

  constructor(
    private address: string,
    private fetcher: Fetcher = browserFetch,
  ) {}

  private notify() {
    this.onChange?.();
  }

  private async limited(url: string): Promise<Response> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.queued.push(resolve));
    }
    this.active++;
    try {
      const fetcher = this.fetcher;
      return await fetcher(url);
    } finally {
      this.active--;
      this.queued.shift()?.();
    }
  }

  private merge(rows: Transaction[]) {
    const map = new Map(this.state.transactions.map((tx) => [tx.hash.toLowerCase(), tx]));
    rows.forEach((tx) => map.set(tx.hash.toLowerCase(), tx));
    this.state.transactions = [...map.values()]
      .sort((a, b) => b.block_number - a.block_number)
      .slice(0, HISTORY_LIMIT);
    this.state.historyLimit = map.size >= HISTORY_LIMIT;
  }

  private async blockAttempt(params: Params): Promise<{ rows: Transaction[]; next: Params | null }> {
    const query = new URLSearchParams({ items_count: String(PAGE_SIZE) });
    Object.entries(params).forEach(([k, v]) => query.set(k, String(v)));
    const url = `${BLOCKSCOUT}/api/v2/addresses/${this.address}/transactions?${query}`;
    let response: Response;
    try {
      response = await this.limited(url);
    } catch {
      throw new RetryableError('Blockscout network error');
    }
    if (response.status === 429) {
      // x-ratelimit-reset is always a number of milliseconds.
      const raw = Number(response.headers.get('x-ratelimit-reset'));
      const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_MS;
      if (ms > MAX_429_WAIT_MS) throw new RetryableError('Blockscout rate limit');
      this.state.retryInMs = ms;
      this.notify();
      await wait(ms);
      this.state.retryInMs = 0;
      this.notify();
      return this.blockAttempt(params);
    }
    if (response.status >= 500) throw new RetryableError(`Blockscout ${response.status}`);
    if (!response.ok) throw new Error(`Blockscout ${response.status}`);
    const data = (await response.json()) as Page;
    return { rows: (data.items ?? []).map(mapBlockscout), next: data.next_page_params ?? null };
  }

  /** One Blockscout page; a qualifying failure is retried once, immediately. */
  private async blockPage(params: Params = {}) {
    try {
      return await this.blockAttempt(params);
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error;
      return this.blockAttempt(params);
    }
  }

  private async fallback(page: number, paging = true) {
    const query = new URLSearchParams({
      module: 'account',
      action: 'txlist',
      address: this.address,
      page: String(page),
      offset: String(FALLBACK_PAGE_SIZE),
      sort: 'desc',
    });
    const response = await this.limited(`${FALLBACK_INDEXER}?${query}`);
    if (!response.ok) throw new Error(`Fallback ${response.status}`);
    const data = (await response.json()) as { result?: Record<string, any>[] };
    const rows = Array.isArray(data.result) ? data.result : [];
    this.merge(rows.map(mapFallback));
    this.state.usingFallback = true;
    if (paging) {
      this.fallbackPage = page;
      this.state.hasMore = rows.length === FALLBACK_PAGE_SIZE;
    }
  }

  private async switchToFallback() {
    try {
      await this.fallback(1);
      this.state.error = null;
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown) {
    this.state.error = error instanceof Error ? error.message : 'Could not load transactions';
  }

  private begin() {
    this.state.loading = true;
    this.state.error = null;
    this.notify();
  }

  private finish() {
    this.state.loading = false;
    this.state.loaded = true;
    this.notify();
  }

  async loadInitial() {
    this.next = null;
    this.fallbackPage = 1;
    if (!this.state.usingFallback) return this.load(false);
    this.begin();
    try {
      await this.fallback(1);
    } catch (error) {
      this.fail(error);
    } finally {
      this.finish();
    }
  }

  async loadOlder() {
    if (this.state.historyLimit || !this.state.hasMore) return;
    if (!this.state.usingFallback) return this.load(true);
    this.begin();
    try {
      await this.fallback(this.fallbackPage + 1);
    } catch (error) {
      this.fail(error);
    } finally {
      this.finish();
    }
  }

  private async load(older: boolean) {
    // Loading older pages continues from the stored cursor and never refetches page 1.
    if (older && !this.next) return;
    this.begin();
    try {
      let next = older ? this.next : null;
      for (let i = 0; i < PAGE_BATCH; i++) {
        const page = await this.blockPage(next ?? {});
        this.merge(page.rows);
        next = page.next;
        if (!next || this.state.historyLimit) break;
      }
      this.next = next;
      this.state.hasMore = next !== null;
    } catch (error) {
      if (error instanceof RetryableError) await this.switchToFallback();
      else this.fail(error);
    } finally {
      this.finish();
    }
  }

  async refresh() {
    if (this.state.usingFallback) {
      try {
        await this.fallback(1, false);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    const cached = new Set(this.state.transactions.map((t) => t.hash.toLowerCase()));
    this.state.partial = false;
    try {
      let next: Params | null = null;
      let found = false;
      for (let i = 0; i < PAGE_BATCH; i++) {
        const page = await this.blockPage(next ?? {});
        found = page.rows.some((t) => cached.has(t.hash.toLowerCase()));
        this.merge(page.rows);
        next = page.next;
        if (found || !next) break;
      }
      if (!found && next) this.state.partial = true;
    } catch (error) {
      if (error instanceof RetryableError) await this.switchToFallback();
      else this.fail(error);
    }
  }

  /** Tries Blockscout again first, also when the backup source is in use. */
  async retry() {
    this.state.usingFallback = false;
    await this.loadInitial();
  }
}
