export const BLOCKSCOUT = 'https://eth.blockscout.com';
export const FALLBACK_INDEXER = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
export const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://1rpc.io/eth',
] as const;
export const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
export const DEV_BOARD = '0x200E710aCAA6A93bbc77146026328C40F1d60fB1';
export const TIP_TO = '0x00B7CA53986125E3282eF55Dc74Dc9D1c66C7121';
export const EXPLORER = 'https://etherscan.io';
export const PAGE_SIZE = 50;
export const PAGE_BATCH = 4;
export const FALLBACK_PAGE_SIZE = 1_000;
export const HISTORY_LIMIT = 10_000;
export const DEFAULT_RETRY_MS = 10_000;
export const MAX_429_WAIT_MS = 30_000;
export const MAX_CONCURRENT = 2;
export const PRICE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export const REFRESH_INTERVAL_MS = 60_000;
export const MAX_FOLLOWS = 20;
export const MESSAGE_COLLAPSE_LENGTH = 2_000;
export const WALLET_DISCOVERY_MS = 500;
export const MAX_MESSAGE_BYTES = 8_192;
export const FEE_REFRESH_MS = 15_000;
export const RECEIPT_POLL_MS = 15_000;
export const DROP_AFTER_MS = 30 * 60 * 1000;
export const PRICE_REFRESH_MS = 60_000;
export const CUSTOM_TIP_MIN_ETH = '0.0001';
