import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

export interface ContactRow {
  jid: string;
  name: string | null;
  notify: string | null;
  phone: string | null;
}

export interface GroupRow {
  jid: string;
  subject: string | null;
  participant_count: number | null;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string | null;
  from_me: number;
  ts: number;
  type: string | null;
  text: string | null;
}

export interface DraftRow {
  draft_id: string;
  to_jid: string;
  to_name: string;
  to_display: string;
  kind: 'text' | 'media';
  text: string | null;
  media_path: string | null;
  media_type: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  content_hash: string;
  requires_extra: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface SentInput {
  ts: number;
  to_jid: string;
  to_name: string;
  kind: string;
  summary: string;
  draft_id: string;
}

/** Synchronous SQLite store built from live Baileys events. Single writer (the daemon). */
export class Store {
  private db: Database.Database;

  constructor(dbPath: string = config.dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS groups (
        jid TEXT PRIMARY KEY,
        subject TEXT,
        participant_count INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        chat_jid TEXT NOT NULL,
        id TEXT NOT NULL,
        sender TEXT,
        from_me INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        type TEXT,
        text TEXT,
        PRIMARY KEY (chat_jid, id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, ts DESC);
      CREATE TABLE IF NOT EXISTS drafts (
        draft_id TEXT PRIMARY KEY,
        to_jid TEXT NOT NULL,
        to_name TEXT NOT NULL,
        to_display TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        media_path TEXT,
        media_type TEXT,
        media_mimetype TEXT,
        media_filename TEXT,
        content_hash TEXT NOT NULL,
        requires_extra INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        to_jid TEXT NOT NULL,
        to_name TEXT,
        kind TEXT,
        summary TEXT,
        draft_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sent_ts ON sent_log (ts);
      CREATE TABLE IF NOT EXISTS control (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // ─── Contacts ─────────────────────────────────────────────────────
  upsertContact(c: { jid: string; name?: string | null; notify?: string | null; phone?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name, notify, phone, updated_at)
         VALUES (@jid, @name, @notify, @phone, @updated_at)
         ON CONFLICT(jid) DO UPDATE SET
           name   = COALESCE(excluded.name, contacts.name),
           notify = COALESCE(excluded.notify, contacts.notify),
           phone  = COALESCE(excluded.phone, contacts.phone),
           updated_at = excluded.updated_at`,
      )
      .run({
        jid: c.jid,
        name: c.name ?? null,
        notify: c.notify ?? null,
        phone: c.phone ?? null,
        updated_at: Date.now(),
      });
  }

  getContact(jid: string): ContactRow | undefined {
    return this.db
      .prepare(`SELECT jid, name, notify, phone FROM contacts WHERE jid = ?`)
      .get(jid) as ContactRow | undefined;
  }

  getContactByPhone(digits: string): ContactRow | undefined {
    return this.db
      .prepare(`SELECT jid, name, notify, phone FROM contacts WHERE phone = ? OR jid = ?`)
      .get(digits, `${digits}@s.whatsapp.net`) as ContactRow | undefined;
  }

  allContacts(): ContactRow[] {
    return this.db
      .prepare(`SELECT jid, name, notify, phone FROM contacts`)
      .all() as ContactRow[];
  }

  countContacts(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM contacts`).get() as { n: number }).n;
  }

  // ─── Groups ───────────────────────────────────────────────────────
  upsertGroup(g: { jid: string; subject?: string | null; participant_count?: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO groups (jid, subject, participant_count, updated_at)
         VALUES (@jid, @subject, @participant_count, @updated_at)
         ON CONFLICT(jid) DO UPDATE SET
           subject = COALESCE(excluded.subject, groups.subject),
           participant_count = COALESCE(excluded.participant_count, groups.participant_count),
           updated_at = excluded.updated_at`,
      )
      .run({
        jid: g.jid,
        subject: g.subject ?? null,
        participant_count: g.participant_count ?? null,
        updated_at: Date.now(),
      });
  }

  getGroup(jid: string): GroupRow | undefined {
    return this.db
      .prepare(`SELECT jid, subject, participant_count FROM groups WHERE jid = ?`)
      .get(jid) as GroupRow | undefined;
  }

  allGroups(): GroupRow[] {
    return this.db
      .prepare(`SELECT jid, subject, participant_count FROM groups`)
      .all() as GroupRow[];
  }

  countGroups(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM groups`).get() as { n: number }).n;
  }

  // ─── Messages ─────────────────────────────────────────────────────
  insertMessage(m: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (chat_jid, id, sender, from_me, ts, type, text)
         VALUES (@chat_jid, @id, @sender, @from_me, @ts, @type, @text)
         ON CONFLICT(chat_jid, id) DO UPDATE SET
           text = COALESCE(excluded.text, messages.text),
           type = COALESCE(excluded.type, messages.type)`,
      )
      .run(m);
    // Keep only the newest N messages for this chat.
    this.db
      .prepare(
        `DELETE FROM messages
         WHERE chat_jid = @chat AND id NOT IN (
           SELECT id FROM messages WHERE chat_jid = @chat ORDER BY ts DESC LIMIT @keep
         )`,
      )
      .run({ chat: m.chat_jid, keep: config.maxMessagesPerChat });
  }

  recentMessages(chatJid: string, limit: number, sinceTs?: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, chat_jid, sender, from_me, ts, type, text
         FROM messages
         WHERE chat_jid = @chat AND (@since IS NULL OR ts >= @since)
         ORDER BY ts DESC
         LIMIT @limit`,
      )
      .all({ chat: chatJid, since: sinceTs ?? null, limit }) as MessageRow[];
    return rows.reverse(); // chronological for display
  }

  countMessages(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM messages`).get() as { n: number }).n;
  }

  pruneMessagesOlderThan(cutoffMs: number): number {
    return this.db.prepare(`DELETE FROM messages WHERE ts < ?`).run(cutoffMs).changes;
  }

  // ─── Drafts ───────────────────────────────────────────────────────
  createDraft(d: DraftRow): void {
    this.db
      .prepare(
        `INSERT INTO drafts (draft_id, to_jid, to_name, to_display, kind, text,
           media_path, media_type, media_mimetype, media_filename,
           content_hash, requires_extra, created_at, expires_at, consumed_at)
         VALUES (@draft_id, @to_jid, @to_name, @to_display, @kind, @text,
           @media_path, @media_type, @media_mimetype, @media_filename,
           @content_hash, @requires_extra, @created_at, @expires_at, @consumed_at)`,
      )
      .run(d);
  }

  getDraft(draftId: string): DraftRow | undefined {
    return this.db.prepare(`SELECT * FROM drafts WHERE draft_id = ?`).get(draftId) as
      | DraftRow
      | undefined;
  }

  /** Atomically claim an unconsumed draft. Returns true only if THIS call consumed it. */
  claimDraft(draftId: string, now: number): boolean {
    const res = this.db
      .prepare(`UPDATE drafts SET consumed_at = ? WHERE draft_id = ? AND consumed_at IS NULL`)
      .run(now, draftId);
    return res.changes === 1;
  }

  pruneExpiredDrafts(now: number): void {
    this.db
      .prepare(`DELETE FROM drafts WHERE consumed_at IS NOT NULL OR expires_at < ?`)
      .run(now - 60 * 60 * 1000); // keep an hour of history for debugging
  }

  // ─── Sent log ─────────────────────────────────────────────────────
  insertSent(s: SentInput): void {
    this.db
      .prepare(
        `INSERT INTO sent_log (ts, to_jid, to_name, kind, summary, draft_id)
         VALUES (@ts, @to_jid, @to_name, @kind, @summary, @draft_id)`,
      )
      .run(s);
  }

  countSentSince(ts: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) n FROM sent_log WHERE ts >= ?`).get(ts) as { n: number }
    ).n;
  }

  // ─── Control (paused flag etc.) ───────────────────────────────────
  private getControl(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM control WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setControl(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO control (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  isPaused(): boolean {
    return this.getControl('paused') === '1';
  }

  setPaused(paused: boolean): void {
    this.setControl('paused', paused ? '1' : '0');
  }

  close(): void {
    this.db.close();
  }
}
