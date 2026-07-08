import qrcodeTerminal from 'qrcode-terminal';
import { daemon, DaemonUnavailableError } from '../control-client.js';

async function main(): Promise<void> {
  try {
    const s = (await daemon.qr()) as any;
    if (s.state === 'connected') {
      console.log(`✅ Already linked as ${s.me?.number ?? 'unknown'}.`);
      return;
    }
    if (s.pairingCode) {
      console.log(`🔗 Pairing code: ${s.pairingCode}`);
      console.log('On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead".');
      return;
    }
    if (s.qr) {
      console.log('📱 Scan in WhatsApp → Settings → Linked Devices → Link a device:\n');
      qrcodeTerminal.generate(s.qr, { small: true }, (art) => console.log(art));
      return;
    }
    console.log(
      `State: ${s.state}. No QR available yet — the gateway may still be starting or is already connected. Check the gateway terminal, or try again shortly.`,
    );
  } catch (e) {
    console.error(e instanceof DaemonUnavailableError ? e.message : String(e));
    process.exitCode = 1;
  }
}

void main();
