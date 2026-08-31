import { isJidGroup, isLidUser, jidNormalizedUser } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import type { Candidate } from '../types.js';
import { jidToNumber, startOfTodayMs } from '../util.js';
import { resolveByName } from './resolver.js';
import type { Store } from './store.js';

export interface ReadInput {
  chat?: string;
  kind?: 'contact' | 'group' | 'auto';
  recipientJid?: string;
  limit?: number;
  today?: boolean;
}

export interface ReadMessage {
  from: string;
  fromMe: boolean;
  ts: number;
  iso: string;
  type: string | null;
  text: string;
}

export type ReadResult =
  | { status: 'ok'; chat: { name: string; jid: string; kind: string }; messages: ReadMessage[]; note?: string }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'not_found'; message: string };

function senderName(store: Store, sender: string | null, chatName: string, kind: string): string {
  if (!sender) return chatName;
  if (kind === 'group') {
    const c = store.getContact(sender);
    return c?.name ?? c?.notify ?? jidToNumber(sender);
  }
  return chatName;
}

/** READ-ONLY. Returns recent messages for one chat so the assistant can summarize. Never sends. */
export function readMessages(store: Store, input: ReadInput): ReadResult {
  let jid: string;
  let name: string;
  let kind: string;

  if (input.recipientJid) {
    const raw = input.recipientJid.trim();
    if (isJidGroup(raw)) {
      jid = raw;
      kind = 'group';
      name = store.getGroup(jid)?.subject ?? jid;
    } else if (isLidUser(raw)) {
      jid = raw;
      kind = 'contact';
      const c = store.getContact(jid);
      name = c?.name ?? c?.notify ?? `LID ${jidToNumber(jid)}`;
    } else {
      jid = jidNormalizedUser(raw);
      kind = 'contact';
      const c = store.getContact(jid);
      name = c?.name ?? c?.notify ?? jidToNumber(jid);
    }
  } else {
    const query = (input.chat ?? '').trim();
    if (!query) {
      return { status: 'not_found', message: 'No chat given. Provide `chat` (a contact/group name) or `recipientJid`.' };
    }
    const r = resolveByName(store, query, input.kind ?? 'auto');
    if (r.status === 'ambiguous') return { status: 'ambiguous', candidates: r.candidates };
    if (r.status === 'not_found') return { status: 'not_found', message: r.message };
    jid = r.recipient.jid;
    name = r.recipient.name;
    kind = r.recipient.kind;
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), config.maxMessagesPerChat);
  const since = input.today ? startOfTodayMs() : undefined;
  const rows = store.recentMessages(jid, limit, since);

  const messages: ReadMessage[] = rows.map((row) => ({
    from: row.from_me ? 'You' : senderName(store, row.sender, name, kind),
    fromMe: !!row.from_me,
    ts: row.ts,
    iso: new Date(row.ts).toISOString(),
    type: row.type,
    text: row.text && row.text.length ? row.text : row.type ? `[${row.type.replace('Message', '')}]` : '',
  }));

  const note =
    messages.length === 0
      ? 'No recent messages captured for this chat yet. The gateway only records messages received while it is running and connected.'
      : undefined;

  return { status: 'ok', chat: { name, jid, kind }, messages, note };
}
