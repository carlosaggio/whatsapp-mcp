import type { ContactRow, GroupRow, Store } from './store.js';
import type { Candidate, Recipient, ResolveKind, ResolveResult } from '../types.js';
import { jidToNumber } from '../util.js';

function contactDisplayName(c: ContactRow): string {
  return c.name?.trim() || c.notify?.trim() || jidToNumber(c.jid);
}

export function contactToRecipient(c: ContactRow, requiresExtra = false): Recipient {
  return {
    jid: c.jid,
    kind: 'contact',
    name: contactDisplayName(c),
    number: jidToNumber(c.jid),
    requiresExtraConfirmation: requiresExtra,
  };
}

export function groupToRecipient(g: GroupRow): Recipient {
  return {
    jid: g.jid,
    kind: 'group',
    name: g.subject?.trim() || g.jid,
    participantCount: g.participant_count ?? undefined,
    requiresExtraConfirmation: false,
  };
}

function score(query: string, value: string | null | undefined): number {
  if (!value) return -1;
  const q = query.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (!v || !q) return -1;
  if (v === q) return 3;
  if (v.startsWith(q)) return 2;
  if (v.includes(q)) return 1;
  return -1;
}

/**
 * Fuzzy-match a name against saved contacts and/or groups.
 * - Exactly one exact (full) match wins outright.
 * - Otherwise a single candidate resolves; more than one is reported ambiguous.
 * - Zero matches is not_found. Never guesses.
 */
export function resolveByName(store: Store, query: string, kind: ResolveKind): ResolveResult {
  interface Scored {
    recipient: Recipient;
    cand: Candidate;
    s: number;
  }
  const scored: Scored[] = [];

  if (kind === 'contact' || kind === 'auto') {
    for (const c of store.allContacts()) {
      const s = Math.max(score(query, c.name), score(query, c.notify));
      if (s >= 1) {
        const r = contactToRecipient(c);
        scored.push({ recipient: r, cand: { jid: r.jid, kind: 'contact', name: r.name, number: r.number }, s });
      }
    }
  }
  if (kind === 'group' || kind === 'auto') {
    for (const g of store.allGroups()) {
      const s = score(query, g.subject);
      if (s >= 1) {
        const r = groupToRecipient(g);
        scored.push({
          recipient: r,
          cand: { jid: r.jid, kind: 'group', name: r.name, participantCount: r.participantCount },
          s,
        });
      }
    }
  }

  if (scored.length === 0) {
    return { status: 'not_found', message: `No saved contact or group matches "${query}".` };
  }

  scored.sort((a, b) => b.s - a.s || a.cand.name.localeCompare(b.cand.name));

  const exacts = scored.filter((x) => x.s === 3);
  if (exacts.length === 1) return { status: 'resolved', recipient: exacts[0].recipient };
  if (scored.length === 1) return { status: 'resolved', recipient: scored[0].recipient };

  return { status: 'ambiguous', candidates: scored.slice(0, 10).map((x) => x.cand) };
}
