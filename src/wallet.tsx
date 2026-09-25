/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getAddress, type Address, type EIP1193Provider } from 'viem';
import { WALLET_DISCOVERY_MS } from './config';
import { useDialogFocus } from './useDialogFocus';

type Announce = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
};
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}
type WalletState = {
  provider?: EIP1193Provider;
  account?: Address;
  connecting: boolean;
  chainVersion: number;
  connect: () => Promise<void>;
};
const WalletContext = createContext<WalletState>({
  connecting: false,
  chainVersion: 0,
  connect: async () => undefined,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<Announce[]>([]);
  const [provider, setProvider] = useState<EIP1193Provider>();
  const [account, setAccount] = useState<Address>();
  const [connecting, setConnecting] = useState(false);
  const [chainVersion, setChainVersion] = useState(0);
  const [picker, setPicker] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, picker, () => setPicker(false));

  useEffect(() => {
    const found = (event: Event) => {
      const detail = (event as CustomEvent<Announce>).detail;
      if (!detail?.provider || !detail.info?.name) return;
      setProviders((list) => list.some((x) => x.provider === detail.provider)
        ? list
        : [...list, detail]);
    };
    window.addEventListener('eip6963:announceProvider', found);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const id = setTimeout(() => {
      // A legacy injection is a fallback, never an extra announced wallet.
      setProvider((current) => current ?? window.ethereum);
    }, WALLET_DISCOVERY_MS);
    return () => {
      clearTimeout(id);
      window.removeEventListener('eip6963:announceProvider', found);
    };
  }, []);

  const select = useCallback(async (chosen: EIP1193Provider) => {
    setPicker(false);
    setConnecting(true);
    try {
      const result = await chosen.request({ method: 'eth_requestAccounts' }) as string[];
      if (result[0]) {
        setProvider(chosen);
        setAccount(getAddress(result[0]));
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const connect = useCallback(async () => {
    if (providers.length > 1) {
      setPicker(true);
      return;
    }
    const chosen = providers[0]?.provider ?? provider ?? window.ethereum;
    if (chosen) await select(chosen);
  }, [providers, provider, select]);

  useEffect(() => {
    if (!provider) return;
    const changed = (xs: unknown) => {
      const address = (xs as string[])[0];
      setAccount(address ? getAddress(address) : undefined);
    };
    const chainChanged = () => setChainVersion((version) => version + 1);
    provider.on?.('accountsChanged', changed);
    provider.on?.('chainChanged', chainChanged);
    return () => {
      provider.removeListener?.('accountsChanged', changed);
      provider.removeListener?.('chainChanged', chainChanged);
    };
  }, [provider]);

  const value = useMemo(() => ({
    provider: provider ?? providers[0]?.provider,
    account,
    connecting,
    chainVersion,
    connect,
  }), [provider, providers, account, connecting, chainVersion, connect]);

  return (
    <WalletContext.Provider value={value}>
      {children}
      {picker && (
        <div className="dialog-backdrop">
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Connect wallet"
            className="dialog wallet-picker"
          >
            {providers.map((entry) => (
              <button key={entry.info.uuid} onClick={() => void select(entry.provider)}>
                {entry.info.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);

export async function requireMainnet(provider: EIP1193Provider) {
  const chain = await provider.request({ method: 'eth_chainId' });
  if (chain !== '0x1') {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x1' }],
      });
    } catch {
      throw new Error('Switch to Ethereum mainnet to send');
    }
  }
}

export function walletError(error: unknown) {
  const e = error as { code?: number; message?: string };
  if (e.code === 4001) return '';
  if (e.code === -32002) return 'Your wallet already has a request open';
  return e.message ?? 'Transaction could not be sent';
}
