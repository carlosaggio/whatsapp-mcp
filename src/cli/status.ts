import qrcodeTerminal from 'qrcode-terminal';
import { daemon, DaemonUnavailableError } from '../control-client.js';

async function main(): Promise<void> {
  try {
    const s = (await daemon.status()) as any;
    console.log(`State:         ${s.state}`);
    console.log(`Linked number: ${s.me?.number ?? '(not linked yet)'}${s.me?.name ? ` (${s.me.name})` : ''}`);
    console.log(`Sending:       ${s.paused ? '⏸ PAUSED' : 'active'}`);
    console.log(
      `Sent:          ${s.sentLastMinute}/min, ${s.sentToday} today  (caps ${s.limits.perMinute}/min, ${s.limits.perDay}/day)`,
    );
    console.log(`Local store:   ${s.counts.contacts} contacts, ${s.counts.groups} groups, ${s.counts.messages} messages`);
    console.log(`Data dir:      ${s.dataDir}`);
    if (s.pairingCode) console.log(`Pairing code:  ${s.pairingCode}`);
    if (s.state === 'waiting_qr' && s.qr) {
      console.log('\n📱 Scan to link:\n');
      qrcodeTerminal.generate(s.qr, { small: true }, (art) => console.log(art));
    }
  } catch (e) {
    console.error(e instanceof DaemonUnavailableError ? e.message : String(e));
    process.exitCode = 1;
  }
}

void main();
