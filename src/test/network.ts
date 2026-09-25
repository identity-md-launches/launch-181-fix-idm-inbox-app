import { vi } from 'vitest';
import type { EIP1193Provider } from 'viem';
import { RPCS } from '../config';

export type Call = { url: string; rpc?: string; params?: unknown[] };
export type RpcHandler = (method: string, params: unknown[]) => unknown;
export type HttpHandler = (url: string) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Installs a fetch stub that behaves like a browser's: calling it with any `this` other than
 * undefined or globalThis throws "Illegal invocation". JSON-RPC posts to RPCS go to `rpc`,
 * everything else to `http`. Every call is recorded.
 */
export function installFetch({ rpc, http }: { rpc?: RpcHandler; http?: HttpHandler }) {
  const calls: Call[] = [];
  const stub = vi.fn(async function (this: unknown, input: unknown, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    const url = String(input);
    if (RPCS.some((host) => url.startsWith(host))) {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
      const params = body.params ?? [];
      calls.push({ url, rpc: body.method, params });
      try {
        const result = rpc ? await rpc(body.method, params) : null;
        return json({ jsonrpc: '2.0', id: body.id, result: result ?? null });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error';
        return json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } });
      }
    }
    calls.push({ url });
    return http ? http(url) : json({}, 404);
  });
  vi.stubGlobal('fetch', stub);
  // viem builds a Request before fetching; Node's Request rejects jsdom's AbortSignal, which a
  // browser never does, so tests use a plain holder instead.
  vi.stubGlobal(
    'Request',
    class {
      constructor(
        readonly url: string,
        readonly init?: RequestInit,
      ) {}
    },
  );
  return { calls, stub };
}

export type WalletCall = { method: string; params?: unknown };

/** A minimal injected EIP-1193 wallet that records each request. */
export function fakeWallet(handler: (method: string, params?: unknown) => unknown) {
  const calls: WalletCall[] = [];
  const provider = {
    request: vi.fn(async ({ method, params }: WalletCall) => {
      calls.push({ method, params });
      return handler(method, params);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as EIP1193Provider;
  return { provider, calls };
}
