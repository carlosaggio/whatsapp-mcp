import { controlBaseUrl } from './config.js';
import { readControlToken } from './daemon/control-token.js';

/** Thrown when the gateway daemon isn't reachable (not started, wrong port, etc.). */
export class DaemonUnavailableError extends Error {}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const token = readControlToken();
  let res: Response;
  try {
    res = await fetch(`${controlBaseUrl()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-control-token': token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new DaemonUnavailableError(
      `Could not reach the WhatsApp gateway at ${controlBaseUrl()}. Is it running? Start it in a terminal with:  npm start`,
    );
  }
  const txt = await res.text();
  let data: unknown;
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = { raw: txt };
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export const daemon = {
  status: () => call<Record<string, unknown>>('GET', '/status'),
  qr: () => call<Record<string, unknown>>('GET', '/qr'),
  prepare: (b: unknown) => call<Record<string, unknown>>('POST', '/prepare', b, 30_000),
  send: (b: unknown) => call<Record<string, unknown>>('POST', '/send', b, 60_000),
  read: (b: unknown) => call<Record<string, unknown>>('POST', '/read', b),
  pause: () => call<Record<string, unknown>>('POST', '/pause', {}),
  resume: () => call<Record<string, unknown>>('POST', '/resume', {}),
  shutdown: () => call<Record<string, unknown>>('POST', '/shutdown', {}),
};
