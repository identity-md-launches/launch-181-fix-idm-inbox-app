import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { formatEther, getAddress, isAddress, type Address } from 'viem';
import { normalize } from 'viem/ens';
import { BlockscoutClient } from './blockscout';
import { DEV_BOARD, EXPLORER, MAX_FOLLOWS, MESSAGE_COLLAPSE_LENGTH, REFRESH_INTERVAL_MS } from './config';
import { mainnetClient } from './rpc';
import { isLocalStateAvailable, safeStorage } from './storage';
import { acceptRequest, buildThreads, openThread, type Message, type Thread } from './threads';
import { Composer } from './Composer';
import { Tips } from './Tips';
import { useWallet } from './wallet';
import './styles.css';
import './review.css';
import './ui.css';

type Route =
  | { kind: 'inbox'; owner: string }
  | { kind: 'thread'; owner: string; party: string }
  | { kind: 'notfound' };

function readRoute(): Route {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!p.length) return { kind: 'inbox', owner: DEV_BOARD };
  if (p[0] === 'a' && p.length === 2 && isAddress(p[1], { strict: true })) {
    return { kind: 'inbox', owner: getAddress(p[1]) };
  }
  if (
    p[0] === 'a' &&
    p.length === 3 &&
    isAddress(p[1], { strict: true }) &&
    isAddress(p[2], { strict: true })
  ) {
    return { kind: 'thread', owner: getAddress(p[1]), party: getAddress(p[2]) };
  }
  return { kind: 'notfound' };
}

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const isDevBoard = (owner: string) => owner.toLowerCase() === DEV_BOARD.toLowerCase();

const absolute = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    .format(d) + ' UTC';

function relative(d: Date) {
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [n, u]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [seconds, 'second']
      : abs < 3600
        ? [Math.round(seconds / 60), 'minute']
        : abs < 86400
          ? [Math.round(seconds / 3600), 'hour']
          : [Math.round(seconds / 86400), 'day'];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(n, u);
}

const followKey = 'idm:follows';
function follows(): string[] {
  try {
    return JSON.parse(safeStorage.get(followKey) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export default function App() {
  const [current, setCurrent] = useState(readRoute);
  useEffect(() => {
    const h = () => setCurrent(readRoute());
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <a className="brand" href="#/">
          IDM Inbox
        </a>
        <span className="network">Ethereum mainnet</span>
      </header>
      <main id="main">
        {!isLocalStateAvailable() && (
          <div className="notice local">Follow and read status are off in this browser</div>
        )}
        {current.kind === 'notfound' ? (
          <section className="empty">
            <h1>Not found</h1>
            <a href="#/">Go home</a>
          </section>
        ) : (
          // A new owner gets a fresh client, thread state and fetch.
          <Inbox key={current.owner.toLowerCase()} route={current} />
        )}
      </main>
      <Footer />
    </div>
  );
}

function Search() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const input = value.trim();
    if (input.startsWith('0x')) {
      if (isAddress(input, { strict: true })) {
        location.hash = `/a/${getAddress(input)}`;
        return;
      }
      setError('Not a valid address or ENS name');
      return;
    }
    let name: string;
    try {
      name = normalize(input);
    } catch {
      setError('Not a valid address or ENS name');
      return;
    }
    try {
      const address = await mainnetClient.getEnsAddress({ name });
      if (address) {
        location.hash = `/a/${address}`;
        return;
      }
    } catch {
      /* ENS reverts are intentionally one viewer-facing state */
    }
    setError("Can't resolve this name");
  };
  return (
    <form className="search" onSubmit={submit}>
      <label htmlFor="address">Open an address or ENS name</label>
      <div>
        <input
          id="address"
          name="address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="vitalik.eth or 0x…"
          autoComplete="off"
          spellCheck={false}
        />
        <button>Open inbox</button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function FollowButton({ owner, onChange }: { owner: string; onChange: () => void }) {
  const list = follows();
  const on = list.some((x) => x.toLowerCase() === owner.toLowerCase());
  const [message, setMessage] = useState('');
  if (!isLocalStateAvailable()) return null;
  const toggle = () => {
    if (on) {
      const rest = list.filter((x) => x.toLowerCase() !== owner.toLowerCase());
      safeStorage.set(followKey, JSON.stringify(rest));
    } else if (list.length >= MAX_FOLLOWS) {
      setMessage('You can follow up to 20 addresses');
      return;
    } else {
      safeStorage.set(followKey, JSON.stringify([...list, owner]));
    }
    onChange();
  };
  return (
    <div className="follow">
      <button
        className="secondary"
        aria-pressed={on}
        aria-label={`${on ? 'Unfollow' : 'Follow'} ${owner}`}
        onClick={toggle}
      >
        {on ? '★ Following' : '☆ Follow'}
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}

function Followed() {
  const list = follows();
  if (!isLocalStateAvailable() || !list.length) return null;
  return (
    <section className="followed">
      <h2>Followed addresses</h2>
      <ul>
        {list.map((a) => (
          <li key={a}>
            <a href={`#/a/${a}`}>{short(a)}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Inbox({ route: r }: { route: Extract<Route, { kind: 'inbox' | 'thread' }> }) {
  const wallet = useWallet();
  const [client] = useState(() => new BlockscoutClient(r.owner));
  const [, render] = useState(0);
  const redraw = useCallback(() => render((x) => x + 1), []);
  // Bumped when a thread is opened or accepted so thread flags recompute at once.
  const [readVersion, setReadVersion] = useState(0);

  useEffect(() => {
    client.onChange = redraw;
    void client.loadInitial().finally(redraw);
    return () => {
      client.onChange = undefined;
    };
  }, [client, redraw]);

  useEffect(() => {
    if (r.kind !== 'inbox') return;
    const tick = () => {
      if (document.visibilityState === 'visible') void client.refresh().finally(redraw);
    };
    const id = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [client, r.kind, redraw]);

  const transactions = client.state.transactions;
  const threads = useMemo(() => {
    void readVersion;
    return buildThreads(r.owner, transactions);
  }, [r.owner, transactions, readVersion]);
  const selected =
    r.kind === 'thread'
      ? threads.find((t) => t.counterparty.toLowerCase() === r.party.toLowerCase())
      : undefined;
  const openParty = selected?.counterparty;
  const openRequest = selected?.request ?? false;

  useEffect(() => {
    if (!openParty) return;
    openThread(r.owner, openParty);
    // Opening a request accepts it, which moves it to Inbox.
    if (openRequest) acceptRequest(r.owner, openParty);
    setReadVersion((v) => v + 1);
  }, [r.owner, openParty, openRequest]);

  const { loaded, loading, hasMore, historyLimit } = client.state;
  const busy = loading || !loaded;
  const devBoard = isDevBoard(r.owner);

  if (r.kind === 'thread' && !selected && loaded && !loading) {
    return (
      <>
        <DataState owner={r.owner} client={client} redraw={redraw} />
        <section className="empty">
          <h1>Not found</h1>
          <a href={`#/a/${r.owner}`}>Back to inbox</a>
        </section>
      </>
    );
  }

  const count = `${threads.length} thread${threads.length === 1 ? '' : 's'} loaded`;
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">PUBLIC ONCHAIN MESSAGES</p>
          <h1>{devBoard ? 'IMD dev board - read via IDM Inbox (independent)' : 'Inbox'}</h1>
          <p className="address" title={r.owner} translate="no">
            {r.owner}
          </p>
        </div>
        <div className="hero-actions">
          {devBoard && wallet.account && (
            <a className="button-link" href={`#/a/${wallet.account}`}>
              Open my inbox
            </a>
          )}
          <FollowButton owner={r.owner} onChange={redraw} />
          <button
            className="secondary"
            onClick={() => void client.refresh().finally(redraw)}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </section>
      {devBoard && (
        <>
          <Search />
          {r.kind === 'inbox' && <Followed />}
        </>
      )}
      <div aria-live="polite" className="status">
        {busy ? 'Loading messages…' : count}
      </div>
      <DataState owner={r.owner} client={client} redraw={redraw} />
      {selected ? (
        <ThreadView owner={r.owner} thread={selected} />
      ) : (
        r.kind === 'inbox' && <ThreadList owner={r.owner} threads={threads} loading={!loaded} />
      )}
      {r.kind === 'inbox' && hasMore && (
        <>
          <p className="limit">Showing the latest {transactions.length} transactions</p>
          {historyLimit ? (
            <p className="limit">History limit reached</p>
          ) : (
            <button
              className="older"
              onClick={() => void client.loadOlder().finally(redraw)}
              disabled={loading}
            >
              Load older
            </button>
          )}
        </>
      )}
      <Composer
        owner={r.owner as Address}
        counterparty={selected?.counterparty as Address | undefined}
        known={[...threads.map((t) => t.counterparty), ...follows()]}
      />
    </>
  );
}

export function DataState({
  owner,
  client,
  redraw,
}: {
  owner: string;
  client: BlockscoutClient;
  redraw: () => void;
}) {
  const retry = <button onClick={() => void client.retry().finally(redraw)}>Retry</button>;
  if (client.state.retryInMs) {
    return (
      <div className="notice" role="status">
        Rate-limited, retrying in {Math.ceil(client.state.retryInMs / 1000)}s
      </div>
    );
  }
  if (client.state.usingFallback) {
    return (
      <div className="notice" role="status">
        <span>Using backup data source</span>
        <span className="notice-actions">{retry}</span>
      </div>
    );
  }
  if (client.state.error) {
    return (
      <div className="notice" role="alert">
        <span>Data source unavailable</span>
        <span className="notice-actions">
          {retry}
          <a href={`${EXPLORER}/address/${owner}`} target="_blank" rel="noreferrer">
            Open on Etherscan
          </a>
        </span>
      </div>
    );
  }
  return null;
}

export function ThreadList({
  owner,
  threads,
  loading = false,
}: {
  owner: string;
  threads: Thread[];
  loading?: boolean;
}) {
  const [tab, setTab] = useState<'inbox' | 'requests'>('inbox');
  const shown = threads.filter((t) => (tab === 'requests' ? t.request : !t.request));
  let body;
  if (shown.length) {
    body = (
      <section className="list" aria-label="Message threads">
        {shown.map((t) => (
          <ThreadRow owner={owner} thread={t} key={t.counterparty} />
        ))}
      </section>
    );
  } else if (!loading) {
    // Until the first load settles the status line reads "Loading messages…" instead.
    body = (
      <section className="empty">
        <h2>No messages yet</h2>
      </section>
    );
  }
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Mailbox">
        <button role="tab" aria-selected={tab === 'inbox'} onClick={() => setTab('inbox')}>
          Inbox
        </button>
        <button role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>
          Requests
        </button>
      </div>
      {body}
    </>
  );
}

function ThreadRow({ owner, thread: t }: { owner: string; thread: Thread }) {
  return (
    <a className={`thread ${t.unread ? 'is-unread' : ''}`} href={`#/a/${owner}/${t.counterparty}`}>
      <span className="avatar" aria-hidden="true">
        {t.post ? 'P' : t.label.slice(0, 1).toUpperCase()}
      </span>
      <span className="thread-body">
        <span className="thread-top">
          <strong>{t.post ? 'Posts' : displayName(t.label, t.counterparty)}</strong>
          <time dateTime={t.newest.toISOString()}>{relative(t.newest)}</time>
        </span>
        <span className="preview">{t.messages.at(-1)?.text}</span>
        <span className="counts">
          {t.sent} sent · {t.received} received
        </span>
      </span>
      {t.unread && (
        <span className="new">
          <i aria-hidden="true" />
          New
        </span>
      )}
    </a>
  );
}

function displayName(label: string, address: string) {
  return label.toLowerCase() === address.toLowerCase() ? short(address) : `${label} · ${short(address)}`;
}

export function MessageBody({ message }: { message: Message }) {
  const [all, setAll] = useState(false);
  const long = message.text.length > MESSAGE_COLLAPSE_LENGTH;
  const url = /https?:\/\/\S+/i.test(message.text);
  const text = long && !all ? message.text.slice(0, MESSAGE_COLLAPSE_LENGTH) + '…' : message.text;
  return (
    <>
      <p>{text}</p>
      {long && (
        <button className="text-button" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
      {url && (
        <div className="link-warning">
          <button
            className="secondary copy"
            onClick={() => void navigator.clipboard?.writeText(message.text)}
          >
            Copy
          </button>
          <span>Links in messages may be scams.</span>
        </div>
      )}
    </>
  );
}

function ThreadView({ owner, thread }: { owner: string; thread: Thread }) {
  return (
    <section>
      <div className="thread-heading">
        <a href={`#/a/${owner}`}>← Inbox</a>
        <h2>{thread.post ? 'Posts' : displayName(thread.label, thread.counterparty)}</h2>
        <p>
          {thread.sent} sent · {thread.received} received
        </p>
      </div>
      <ol className="messages">
        {thread.messages.map((m) => (
          <li className={m.sent ? 'sent' : 'received'} key={m.tx.hash}>
            <div className="bubble">
              <MessageBody message={m} />
              {m.tags.length > 0 && <small>{m.tags.join(' · ')}</small>}
              <footer>
                <time dateTime={m.date.toISOString()}>{absolute(m.date)}</time>
                <a href={`${EXPLORER}/tx/${m.tx.hash}`} target="_blank" rel="noreferrer">
                  View tx
                </a>
                {m.tx.value !== '0' && <span>{formatEther(BigInt(m.tx.value))} ETH</span>}
              </footer>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <Tips />
      <p>
        Lookups go to eth.blockscout.com, api.routescan.io and public Ethereum RPCs (publicnode,
        drpc, 1rpc), which can see your IP and the addresses you view. Nothing else is sent anywhere.
      </p>
      <p>
        Hosted on IPFS via the IMD swarm's identitymd.eth name; IDM Inbox is independent of
        IdentityMD.
      </p>
    </footer>
  );
}
