import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * All tunable behavior lives here. Edit the guardrail numbers below to change
 * how gentle/aggressive sending is. Everything is local to this machine.
 */

const DATA_DIR = resolve(
  process.env.WHATSAPP_MCP_DATA_DIR ?? join(homedir(), '.whatsapp-mcp'),
);

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export const config = {
  // ─── Safety guardrails — EDIT THESE (or set the matching env var) ──
  /** Randomized, human-like pause applied before every real send (ms). */
  sendDelayMinMs: envNum('WHATSAPP_MCP_SEND_DELAY_MIN_MS', 3_000),
  sendDelayMaxMs: envNum('WHATSAPP_MCP_SEND_DELAY_MAX_MS', 12_000),
  /** Rate limits. Sends past these caps are refused. */
  maxSendsPerMinute: envNum('WHATSAPP_MCP_MAX_PER_MINUTE', 5),
  maxSendsPerDay: envNum('WHATSAPP_MCP_MAX_PER_DAY', 100),
  /** How long a prepared draft stays valid before it must be re-prepared (ms). */
  draftTtlMs: envNum('WHATSAPP_MCP_DRAFT_TTL_MS', 10 * 60 * 1000),

  // ─── Local message store (the read feature) ───────────────────────
  /** Recent messages retained per chat, and their max age, for "what did X say?". */
  maxMessagesPerChat: 200,
  messageRetentionDays: 30,

  /**
   * Request WhatsApp's FULL history on link (vs. just recent). The full sync also
   * carries your complete address book, but is much heavier. Off by default; set
   * WHATSAPP_MCP_SYNC_FULL_HISTORY=true to pull everything on the next fresh link.
   */
  syncFullHistory: envBool('WHATSAPP_MCP_SYNC_FULL_HISTORY', false),

  // ─── Local control API (gateway daemon <-> MCP adapter) ───────────
  controlHost: process.env.WHATSAPP_MCP_HOST ?? '127.0.0.1',
  controlPort: Number(process.env.WHATSAPP_MCP_PORT ?? '8787'),

  // ─── Storage locations (all local, git-ignored) ───────────────────
  dataDir: DATA_DIR,
  authDir: join(DATA_DIR, 'auth'),
  dbPath: join(DATA_DIR, 'store.db'),
  tokenPath: join(DATA_DIR, 'control-token'),

  // ─── Optional: pairing-code login instead of QR ───────────────────
  /** Set WHATSAPP_MCP_PAIR_NUMBER=<E.164 digits, no +> to link with a code. */
  pairNumber: process.env.WHATSAPP_MCP_PAIR_NUMBER?.replace(/[^0-9]/g, '') || null,
} as const;

export function controlBaseUrl(): string {
  return `http://${config.controlHost}:${config.controlPort}`;
}
