import { createPublicClient, fallback, http } from 'viem';
import { mainnet } from 'viem/chains';
import { RPCS } from './config';

// Every read that must reflect Ethereum mainnet goes through this client, never the wallet.
export const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: fallback(RPCS.map((url) => http(url))),
  ccipRead: false,
});

export type CodeWarning = 'contract' | 'smart';

export function codeWarning(code: string | undefined): CodeWarning | undefined {
  const value = String(code ?? '0x').toLowerCase();
  if (value.startsWith('0xef0100')) return 'smart';
  return value !== '0x' ? 'contract' : undefined;
}
