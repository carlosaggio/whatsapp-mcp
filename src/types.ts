// Shared domain types used across the daemon and the MCP adapter.

export type ConnectionState =
  | 'starting'
  | 'waiting_qr'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface MeInfo {
  jid: string;
  number: string; // display form, e.g. "+972501234567"
  name?: string;
}

export interface StatusInfo {
  state: ConnectionState;
  me: MeInfo | null;
  paused: boolean;
  qr: string | null; // raw QR payload, present while waiting_qr
  pairingCode: string | null;
  sentLastMinute: number;
  sentToday: number;
  limits: { perMinute: number; perDay: number };
  counts: { contacts: number; groups: number; messages: number };
  dataDir: string;
}

export type RecipientKind = 'contact' | 'group';
export type ResolveKind = 'contact' | 'group' | 'auto';

export interface Recipient {
  jid: string;
  kind: RecipientKind;
  name: string;
  number?: string; // contacts only, display form with leading "+"
  participantCount?: number; // groups only
  requiresExtraConfirmation: boolean;
}

export interface Candidate {
  jid: string;
  kind: RecipientKind;
  name: string;
  number?: string;
  participantCount?: number;
}

export type ResolveResult =
  | { status: 'resolved'; recipient: Recipient }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'not_found'; message: string };
