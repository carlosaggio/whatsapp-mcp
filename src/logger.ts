import pino from 'pino';

/**
 * The daemon logs to STDERR (fd 2). The MCP stdio adapter never imports this —
 * it uses console.error only — so stdout stays a clean JSON-RPC channel.
 */
export const log = pino(
  { level: process.env.WHATSAPP_MCP_LOG_LEVEL ?? 'info' },
  pino.destination(2),
);

/** Baileys is extremely chatty; keep it silent unless explicitly debugging. */
export const baileysLogger = pino(
  { level: process.env.WHATSAPP_MCP_BAILEYS_LOG_LEVEL ?? 'silent' },
  pino.destination(2),
);
