/** Extract just the digits from any phone-ish string. */
export function digitsOf(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/** "972501234567:12@s.whatsapp.net" -> "+972501234567" */
export function jidToNumber(jid: string): string {
  const local = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = digitsOf(local);
  return digits ? `+${digits}` : jid;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function startOfTodayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Baileys timestamps can be a number or a protobuf Long; normalize to ms. */
export function timestampToMs(v: unknown): number {
  if (v == null) return Date.now();
  if (typeof v === 'number') return v * 1000;
  const asLong = v as { toNumber?: () => number; low?: number };
  if (typeof asLong.toNumber === 'function') return asLong.toNumber() * 1000;
  const n = Number(v as never);
  return Number.isFinite(n) ? n * 1000 : Date.now();
}
