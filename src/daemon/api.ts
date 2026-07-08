import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from '../config.js';
import { log } from '../logger.js';
import { readMessages, type ReadInput } from './reader.js';
import { prepareMessage, sendMessage, type PrepareInput, type SendInput } from './sender.js';
import type { Store } from './store.js';
import type { WhatsApp } from './whatsapp.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ApiDeps {
  store: Store;
  wa: WhatsApp;
  token: string;
  onShutdown: () => void;
}

/** Local-only control API the MCP adapter and CLIs talk to. Bound to 127.0.0.1. */
export function startControlApi(deps: ApiDeps): Server {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      log.error({ err: String(e) }, 'api handler error');
      sendJson(res, 500, { error: String(e) });
    });
  });
  server.listen(config.controlPort, config.controlHost, () => {
    log.info({ url: `http://${config.controlHost}:${config.controlPort}` }, 'control API listening');
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const { store, wa, token, onShutdown } = deps;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/health' && method === 'GET') return sendJson(res, 200, { ok: true });

  if (req.headers['x-control-token'] !== token) return sendJson(res, 401, { error: 'unauthorized' });

  if (method === 'GET' && path === '/status') return sendJson(res, 200, wa.getStatus());
  if (method === 'GET' && path === '/qr') {
    const s = wa.getStatus();
    return sendJson(res, 200, { state: s.state, qr: s.qr, pairingCode: s.pairingCode, me: s.me });
  }

  if (method === 'POST') {
    const body = await readBody(req);
    switch (path) {
      case '/prepare':
        return sendJson(res, 200, await prepareMessage(store, wa, body as PrepareInput));
      case '/send':
        return sendJson(res, 200, await sendMessage(store, wa, body as SendInput));
      case '/read':
        return sendJson(res, 200, readMessages(store, body as ReadInput));
      case '/pause':
        store.setPaused(true);
        return sendJson(res, 200, { ok: true, paused: true });
      case '/resume':
        store.setPaused(false);
        return sendJson(res, 200, { ok: true, paused: false });
      case '/shutdown':
        sendJson(res, 200, { ok: true });
        setTimeout(onShutdown, 50);
        return;
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}
