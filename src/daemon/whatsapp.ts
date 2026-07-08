import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type AnyMessageContent,
  type AuthenticationState,
} from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { baileysLogger, log } from '../logger.js';
import type { Store } from './store.js';
import type { ConnectionState, MeInfo, StatusInfo } from '../types.js';
import { digitsOf, jidToNumber, startOfTodayMs, timestampToMs } from '../util.js';

type Sock = ReturnType<typeof makeWASocket>;

/**
 * Owns the single Baileys socket. Emits: 'qr'(string), 'pairing'(string),
 * 'connected'(MeInfo|null), 'disconnected', 'logged_out', 'state'(ConnectionState).
 */
export class WhatsApp extends EventEmitter {
  private sock: Sock | null = null;
  private authState: AuthenticationState | null = null;
  private saveCreds: (() => Promise<void>) | null = null;

  private state: ConnectionState = 'starting';
  private me: MeInfo | null = null;
  private qr: string | null = null;
  private pairingCode: string | null = null;
  private pairRequested = false;
  private stopping = false;

  constructor(private store: Store) {
    super();
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    this.authState = state;
    this.saveCreds = saveCreds;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.authState) throw new Error('auth state not loaded');
    let version: [number, number, number] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    this.setState('connecting');
    const sock = makeWASocket({
      version,
      auth: {
        creds: this.authState.creds,
        keys: makeCacheableSignalKeyStore(this.authState.keys, baileysLogger),
      },
      logger: baileysLogger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void this.saveCreds?.();
    });
    sock.ev.on('connection.update', (u) => {
      void this.onConnectionUpdate(u);
    });
    sock.ev.on('messaging-history.set', (h) => this.onHistorySet(h));
    sock.ev.on('contacts.upsert', (cs) => this.onContacts(cs));
    sock.ev.on('contacts.update', (cs) => this.onContacts(cs));
    sock.ev.on('groups.upsert', (gs) => this.onGroups(gs));
    sock.ev.on('groups.update', (gs) => this.onGroups(gs));
    sock.ev.on('messages.upsert', (m) => this.onMessagesUpsert(m));
  }

  private async onConnectionUpdate(u: {
    connection?: string;
    lastDisconnect?: { error?: unknown } | undefined;
    qr?: string;
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.qr = qr;
      const registered = this.sock?.authState.creds.registered;
      if (config.pairNumber && !registered && !this.pairRequested && this.sock) {
        this.pairRequested = true;
        try {
          const code = await this.sock.requestPairingCode(config.pairNumber);
          this.pairingCode = code;
          this.setState('waiting_qr');
          this.emit('pairing', code);
        } catch (e) {
          log.error({ err: String(e) }, 'requestPairingCode failed; falling back to QR');
          this.setState('waiting_qr');
          this.emit('qr', qr);
        }
      } else {
        this.setState('waiting_qr');
        this.emit('qr', qr);
      }
    }

    if (connection === 'open') {
      this.qr = null;
      this.pairingCode = null;
      this.pairRequested = false;
      const user = this.sock?.user;
      if (user?.id) {
        const jid = jidNormalizedUser(user.id);
        this.me = { jid, number: jidToNumber(jid), name: user.name ?? undefined };
      }
      this.setState('connected');
      this.emit('connected', this.me);
      this.refreshGroups().catch((e) => log.warn({ err: String(e) }, 'refreshGroups failed'));
    }

    if (connection === 'close') {
      if (this.stopping) return;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      if (code === DisconnectReason.connectionReplaced) {
        this.me = null;
        this.setState('disconnected');
        this.emit('disconnected', code);
        log.warn('Connection replaced by another session; not reconnecting to avoid a login fight.');
        return;
      }

      if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
        log.warn({ code }, 'Logged out by WhatsApp — clearing session and requesting a fresh link.');
        await this.relinkFresh();
        return;
      }

      // Everything else (515 restartRequired, 408 timed out, 428 closed, …) → reconnect.
      this.me = null;
      this.setState('disconnected');
      this.emit('disconnected', code);
      log.info({ code }, 'Connection closed; reconnecting…');
      setTimeout(() => {
        this.connect().catch((e) => log.error({ err: String(e) }, 'reconnect failed'));
      }, 2000);
    }
  }

  private async relinkFresh(): Promise<void> {
    try {
      rmSync(config.authDir, { recursive: true, force: true });
    } catch (e) {
      log.warn({ err: String(e) }, 'could not clear auth dir');
    }
    this.me = null;
    this.pairRequested = false;
    this.qr = null;
    this.pairingCode = null;
    this.setState('logged_out');
    this.emit('logged_out');
    setTimeout(() => {
      this.start().catch((e) => log.error({ err: String(e) }, 're-link start failed'));
    }, 1500);
  }

  // ─── Event → store wiring ─────────────────────────────────────────
  private onHistorySet(h: { contacts?: unknown[]; chats?: unknown[]; messages?: unknown[] }): void {
    try {
      for (const c of h.contacts ?? []) this.storeContact(c);
      for (const ch of h.chats ?? []) this.storeChatAsGroup(ch);
      for (const m of h.messages ?? []) this.storeMessage(m);
    } catch (e) {
      log.warn({ err: String(e) }, 'history set handling error');
    }
  }

  private onContacts(cs: unknown[]): void {
    for (const c of cs ?? []) this.storeContact(c);
  }

  private onGroups(gs: unknown[]): void {
    for (const g of (gs ?? []) as Array<{ id?: string; subject?: string; participants?: unknown[]; size?: number }>) {
      if (!g?.id) continue;
      this.store.upsertGroup({
        jid: g.id,
        subject: g.subject ?? null,
        participant_count: Array.isArray(g.participants) ? g.participants.length : g.size ?? null,
      });
    }
  }

  private onMessagesUpsert(ev: { type?: string; messages?: unknown[] }): void {
    if (ev.type !== 'notify') return;
    for (const m of ev.messages ?? []) this.storeMessage(m);
  }

  private storeContact(raw: unknown): void {
    const c = raw as { id?: string; name?: string; notify?: string; verifiedName?: string };
    if (!c?.id || !c.id.endsWith('@s.whatsapp.net')) return;
    const jid = jidNormalizedUser(c.id);
    this.store.upsertContact({
      jid,
      name: c.name ?? null,
      notify: c.notify ?? c.verifiedName ?? null,
      phone: digitsOf(jid),
    });
  }

  private storeChatAsGroup(raw: unknown): void {
    const ch = raw as { id?: string; name?: string; subject?: string };
    if (!ch?.id || !isJidGroup(ch.id)) return;
    this.store.upsertGroup({ jid: ch.id, subject: ch.subject ?? ch.name ?? null });
  }

  private storeMessage(raw: unknown): void {
    try {
      const m = raw as {
        key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
        message?: Record<string, unknown> | null;
        messageTimestamp?: unknown;
        pushName?: string;
      };
      const key = m.key;
      if (!key?.id || !key.remoteJid) return;
      const chat = key.remoteJid;
      if (chat === 'status@broadcast' || chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) {
        return;
      }
      const isUser = chat.endsWith('@s.whatsapp.net');
      const isGroup = isJidGroup(chat);
      if (!isUser && !isGroup) return;

      const content = m.message ?? null;
      const type = content ? getContentType(content as never) ?? null : null;
      const text = this.extractText(content);
      const fromMe = key.fromMe ? 1 : 0;
      const chatJid = isUser ? jidNormalizedUser(chat) : chat;
      const sender = fromMe
        ? this.me?.jid ?? 'me'
        : key.participant
          ? jidNormalizedUser(key.participant)
          : chatJid;

      this.store.insertMessage({
        chat_jid: chatJid,
        id: key.id,
        sender,
        from_me: fromMe,
        ts: timestampToMs(m.messageTimestamp),
        type,
        text: text || null,
      });

      // Learn the sender's WhatsApp display name (pushName) without clobbering a saved name.
      if (!fromMe && isUser && m.pushName) {
        this.store.upsertContact({ jid: chatJid, notify: m.pushName, phone: digitsOf(chatJid) });
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'storeMessage error');
    }
  }

  private extractText(content: Record<string, unknown> | null): string {
    if (!content) return '';
    const c = content as Record<string, { text?: string; caption?: string; title?: string; selectedDisplayText?: string }> & {
      conversation?: string;
    };
    return (
      c.conversation ??
      c.extendedTextMessage?.text ??
      c.imageMessage?.caption ??
      c.videoMessage?.caption ??
      c.documentMessage?.caption ??
      c.buttonsResponseMessage?.selectedDisplayText ??
      c.listResponseMessage?.title ??
      ''
    );
  }

  // ─── Public API used by sender/reader/api ─────────────────────────
  async refreshGroups(): Promise<void> {
    if (!this.sock) return;
    const all = await this.sock.groupFetchAllParticipating();
    for (const meta of Object.values(all)) {
      this.store.upsertGroup({
        jid: meta.id,
        subject: meta.subject ?? null,
        participant_count: meta.participants?.length ?? null,
      });
    }
  }

  isConnected(): boolean {
    return this.state === 'connected' && !!this.sock;
  }

  async sendContent(jid: string, content: AnyMessageContent): Promise<void> {
    if (!this.sock || !this.isConnected()) throw new Error('not_connected');
    await this.sock.sendMessage(jid, content);
  }

  async checkOnWhatsApp(digits: string): Promise<{ jid: string; exists: boolean } | null> {
    if (!this.sock) return null;
    try {
      const res = await this.sock.onWhatsApp(digits);
      const first = res?.[0];
      return first
        ? { jid: first.jid, exists: !!first.exists }
        : { jid: `${digits}@s.whatsapp.net`, exists: false };
    } catch {
      return null;
    }
  }

  getStatus(): StatusInfo {
    return {
      state: this.state,
      me: this.me,
      paused: this.store.isPaused(),
      qr: this.qr,
      pairingCode: this.pairingCode,
      sentLastMinute: this.store.countSentSince(Date.now() - 60_000),
      sentToday: this.store.countSentSince(startOfTodayMs()),
      limits: { perMinute: config.maxSendsPerMinute, perDay: config.maxSendsPerDay },
      counts: {
        contacts: this.store.countContacts(),
        groups: this.store.countGroups(),
        messages: this.store.countMessages(),
      },
      dataDir: config.dataDir,
    };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    try {
      this.sock?.end(undefined);
    } catch {
      // ignore
    }
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.emit('state', s);
  }
}
