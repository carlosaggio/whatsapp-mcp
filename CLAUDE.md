# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user MCP server that sends WhatsApp messages **from the user's own personal number** (via the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library) and reads recent chats. Everything runs locally on one Mac. The defining constraint is **safety**: it links a real WhatsApp account, so a ban would hurt — the confirm-before-send rule and the rate/delay guardrails are load-bearing, not decorative. Do not add anything that increases volume or messages non-contacts in bulk.

## Commands

```bash
npm install          # better-sqlite3 is native; installs via prebuilt binary
npm run build        # tsc -> dist/  (run after ANY src change; start/mcp run dist/)
npm start            # run the gateway daemon (foreground; shows QR on first link)
npm run dev          # gateway via tsx watch (no build step, for iteration)
npm run mcp:dev      # MCP stdio adapter via tsx (what an MCP client would spawn)
npm run status|pause|resume|stop|link   # thin CLIs that hit the running daemon
```

There is **no lint step and no test framework**. Verification is done by running the system: build, start the daemon, then drive the control API with `curl` (see below) or connect an MCP client to `dist/mcp/index.js`. When changing sender/guardrail logic, exercise it against a mock socket (`{ isConnected, sendContent, checkOnWhatsApp }`) so you can test the full prepare→send handshake without a live WhatsApp connection; set `WHATSAPP_MCP_SEND_DELAY_MIN_MS=0 WHATSAPP_MCP_SEND_DELAY_MAX_MS=0` to skip the human-paced delay in tests.

## Architecture (the big picture)

**Two processes, not one.** A stdio MCP server is spawned/killed by its client, but the WhatsApp connection must outlive any client session (to stay linked, capture incoming messages, and let multiple clients share one login). So:

1. **Gateway daemon** (`src/daemon/*`, entry `daemon/index.ts`, run via `npm start`) — owns the single Baileys socket, persists the session, builds a local SQLite store from live events, enforces every guardrail, and exposes a **local HTTP control API on `127.0.0.1:8787`** guarded by a token. This is a long-running background process the user starts once.
2. **MCP stdio adapter** (`src/mcp/index.ts`) — a thin server the MCP client launches. Its tool handlers just `fetch` the daemon's control API via `src/control-client.ts`. It does **no** WhatsApp work itself.

The two agree on location/port with zero config because `config.ts` derives everything from a fixed default data dir (`~/.whatsapp-mcp`, not `./data`) rather than `process.cwd()` — the adapter is spawned from an arbitrary cwd. The CLIs in `src/cli/*` are also thin control-API clients.

**Confirm-before-send is enforced server-side, in the daemon — never weaken this.** It is a two-step handshake in `src/daemon/sender.ts`:
- `prepareMessage` resolves the recipient and writes a **draft** row (content-bound hash, `requiresExtraConfirmation` flag, ~10-min expiry) and returns a preview + `draftId`. Sends nothing.
- `sendMessage` accepts **only a `draftId`**. It refuses unless the draft exists, is unexpired, and unconsumed; atomically claims it (single-use) *before* the delay; then applies the randomized delay + rate-limit checks and sends exactly the stored content. Unknown (non-contact) recipients additionally require `confirmUnknownRecipient: true`.
This makes `send` structurally incapable of firing without an approved, unaltered draft. The MCP tool descriptions also instruct the assistant to show the preview and get a "yes" — but the guarantee lives in the daemon.

**The store is event-sourced** (`src/daemon/store.ts`, better-sqlite3). Baileys has no built-in store anymore, so `whatsapp.ts` subscribes to events (`messaging-history.set`, `contacts.*`, `chats.*`, `messages.upsert`, `groups.*`) and writes contacts/groups/messages/drafts/sent_log. Reads (`reader.ts`) and name resolution (`resolver.ts`) query this store; sending queries the live socket.

## Baileys gotchas (hard-won — read before touching `whatsapp.ts`)

- **Pinned to `@whiskeysockets/baileys@6.7.23`** (the `legacy` stable tag). npm `latest` is a v7 release candidate — do not bump casually.
- **Contacts only sync on a FRESH link.** The address book arrives inside WhatsApp's history-sync payload, which Baileys ignores unless `shouldSyncHistoryMessage` returns true (its default is gated behind `syncFullHistory`). We pass `shouldSyncHistoryMessage: () => true`. A *reconnect* does not re-fetch it — only a fresh QR link does. If a user reports 0 contacts, they linked before this was set and must unlink + re-link once.
- **`syncFullHistory: true` breaks the connection** on some accounts (a `428` reconnect loop, *before* `open`). It is off by default and exposed via `WHATSAPP_MCP_SYNC_FULL_HISTORY` for anyone who wants the full backfill. Do not turn it on by default.
- **LID addressing:** WhatsApp emits redundant `@lid` (Local Identifier) aliases for contacts. We keep only `@s.whatsapp.net` (phone) contacts — the real address book comes through with saved names on those; `@lid` entries aren't reliably sendable on 6.7.23 and are skipped.
- **App-state contact sync (`resyncAppState`) fails with "bad decrypt"** on some accounts — a dead end. The history-sync path above is the working source of contacts; don't reintroduce forced app-state resyncs.
- Reconnect uses **exponential backoff + jitter** (2s→60s). Never revert to a fixed short retry — hammering the socket is a ban risk. Reconnect on all close codes except `loggedOut`(401)/`forbidden`(403) (→ clear session, re-link) and `connectionReplaced`(440) (→ stop, don't fight the other session).

## Conventions & pitfalls

- **ESM + `Node16` module resolution.** Every local import MUST use a `.js` extension (e.g. `import { config } from '../config.js'`), even though the source is `.ts`.
- **stdout discipline in the MCP adapter.** `src/mcp/index.ts` speaks JSON-RPC over stdout — it must **never** `console.log`. Use `console.error`. The daemon is exempt (its stdout is the user's terminal); it logs via pino to **stderr** and prints the QR to its terminal.
- **All tunables live in `src/config.ts`** (delays, rate caps, draft TTL, retention, port, data paths), each overridable by a `WHATSAPP_MCP_*` env var. Change guardrail defaults there, in one place.
- Runtime data (`~/.whatsapp-mcp/`: `auth/`, `store.db`, `control-token`) is outside the repo and git-ignored. Treat `auth/` like a password.

## Control API (for manual verification)

```bash
TOKEN=$(cat ~/.whatsapp-mcp/control-token); BASE=http://127.0.0.1:8787
curl -s $BASE/health                                            # no token needed
curl -s -H "x-control-token: $TOKEN" $BASE/status | python3 -m json.tool
curl -s -H "x-control-token: $TOKEN" -d '{"to":"<name>","message":"hi"}' $BASE/prepare
curl -s -H "x-control-token: $TOKEN" -d '{"draftId":"<id>"}' $BASE/send
```

Endpoints: `GET /health`, `GET /status`, `GET /qr`, `POST /prepare|/send|/read|/pause|/resume|/shutdown`. See `README.md` for the end-user setup (linking, MCP client config, guardrail tuning).
