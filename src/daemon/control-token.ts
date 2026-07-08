import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

/**
 * A shared secret the daemon writes on first run and the MCP adapter/CLIs read.
 * The control API binds to 127.0.0.1 only; this token is a second, cheap guard
 * so nothing else on the machine can drive your WhatsApp without it.
 */
export function ensureControlToken(): string {
  const existing = readControlToken();
  if (existing) return existing;
  mkdirSync(dirname(config.tokenPath), { recursive: true });
  const token = randomBytes(24).toString('hex');
  writeFileSync(config.tokenPath, token, { mode: 0o600 });
  try {
    chmodSync(config.tokenPath, 0o600);
  } catch {
    // best-effort on non-POSIX filesystems
  }
  return token;
}

export function readControlToken(): string | null {
  try {
    if (!existsSync(config.tokenPath)) return null;
    const t = readFileSync(config.tokenPath, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
