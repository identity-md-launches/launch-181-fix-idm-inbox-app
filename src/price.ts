import { BLOCKSCOUT, CHAINLINK_ETH_USD, PRICE_MAX_AGE_MS, PRICE_REFRESH_MS } from './config';
import { mainnetClient as client } from './rpc';

export type Price = { usd: number; at: number };

const latestRoundData = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80' },
      { type: 'int256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint80' },
    ],
  },
] as const;

async function readEthPrice(now = Date.now()): Promise<Price> {
  try {
    const result = await client.readContract({
      address: CHAINLINK_ETH_USD,
      abi: latestRoundData,
      functionName: 'latestRoundData',
    });
    const answer = Number(result[1]) / 1e8;
    const at = Number(result[3]) * 1000;
    if (answer > 0 && now - at <= PRICE_MAX_AGE_MS) return { usd: answer, at };
  } catch {
    /* Blockscout fallback */
  }
  const response = await globalThis.fetch(`${BLOCKSCOUT}/api/v2/stats`);
  if (!response.ok) throw new Error('Price unavailable');
  const body = (await response.json()) as { coin_price?: string };
  const usd = Number(body.coin_price);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('Price unavailable');
  return { usd, at: now };
}

// Share in-flight requests and failures as well as successful quotes.
let cached: Promise<Price> | undefined;
let requestedAt = -Infinity;

export function fetchEthPrice(now = Date.now()): Promise<Price> {
  if (!cached || now - requestedAt >= PRICE_REFRESH_MS) {
    requestedAt = now;
    cached = readEthPrice(now);
  }
  return cached;
}
