# IDM Inbox

IDM Inbox is a static, independent reader for Ethereum mainnet input-data messages. The home page
pins the IMD dev board and any address or ENS name can be opened as an email-style inbox.

The production page supports searching, following and reading threads, plus EIP-6963 browser-wallet
message/reply transactions and optional builder tips.

## Run locally

Requirements: Node.js 20+ and npm.

```sh
npm ci
npm run dev
```

Open the URL Vite prints. To inspect the exact production export:

```sh
npm run build
npm run preview
```

`dist/` is committed and can be published directly to IPFS or any static host (for example, add the
`dist/` directory to IPFS and publish its CID). Vite uses `base: './'`, hash routes, and relative
built assets, so an HTTP rewrite is unnecessary.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run ci
```

Tests are fully offline. `npm run ci` runs lint, Vitest, the TypeScript production build and the
compressed asset-size report.

## Refresh the fixture

```sh
npm run fixture
```

This command fetches up to four current Blockscout v2 pages for the dev board and writes
`fixtures/dev-board.json`. It is a development command only; builds and tests never fetch it. The
committed fixture was fetched live on 2026-09-25 and has `live: true`.

## Data sources and limits

- Blockscout v2 is primary: 50 transactions per page, four pages initially and four more per “Load
  older” action.
- After two qualifying Blockscout failures, the Routescan Etherscan-compatible `txlist` endpoint is
  used in descending pages of 1,000.
- History is capped at 10,000 transactions. Refresh checks at most four Blockscout pages and marks a
  response partial if none meets the cache.
- Public Ethereum RPCs from publicnode, drpc and 1rpc resolve ENS names. These services can see the
  viewer's IP and queried address.
- A connected wallet sends message data and tips directly. Message text is UTF-8 calldata, tips are
  plain ETH transfers, and every send requires Ethereum mainnet.
- ETH/USD comes from Chainlink and falls back to Blockscout's stats endpoint. Unavailable prices
  disable USD presets but not custom ETH.
- The browser keeps follows, unread baselines, opened threads and accepted requests in local
  storage. It disables local state on shared `/ipfs/` and `/ipns/` gateway paths or when storage
  fails. There is no server, analytics, cookie or external script/font.

An IDM is a successful transaction with at least one input byte that strictly decodes as UTF-8, has
no disallowed control characters and contains at least two Unicode letters. Value may be non-zero.
Display removes bidi and zero-width controls and labels that removal.

All endpoints, addresses, RPCs, paging limits and intervals live in `src/config.ts`; edit that one
file to change them.

## Interaction fixes (Step B)

- Inbox/Requests tabs accept ArrowLeft and ArrowRight and keep one tab in the Tab sequence.
- Multiple EIP-6963 announcements open a wallet picker showing each wallet's name.
- Wallet chain changes invalidate the fee, recheck recipient code, and clear the lookalike
  confirmation. Disconnecting all accounts returns to Connect wallet.
- Message fee estimation waits 500 ms after typing stops and ignores obsolete responses.
  Composer and tips share one ETH-price request per 60 seconds, including failed attempts.
- Tips over 1 ETH require confirmation; Escape cancels and restores the opening button's focus.
  Without a price, custom confirmation explicitly says “USD price unavailable”.
- Pending transactions require both 30 minutes and two block-distinct missing polls before
  showing “Dropped or replaced - check your wallet”. Receipts change the status to Sent.
- Message Copy buttons copy individual URL_RE matches, including http, https and www forms.

## Step B validation record

Run on 2026-09-25. The original job objective was retrieved directly from
[the job API](https://api.imd.fun/jobs/936d49d1-4552-436a-91f2-9348bdfe9d8a).
The existing Step A work and fixture-backed home test were preserved; fixture refresh was not run.

- Dependency installation: `npm ci --cache /tmp/idm-npm-cache` passed. The default npm cache
  path was unwritable. No dependency was added; package.json and package-lock.json are unchanged.
- `npm run ci` passed: zero-warning ESLint; 13 test files / 83 tests; TypeScript
  `tsc --noEmit`; Vite production build; gzip-size report of 162.49 KB for dist/assets.
- `npm run preview -- --host 127.0.0.1 --port 4173` served the export on port 4174 because
  4173 was occupied. HTTP checks returned 200 for index and both entry assets, matching
  their on-disk bytes. This was a static serving check, not a browser rendering check.
- `git diff --check` passed. Changed/new paths are restricted to src/, dist/ and README.md.
  The complete submitted file set is under 1.11 MB uncompressed, below the 8 MiB budget.
- Tests use browser-like fetch receiver checks, explicit wallet events, deferred replies,
  fake timers, and fireEvent keyboard events. Focus order is checked in the DOM without
  positive tabindex. CSS assertions cover both dialogs' available width at 360 px.
- The production export uses relative asset URLs; CSP remains the first child of head.
  Runtime code imports no fixtures. No dependency cache or registry archive is submitted.

Frontend review used the
[Vercel Web Interface
Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md),
retrieved 2026-09-25. Reviewed App.tsx, Composer.tsx, Tips.tsx, wallet.tsx,
useDialogFocus.ts, styles.css, review.css and ui.css under src/.

- `src/App.tsx:419`: fixed arrow-key focus and selection with a single tabbable mailbox tab.
- `src/useDialogFocus.ts:3`, `src/Tips.tsx:37`: both dialogs trap keyboard focus, support Escape,
  and restore focus; the tip opener is captured before asynchronous price work.
- `src/ui.css:81`, `src/ui.css:283`, `src/ui.css:334`: URL actions wrap; dialogs have bounded
  width/height, internal scrolling, overscroll containment, and wrapping for long wallet names.
- `src/Composer.tsx:197`, `src/Tips.tsx:149`: labelled form fields now have names and explicit
  autocomplete metadata. Existing visible focus, 44 px buttons, reduced motion, dark mode,
  text-only untrusted messages, and polite transaction announcements were retained.
- Existing UI copy and transaction safety gates take precedence over general guideline advice
  about wording and keeping submit controls enabled. No unrelated navigation behavior changed.

Limitations: no browser executable or browser automation tool was available. Real Chromium
rendering, mobile/desktop screenshots, visual overflow, browser console/resource inspection,
and extension-wallet confirmation were not checked. jsdom interaction tests and CSS rules
provide regression coverage but do not establish real-browser layout or extension behavior.

## License

MIT
