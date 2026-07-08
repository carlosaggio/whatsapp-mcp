# WhatsApp MCP

Send WhatsApp messages **from your own personal number** by typing into your AI assistant — "tell Lior I'm running late" — and reading recent chats back as summaries. It links to your real WhatsApp as a companion device (like WhatsApp Web), so messages come from *you*, not a bot on a separate number.

It runs entirely locally on your Mac and is exposed as a standard **MCP server over stdio**, so any MCP client (Claude Desktop, Claude Code, …) can use it.

> ⚠️ **Honest heads-up.** This automates a personal WhatsApp account with an unofficial library ([Baileys](https://github.com/WhiskeySockets/Baileys)), which is against WhatsApp's Terms of Service and carries some risk of your number being flagged. This tool is deliberately built for **gentle, low-volume, personal use** and keeps a human in the loop for every send. Don't use it for bulk or outbound-to-strangers messaging. You're accepting this risk knowingly.

---

## What it does

- **Send text** to a contact or group by name — after you confirm the exact recipient and text.
- **Send a photo or file** from your Mac to a contact/group — after you confirm.
- **Read & summarize** recent messages from a chat. Read-only; never sends.
- **Confirm-before-send is enforced by the server**, not just by the assistant: sending is structurally impossible without a previewed, single-use draft that you approved.
- Safety guardrails: a human-like delay before each send, per-minute/day rate caps, contacts-only resolution (extra confirmation for unknown numbers), a local send log, and a pause switch.

## The two pieces

1. **The gateway** (`npm start`) — a small always-on process that holds the WhatsApp connection, records recent messages, and enforces the guardrails. You start it once and leave it running.
2. **The MCP adapter** — a thin stdio server your MCP client launches automatically. It talks to the gateway over a local, token-protected `127.0.0.1` API.

You keep the gateway running; the assistant talks to it through the adapter.

---

## 1. Requirements

- macOS, **Node.js 20+** (developed on Node 22).
- Your phone with WhatsApp, to scan a QR once.

## 2. Install & build

```bash
git clone <this-repo> whatsapp-mcp
cd whatsapp-mcp
npm install
npm run build
```

## 3. Link your WhatsApp (once)

In a terminal:

```bash
npm start
```

A **QR code** appears. On your phone: **WhatsApp → Settings → Linked Devices → Link a device**, and scan it. You'll see:

```
✅ Connected as +9725........ . Session saved — no re-link needed after a restart.
```

Leave this terminal running — it's the gateway. The session is saved under `~/.whatsapp-mcp`, so restarting the gateway later does **not** require re-linking.

> Prefer a **pairing code** instead of a QR? Start with `WHATSAPP_MCP_PAIR_NUMBER=<your number, digits only>` set, e.g. `WHATSAPP_MCP_PAIR_NUMBER=15551234567 npm start`, then use *"Link with phone number instead"* on your phone.

## 4. Connect it to your MCP client

The gateway must be running (step 3) for the tools to work.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if missing):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/whatsapp-mcp/dist/mcp/index.js"]
    }
  }
}
```

Use the **absolute** path to `dist/mcp/index.js`. If Claude Desktop can't find `node`, replace `"node"` with the absolute path from `which node`. Restart Claude Desktop.

### Claude Code

```bash
claude mcp add whatsapp -- node /ABSOLUTE/PATH/TO/whatsapp-mcp/dist/mcp/index.js
```

> The adapter finds the gateway automatically (default `127.0.0.1:8787`, data in `~/.whatsapp-mcp`). Only if you override `WHATSAPP_MCP_PORT` or `WHATSAPP_MCP_DATA_DIR` for the gateway, set the **same** values in an `"env": { … }` block here.

## 5. Use it

Just talk to your assistant. It will always show you a preview and wait for your "yes" before anything is sent.

| You say | What happens |
|---|---|
| *"Tell Lior I'm running late."* | Finds contact **Lior**, shows you the number + text → you confirm → sent. |
| *"Tell the soccer group practice is cancelled."* | Finds the **group** by name, shows subject + size → you confirm → sent. |
| *"Send this photo to my wife: /Users/me/pics/beach.jpg"* | Attaches the image → you confirm → sent. |
| *"Any new messages from Lior?"* / *"What did the soccer group say today?"* | Reads recent messages and summarizes. Nothing is sent. |

A typical confirm flow looks like:

> **You:** tell Dana I'll be 10 minutes late
> **Assistant:** Here's the draft — **To:** Dana (+972‑50‑xxx‑xxxx), **Message:** "I'll be 10 minutes late". Send it?
> **You:** yes
> **Assistant:** ✅ Sent to Dana.

If a name is **ambiguous** ("Lior" matches two people), it shows the matches and asks which one. If **nobody matches**, it tells you and stops — it never guesses. Messaging a **number that isn't a saved contact** requires an extra explicit confirmation.

---

## Status, pause, stop

From the project directory (thin CLIs that talk to the running gateway):

```bash
npm run status    # connection state, linked number, today's send count, cache sizes
npm run pause     # block all outgoing sends (reading still works)
npm run resume    # re-enable sending
npm run link      # re-show the QR / pairing code (e.g. after a logout)
npm run stop      # shut the gateway down
```

You can also ask the assistant: *"what's your WhatsApp status?"*, *"pause WhatsApp sending"*, *"resume."* To fully stop the gateway, `npm run stop` or `Ctrl‑C` in its terminal.

## Safety guardrails & how to tune them

All defaults live in one place — [`src/config.ts`](src/config.ts) — and each can also be set via an environment variable:

| Setting | Default | Env var |
|---|---|---|
| Randomized delay before each send | 3–12 s | `WHATSAPP_MCP_SEND_DELAY_MIN_MS` / `_MAX_MS` |
| Max sends per minute | 5 | `WHATSAPP_MCP_MAX_PER_MINUTE` |
| Max sends per day | 100 | `WHATSAPP_MCP_MAX_PER_DAY` |
| Draft validity window | 10 min | `WHATSAPP_MCP_DRAFT_TTL_MS` |
| Recent messages kept per chat | 200 | (edit `config.ts`) |

After editing `config.ts`, run `npm run build` and restart the gateway.

## Data & privacy

Everything is local, under `~/.whatsapp-mcp/`:

- `auth/` — your linked-device session (treat like a password).
- `store.db` — cached contacts, groups, recent messages, and your **send log** (`sent_log` table).
- `control-token` — the local API secret.

**To unlink / reset:** stop the gateway, delete `~/.whatsapp-mcp/auth`, and `npm start` again to re-link. To wipe everything, delete the whole `~/.whatsapp-mcp/` folder. Nothing is ever sent anywhere except to WhatsApp when you confirm a send.

## Optional: start automatically at login (launchd)

By default you start the gateway yourself. If you'd rather it run in the background at login, create `~/Library/LaunchAgents/com.you.whatsapp-mcp.plist` (replace the paths):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.you.whatsapp-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>/ABSOLUTE/PATH/TO/whatsapp-mcp/dist/daemon/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/whatsapp-mcp.log</string>
  <key>StandardErrorPath</key><string>/tmp/whatsapp-mcp.err</string>
</dict></plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.you.whatsapp-mcp.plist`. Do your first `npm start` link interactively before enabling this, since the QR needs a terminal. Unload with `launchctl unload …`.

## Troubleshooting

- **Assistant says it can't reach the gateway** → start it: `npm start`. The tools need the gateway running.
- **Stuck "waiting to be linked"** → run `npm run link` to re-show the QR, or check the gateway terminal.
- **"logged out — re-link required"** → WhatsApp dropped the device. The gateway clears the old session and shows a fresh QR automatically; just scan again.
- **Two clients** (Desktop + Code) can share the one gateway safely — only the gateway connects to WhatsApp, so there's no double-login conflict.
- **Nothing to read yet** → the gateway only records messages it receives *while running*. Leave it on to build up recent history.

## How it works (for the curious)

- **Baileys** speaks WhatsApp's multi-device protocol directly (no browser). The gateway owns a single socket, persists the session with `useMultiFileAuthState`, and builds a local store from live events.
- **Confirm-before-send:** `prepare_message` resolves the recipient and writes a draft (bound to the exact recipient + content, single-use, ~10 min expiry) and returns a preview. `send_message` accepts **only** that draft id — so it can't send un-previewed or altered content, and can't send at all without an approved draft.
- The MCP adapter is stdio-only and never logs to stdout (reserved for JSON-RPC); the gateway does all WhatsApp work behind the local control API.

## Not in v1

Scheduled/delayed sending, auto-replies or always-on notifications, broadcasts/bulk/mailing-list sending, and any web UI or hosting. Send-now, one recipient at a time, local only.
