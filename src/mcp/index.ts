import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { daemon, DaemonUnavailableError } from '../control-client.js';

// IMPORTANT: this process speaks JSON-RPC over stdout. NEVER write to stdout
// (no console.log). Diagnostics go to stderr only.

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}
function errorResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true };
}
function errMsg(e: unknown): string {
  if (e instanceof DaemonUnavailableError) return `⚠️ ${e.message}`;
  return `⚠️ ${e instanceof Error ? e.message : String(e)}`;
}

interface Candidate {
  jid: string;
  kind: string;
  name: string;
  number?: string;
  participantCount?: number;
}

function formatCandidates(candidates: Candidate[]): string {
  const lines = candidates.map((c, i) => {
    const detail =
      c.kind === 'group'
        ? `group${c.participantCount != null ? `, ~${c.participantCount} members` : ''}`
        : c.number ?? 'contact';
    return `${i + 1}. ${c.name} — ${detail}\n   recipientJid: ${c.jid}`;
  });
  return [
    '🤔 That name matches more than one chat. Ask the user which one — do NOT guess:',
    '',
    ...lines,
    '',
    'Once they choose, call this tool again with `recipientJid` set to the chosen jid (and the same message/filePath).',
  ].join('\n');
}

function formatStatus(s: Record<string, unknown>): string {
  const me = s.me as { number?: string; name?: string } | null;
  const counts = s.counts as { contacts: number; groups: number; messages: number };
  const limits = s.limits as { perMinute: number; perDay: number };
  const stateLabels: Record<string, string> = {
    starting: '⏳ starting',
    connecting: '⏳ connecting',
    waiting_qr: '📱 waiting to be linked (scan the QR in the gateway terminal, or run `npm run link`)',
    connected: '✅ connected',
    disconnected: '🔌 disconnected (reconnecting)',
    logged_out: '⚠️ logged out — re-link required',
  };
  const lines = [
    `State: ${stateLabels[s.state as string] ?? s.state}`,
    me ? `Linked number: ${me.number}${me.name ? ` (${me.name})` : ''}` : 'Linked number: (not linked yet)',
    `Sending: ${s.paused ? '⏸ PAUSED' : 'active'}`,
    `Sent: ${s.sentLastMinute} in last minute, ${s.sentToday} today (limits: ${limits.perMinute}/min, ${limits.perDay}/day)`,
    `Local store: ${counts.contacts} contacts, ${counts.groups} groups, ${counts.messages} recent messages`,
  ];
  const health = s.syncHealth as {
    lastMessageAt?: number | null;
    websocketOpen?: boolean;
    stale?: boolean;
  } | undefined;
  if (health) {
    const parts: string[] = [];
    if (health.lastMessageAt) {
      parts.push(`last message ${new Date(health.lastMessageAt).toLocaleString()}`);
    }
    parts.push(`websocket ${health.websocketOpen ? 'open' : 'closed'}`);
    if (health.stale) parts.push('SYNC STALE: gateway may not be receiving messages');
    lines.push(`Sync: ${parts.join('; ')}`);
  }
  if (s.pairingCode) lines.push(`Pairing code: ${s.pairingCode}`);
  return lines.join('\n');
}

function formatPrepared(r: Record<string, unknown>): string {
  const draftId = r.draftId as string;
  const extra = r.requiresExtraConfirmation as boolean;
  const expiresAt = r.expiresAt as number;
  const lines = [
    '📝 Draft prepared — NOTHING has been sent yet.',
    '',
    r.preview as string,
    '',
    `Draft ID: ${draftId}`,
    '⚠️ Show the recipient and message above to the user and get an explicit "yes".',
  ];
  if (extra) {
    lines.push(
      '⚠️ This recipient is NOT a saved contact (higher risk). After the user confirms, call send_message with',
      `   draftId "${draftId}" AND confirmUnknownRecipient: true.`,
    );
  } else {
    lines.push(`Then call send_message with draftId "${draftId}".`);
  }
  lines.push(`(This draft expires at ${new Date(expiresAt).toLocaleString()}.)`);
  return lines.join('\n');
}

function formatRead(r: Record<string, unknown>): string {
  const chat = r.chat as { name: string; jid: string; kind: string };
  const messages = r.messages as { from: string; iso: string; text: string }[];
  const header = `🗨️ Recent messages — ${chat.name} (${chat.kind})`;
  if (messages.length === 0) {
    return `${header}\n\n${(r.note as string) ?? 'No recent messages.'}\n\n(Read-only — nothing was sent.)`;
  }
  const body = messages
    .map((m) => `[${new Date(m.iso).toLocaleString()}] ${m.from}: ${m.text}`)
    .join('\n');
  return `${header}\n\n${body}\n\n(Read-only — nothing was sent. Summarize these for the user.)`;
}

const server = new McpServer({ name: 'whatsapp-mcp', version: '1.0.0' });

server.registerTool(
  'whatsapp_status',
  {
    title: 'WhatsApp status',
    description:
      "Check the WhatsApp gateway's status: whether it is connected (and as which number), whether sending is paused, today's send count, and how many contacts/groups/messages are cached locally. Read-only. Use to answer 'are you connected to WhatsApp?' or before sending if unsure of state.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return text(formatStatus(await daemon.status()));
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

server.registerTool(
  'prepare_message',
  {
    title: 'Prepare a WhatsApp message (step 1 of 2)',
    description:
      'STEP 1 OF 2 FOR SENDING. Resolve the intended recipient and build a draft WhatsApp message WITHOUT sending it. Returns a preview with the EXACT recipient (real phone number, or group name + size) and the exact text/attachment, plus a draftId. You MUST show this preview to the user and get an explicit "yes" before calling send_message. If the name matches more than one contact/group, this returns candidates — ask the user which one, then call prepare_message again with the chosen `recipientJid`. If nobody matches, it says so — never guess. Provide `message` for text and/or `filePath` (an ABSOLUTE path on this machine) to attach a photo/document. Never call send_message without a draftId from this tool.',
    inputSchema: {
      to: z
        .string()
        .optional()
        .describe('Contact or group name, or a phone number. Omit if using recipientJid.'),
      kind: z
        .enum(['contact', 'group', 'auto'])
        .optional()
        .describe("Restrict resolution to a 'contact' or 'group'. Default 'auto' searches both."),
      recipientJid: z
        .string()
        .optional()
        .describe('Exact WhatsApp JID to skip fuzzy matching (use the jid from a prior ambiguous result).'),
      message: z.string().optional().describe('The message text (or the caption when attaching a file).'),
      filePath: z
        .string()
        .optional()
        .describe('Absolute path to a local image/video/audio/document to attach.'),
      caption: z.string().optional().describe('Optional caption for an attachment (overrides message as caption).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const r = await daemon.prepare(args);
      switch (r.status) {
        case 'prepared':
          return text(formatPrepared(r));
        case 'ambiguous':
          return text(formatCandidates(r.candidates as Candidate[]));
        case 'not_found':
          return text(
            `🔍 Couldn't find who you mean: ${r.message as string}\nTell the user plainly and ask them to clarify. Do not guess or send.`,
          );
        default:
          return errorResult(r.message as string);
      }
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

server.registerTool(
  'send_message',
  {
    title: 'Send the prepared WhatsApp message (step 2 of 2)',
    description:
      "STEP 2 OF 2. Actually send a WhatsApp message from the user's own number. Requires a `draftId` from a prior prepare_message in this same flow, AFTER the user has explicitly confirmed the previewed recipient and text. The gateway refuses to send without a valid, unexpired, single-use draft, and applies a human-like delay plus rate limits. If the recipient is a raw number that is not a saved contact, the first call is refused — only retry with confirmUnknownRecipient:true after the user explicitly confirms messaging a non-contact. Never invent a draftId; never send without showing the preview and getting a yes.",
    inputSchema: {
      draftId: z.string().describe('The draftId returned by prepare_message.'),
      confirmUnknownRecipient: z
        .boolean()
        .optional()
        .describe('Set true ONLY after the user confirms messaging a recipient that is not a saved contact.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const r = await daemon.send(args);
      if (r.ok) {
        const ts = r.ts as number;
        return text(
          `✅ Sent to ${r.to as string} at ${new Date(ts).toLocaleString()}.\nSummary: ${(r.summary as string) || '(attachment)'}\nRecorded in the local send log.`,
        );
      }
      return errorResult(`🚫 Not sent (${r.reason as string}): ${r.message as string}`);
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

server.registerTool(
  'read_messages',
  {
    title: 'Read recent WhatsApp messages',
    description:
      'READ-ONLY — never sends anything. Read recent messages from ONE WhatsApp chat (a contact or a group) so you can summarize them. Identify the chat by `chat` (a contact/group name) or an exact `recipientJid`. Use `today:true` to limit to today, or `limit` for the last N messages (default 20). If the name is ambiguous, it returns candidates to disambiguate. Only messages received while the gateway was running and connected are available.',
    inputSchema: {
      chat: z.string().optional().describe('Contact or group name. Omit if using recipientJid.'),
      kind: z.enum(['contact', 'group', 'auto']).optional().describe("Restrict to 'contact' or 'group'. Default 'auto'."),
      recipientJid: z.string().optional().describe('Exact WhatsApp JID to skip fuzzy matching.'),
      limit: z.number().int().min(1).max(200).optional().describe('How many recent messages (default 20).'),
      today: z.boolean().optional().describe('If true, only messages from today (local time).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const r = await daemon.read(args);
      switch (r.status) {
        case 'ok':
          return text(formatRead(r));
        case 'ambiguous':
          return text(formatCandidates(r.candidates as Candidate[]));
        default:
          return text(`🔍 ${r.message as string}`);
      }
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

server.registerTool(
  'pause_sending',
  {
    title: 'Pause sending',
    description:
      'Safety switch: pause ALL outgoing WhatsApp sends. While paused, send_message is refused. Reading is unaffected. Use when the user wants to stop it from sending.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async () => {
    try {
      await daemon.pause();
      return text('⏸ Sending is now PAUSED. send_message will be refused until you resume.');
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

server.registerTool(
  'resume_sending',
  {
    title: 'Resume sending',
    description: 'Re-enable outgoing WhatsApp sends after pause_sending. Sending still requires the normal confirm-before-send flow.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async () => {
    try {
      await daemon.resume();
      return text('▶️ Sending resumed. The usual prepare → confirm → send flow still applies.');
    } catch (e) {
      return errorResult(errMsg(e));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('whatsapp-mcp adapter running on stdio');
}

main().catch((e) => {
  console.error('Fatal error in whatsapp-mcp adapter:', e);
  process.exit(1);
});
