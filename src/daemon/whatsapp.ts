import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  isLidUser,
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
  private reconnectAttempts = 0;
  private lastMessageAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connecting = false;


  constructor(private store: Store) {
    super();
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    this.authState = state;
    this.saveCreds = saveCreds;
    await this.connect();
  }

  private teardownSocket(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    const old = this.sock;
    this.sock = null;
    if (!old) return;
    try {
      old.ev.removeAllListeners('connection.update');
      old.ev.removeAllListeners('messages.upsert');
      old.end(undefined);
    } catch {
      // ignore
    }
  }

  private websocketOpen(): boolean {
    const ws = (this.sock as { ws?: { isOpen?: boolean } } | null)?.ws;
    return ws?.isOpen === true;
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.stopping || this.state !== 'connected') return;
      if (!this.websocketOpen()) {
        log.warn('WebSocket closed while state=connected; forcing reconnect');
        void this.forceReconnect();
      }
    }, 30_000);
    this.watchdogTimer.unref?.();
  }

  private async forceReconnect(): Promise<void> {
    if (this.stopping) return;
    this.teardownSocket();
    this.me = null;
    this.setState('disconnected');
    this.reconnectAttempts = 0;
    try {
      await this.connect();
    } catch (e) {
      log.error({ err: String(e) }, 'forced reconnect failed');
    }
  }

  private async connect(): Promise<void> {
    if (!this.authState) throw new Error('auth state not loaded');
    if (this.connecting) return;
    this.connecting = true;
    this.teardownSocket();
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
      // Whether to request the entire multi-year backfill (heavy). Configurable.
      syncFullHistory: config.syncFullHistory,
      // Always PROCESS the on-login history sync WhatsApp sends — that payload carries
      // the contact list + chat names. The default gates this behind syncFullHistory,
      // so we override it explicitly to get contacts even without the full backfill.
      shouldSyncHistoryMessage: () => true,
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
    sock.ev.on('chats.upsert', (cs) => this.onChats(cs));
    sock.ev.on('messages.upsert', (m) => this.onMessagesUpsert(m));
    this.connecting = false;
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
      this.reconnectAttempts = 0;
      const user = this.sock?.user;
      if (user?.id) {
        const jid = jidNormalizedUser(user.id);
        this.me = { jid, number: jidToNumber(jid), name: user.name ?? undefined };
      }
      this.lastConnectedAt = Date.now();
      this.setState('connected');
      this.emit('connected', this.me);
      this.startWatchdog();
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

      // Everything else (515 restartRequired, 408 timed out, 428 closed, …) → reconnect
      // with exponential backoff + jitter, so a flaky connection can't hammer WhatsApp.
      this.me = null;
      this.setState('disconnected');
      this.emit('disconnected', code);
      const delay = Math.min(2000 * 2 ** this.reconnectAttempts, 60_000) + Math.floor(Math.random() * 1000);
      this.reconnectAttempts += 1;
      log.info({ code, delayMs: delay, attempt: this.reconnectAttempts }, 'Connection closed; reconnecting…');
      setTimeout(() => {
        this.teardownSocket();
        this.connect().catch((e) => log.error({ err: String(e) }, 'reconnect failed'));
      }, delay);
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
    log.debug(
      { contacts: h.contacts?.length ?? 0, chats: h.chats?.length ?? 0, messages: h.messages?.length ?? 0 },
      'history sync received',
    );
    try {
      for (const c of h.contacts ?? []) this.storeContact(c);
      for (const ch of h.chats ?? []) this.storeChatName(ch);
      for (const m of h.messages ?? []) this.storeMessage(m);
    } catch (e) {
      log.warn({ err: String(e) }, 'history set handling error');
    }
  }

  private onChats(cs: unknown[]): void {
    for (const c of cs ?? []) this.storeChatName(c);
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
    if (!c?.id) return;
    if (c.id.endsWith('@lid')) {
      this.store.upsertContact({
        jid: c.id,
        name: c.name ?? null,
        notify: c.notify ?? c.verifiedName ?? null,
        phone: digitsOf(c.id),
      });
      return;
    }
    if (!c.id.endsWith('@s.whatsapp.net')) return;
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

  /** A chat's title. For groups → subject; for a 1:1 → a name fallback so people
   *  you've chatted with resolve even before a full contact sync lands. */
  private storeChatName(raw: unknown): void {
    const ch = raw as { id?: string; name?: string };
    if (!ch?.id) return;
    if (isJidGroup(ch.id)) {
      this.storeChatAsGroup(raw);
      return;
    }
    if (!ch.id.endsWith('@s.whatsapp.net') || !ch.name?.trim()) return;
    const jid = jidNormalizedUser(ch.id);
    this.store.upsertContact({ jid, notify: ch.name.trim(), phone: digitsOf(jid) });
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
      const isLid = isLidUser(chat);
      const isGroup = isJidGroup(chat);
      if (!isUser && !isLid && !isGroup) return;

      const content = m.message ?? null;
      const type = content ? getContentType(content as never) ?? null : null;
      const text = this.extractText(content);
      const fromMe = key.fromMe ? 1 : 0;
      const chatJid = isGroup ? chat : isUser ? jidNormalizedUser(chat) : chat;
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
      this.lastMessageAt = Date.now();

      // Learn senders' WhatsApp display names (pushName) without clobbering a saved name —
      // for 1:1 chats and for people who post in your groups (so they become resolvable).
      if (!fromMe && m.pushName) {
        if (isUser || isLid) {
          this.store.upsertContact({ jid: chatJid, notify: m.pushName, phone: digitsOf(chatJid) });
        } else if (isGroup && key.participant) {
          const pj = key.participant;
          if (pj.endsWith('@s.whatsapp.net') || pj.endsWith('@lid')) {
            const cj = pj.endsWith('@s.whatsapp.net') ? jidNormalizedUser(pj) : pj;
            this.store.upsertContact({ jid: cj, notify: m.pushName, phone: digitsOf(pj) });
          }
        }
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
      syncHealth: {
        lastMessageAt: this.lastMessageAt,
        lastConnectedAt: this.lastConnectedAt,
        websocketOpen: this.websocketOpen(),
        stale:
          this.state === 'connected' &&
          !this.websocketOpen(),
      },
    };
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.teardownSocket();
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.emit('state', s);
  }
}
