import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { MeInfo } from '../types.js';
import { startControlApi } from './api.js';
import { ensureControlToken } from './control-token.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';

function acquireLock(): void {
  const lock = join(config.dataDir, 'gateway.pid');
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    if (pid > 0) process.kill(pid, 0);
    console.error(`Another WhatsApp gateway is already running (pid ${pid}). Stop it first.`);
    process.exit(1);
  } catch {
    // stale or missing lock
  }
  writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
}

function banner(): void {
  console.log('╭──────────────────────────────────────────────╮');
  console.log('│  WhatsApp MCP — gateway daemon                 │');
  console.log('╰──────────────────────────────────────────────╯');
  console.log(`Data dir:    ${config.dataDir}`);
  console.log(`Control API: http://${config.controlHost}:${config.controlPort}  (local only)`);
  console.log('Connecting to WhatsApp…  On first run, scan the QR code below.\n');
}

function printQr(qr: string): void {
  console.log('\n📱 Scan in WhatsApp → Settings → Linked Devices → Link a device:\n');
  console.log(`QRRAW:${qr}`);
  qrcodeTerminal.generate(qr, { small: true }, (art) => console.log(art));
}

async function main(): Promise<void> {
  mkdirSync(config.dataDir, { recursive: true });
  acquireLock();
  const token = ensureControlToken();
  const store = new Store();
  const wa = new WhatsApp(store);

  banner();

  wa.on('qr', (qr: string) => printQr(qr));
  wa.on('pairing', (code: string) => {
    console.log(`\n🔗 Pairing code: ${code}`);
    console.log(
      '   On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead", then enter this code.\n',
    );
  });
  wa.on('connected', (me: MeInfo | null) => {
    console.log(
      `\n✅ Connected as ${me?.number ?? 'unknown'}${me?.name ? ` (${me.name})` : ''}. Session saved — no re-link needed after a restart.\n`,
    );
  });
  wa.on('logged_out', () => {
    console.log('\n⚠️  WhatsApp logged this device out. Cleared the old session; a fresh QR/code will appear to re-link.\n');
  });
  wa.on('disconnected', () => log.info('disconnected; reconnecting…'));

  let shuttingDown = false;
  const server = startControlApi({
    store,
    wa,
    token,
    onShutdown: () => void shutdown('shutdown request'),
  });

  await wa.start();

  const prune = setInterval(
    () => {
      try {
        store.pruneMessagesOlderThan(Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000);
        store.pruneExpiredDrafts(Date.now());
      } catch (e) {
        log.warn({ err: String(e) }, 'prune error');
      }
    },
    6 * 60 * 60 * 1000,
  );
  prune.unref();

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n👋 Shutting down (${reason})…`);
    clearInterval(prune);
    try {
      await wa.shutdown();
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 300);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error({ err: String(e) }, 'fatal');
  console.error(e);
  process.exit(1);
});
