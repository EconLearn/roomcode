// Room state is a pure fold over the room's message history.
// Every action (question, vote, poll, pin, close) is a persisted chat message,
// so a late joiner rebuilds the exact room by replaying history.

export type MsgType = 'chat' | 'question' | 'vote' | 'answered' | 'poll' | 'pollvote' | 'pin' | 'close' | 'join' | 'hide' | 'remove' | 'focus' | 'signal';

export interface RoomMsg {
  id: string;
  type: MsgType;
  senderId: string;
  senderName: string;
  sentTime: number;
  body: Record<string, any>;
}

export interface Question {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  anonymous: boolean;
  sentTime: number;
  voters: Set<string>;
  answered: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  votes: Map<string, number>; // userId -> option index (last vote wins)
  closed: boolean;
  sentTime: number;
  round1: Map<string, number> | null; // votes as they stood when the host asked again ("second take")
}

export interface RoomState {
  ownerId: string;
  feed: RoomMsg[]; // chat + questions + polls, in time order
  questions: Map<string, Question>;
  polls: Map<string, Poll>;
  pin: string | null;
  closed: boolean;
  people: Map<string, string>; // userId -> latest nickname seen
  hidden: Set<string>; // message IDs the host hid
  removed: Set<string>; // user IDs the host removed: everything they post is ignored
  focus: string | null; // the question the host is answering now
  closedAt: number | null;
  lost: Map<string, number>; // userId -> time they tapped "I'm lost" (cleared by the host or by tapping again)
}

export function emptyState(ownerId: string): RoomState {
  return { ownerId, feed: [], questions: new Map(), polls: new Map(), pin: null, closed: false, people: new Map([[ownerId, 'Host']]), hidden: new Set(), removed: new Set(), focus: null, closedAt: null, lost: new Map() };
}

export const LIMITS = { chat: 500, question: 280, pollQuestion: 140, pollOption: 60, pollOptions: 6, pin: 200, name: 24, title: 60 };

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

// Applies one message. Host-only actions from anyone else are ignored, so a
// tampered client cannot pin, close, answer or run polls.
export function apply(s: RoomState, m: RoomMsg): RoomState {
  const isHost = m.senderId === s.ownerId;
  if (s.removed.has(m.senderId) || s.hidden.has(m.id)) return s;
  if (m.senderName && (m.type === 'chat' || m.type === 'question' || m.type === 'join')) s.people.set(m.senderId, m.senderName);
  else if (!s.people.has(m.senderId)) s.people.set(m.senderId, m.senderName || 'Guest');
  if (s.closed && m.type !== 'close' && m.type !== 'hide' && m.type !== 'remove') return s;
  switch (m.type) {
    case 'chat': {
      if (!clip(m.body.text, LIMITS.chat)) return s;
      s.feed.push(m);
      break;
    }
    case 'question': {
      const text = clip(m.body.text, LIMITS.question);
      if (!text || s.questions.has(m.id)) return s;
      s.questions.set(m.id, {
        id: m.id, text, authorId: m.senderId, authorName: m.senderName,
        anonymous: !!m.body.anonymous, sentTime: m.sentTime, voters: new Set([m.senderId]), answered: false,
      });
      s.feed.push(m);
      break;
    }
    case 'vote': {
      const q = s.questions.get(String(m.body.qid));
      if (!q) return s;
      if (m.body.up === false) q.voters.delete(m.senderId);
      else q.voters.add(m.senderId);
      break;
    }
    case 'answered': {
      const q = s.questions.get(String(m.body.qid));
      if (q && isHost) { q.answered = m.body.answered !== false; if (q.answered && s.focus === q.id) s.focus = null; }
      break;
    }
    case 'focus': {
      // Host only: the question being answered now, shown first on every phone and the projector.
      if (!isHost) return s;
      const qid = String(m.body.qid ?? '');
      s.focus = s.questions.has(qid) && !s.questions.get(qid)!.answered ? qid : null;
      break;
    }
    case 'signal': {
      // One private tap: "I'm lost". Counted, never named. The host clears the count when they have re-explained.
      if (m.body.clear === true) { if (isHost) s.lost.clear(); break; }
      if (m.body.on === false) s.lost.delete(m.senderId); else s.lost.set(m.senderId, m.sentTime);
      break;
    }
    case 'poll': {
      if (!isHost) return s;
      if (m.body.retake) {
        // Second take: keep the first answers, let everyone vote again, and count who moved.
        const p = s.polls.get(String(m.body.retake));
        if (p && !p.closed && !p.round1) p.round1 = new Map(p.votes);
        break;
      }
      const question = clip(m.body.question, LIMITS.pollQuestion);
      const options = (Array.isArray(m.body.options) ? m.body.options : [])
        .map((o: unknown) => clip(o, LIMITS.pollOption)).filter(Boolean).slice(0, LIMITS.pollOptions);
      if (!question || options.length < 2) return s;
      s.polls.set(m.id, { id: m.id, question, options, votes: new Map(), closed: false, sentTime: m.sentTime, round1: null });
      s.feed.push(m);
      break;
    }
    case 'pollvote': {
      const p = s.polls.get(String(m.body.pollId));
      const i = Number(m.body.option);
      if (!p || p.closed || !Number.isInteger(i) || i < 0 || i >= p.options.length) return s;
      p.votes.set(m.senderId, i);
      break;
    }
    case 'pin': {
      if (isHost) s.pin = clip(m.body.text, LIMITS.pin) || null;
      if (isHost && m.body.closePollId) {
        const p = s.polls.get(String(m.body.closePollId));
        if (p) p.closed = true;
      }
      break;
    }
    case 'join': {
      // One "joined" line per person; repeat joins (new tab, reconnect) are not shown again.
      if (s.feed.some(f => f.type === 'join' && f.senderId === m.senderId)) return s;
      s.feed.push(m);
      break;
    }
    case 'close': {
      if (isHost && !s.closed) { s.closed = true; s.closedAt = m.sentTime; s.focus = null; s.lost.clear(); }
      break;
    }
    case 'hide': {
      const id = String(m.body.id);
      if (!isHost) return s;
      s.hidden.add(id);
      s.feed = s.feed.filter(f => f.id !== id);
      s.questions.delete(id);
      s.polls.delete(id);
      if (s.focus === id) s.focus = null;
      break;
    }
    case 'remove': {
      const uid = String(m.body.userId);
      if (!isHost || uid === s.ownerId) return s;
      s.removed.add(uid);
      s.feed = s.feed.filter(f => f.senderId !== uid);
      for (const [id, q] of s.questions) { if (q.authorId === uid) s.questions.delete(id); else q.voters.delete(uid); }
      for (const p of s.polls.values()) { p.votes.delete(uid); p.round1?.delete(uid); }
      s.people.delete(uid);
      s.lost.delete(uid);
      if (s.focus && !s.questions.has(s.focus)) s.focus = null;
      break;
    }
  }
  return s;
}

export function build(ownerId: string, msgs: RoomMsg[]): RoomState {
  const s = emptyState(ownerId);
  const seen = new Set<string>();
  for (const m of [...msgs].sort((a, b) => a.sentTime - b.sentTime)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    apply(s, m);
  }
  return s;
}

// Open questions first, then by votes, then oldest first (first asked wins ties).
// True while nothing but "joined" lines has happened in the room.
export const isQuiet = (s: RoomState) => s.feed.every(m => m.type === 'join');

export function rankedQuestions(s: RoomState): Question[] {
  return [...s.questions.values()].sort((a, b) =>
    Number(b.id === s.focus) - Number(a.id === s.focus) || Number(a.answered) - Number(b.answered) || b.voters.size - a.voters.size || a.sentTime - b.sentTime);
}

export function pollTally(p: Poll): { counts: number[]; total: number } {
  const counts = p.options.map(() => 0);
  for (const i of p.votes.values()) counts[i]++;
  return { counts, total: p.votes.size };
}

// How many people answered differently the second time.
export function changedMinds(p: Poll): number {
  if (!p.round1) return 0;
  let n = 0;
  for (const [u, v] of p.round1) if (p.votes.has(u) && p.votes.get(u) !== v) n++;
  return n;
}

export function latestOpenPoll(s: RoomState): Poll | null {
  let best: Poll | null = null;
  for (const p of s.polls.values()) if (!p.closed && (!best || p.sentTime > best.sentTime)) best = p;
  return best;
}

// ---------- similar questions (plain word overlap; runs in the browser) ----------
const STOP = new Set('a an the is are was were be to of in on for and or do does did can could will would should we you i it this that what when where why how with at by from our your my about there have has too also well as if they already'.split(' '));
// Rough stem so "shared", "sharing" and "shares" match "share".
const stem = (w: string) => w.length > 4 ? w.replace(/wards?$/, '').replace(/(ing|ed|es|s|e)$/, '') : w;
export function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w)).map(stem));
}
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / Math.min(a.size, b.size);
}
// Stricter than `similarity`: two finished questions are "the same" only if most words of BOTH overlap,
// so questions that merely share the lesson's topic stay apart.
export function sameQuestion(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both >= 2 && (both / Math.min(a.size, b.size) + both / Math.max(a.size, b.size)) / 2 >= 0.65;
}

// Open questions that look like the draft, best match first. Used to offer "vote for this instead".
export function lookalikes(s: RoomState, draft: string, limit = 2): Question[] {
  const k = keywords(draft);
  if (k.size < 2) return [];
  return [...s.questions.values()].filter(q => !q.answered)
    .map(q => ({ q, sim: similarity(k, keywords(q.text)) })).filter(x => x.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim || b.q.voters.size - a.q.voters.size).slice(0, limit).map(x => x.q);
}

export interface Summary {
  people: number; asked: number; answered: number; open: number; votes: number; pollVotes: number; messages: number;
  minutes: number | null;
  groups: { lead: Question; others: Question[]; votes: number }[]; // similar questions under the most-voted one
  polls: { poll: Poll; counts: number[]; total: number }[];
}

// Everything the recap screen, the projector's closing slide and the exported file show.
export function summarize(s: RoomState): Summary {
  const qs = rankedQuestions(s).sort((a, b) => b.voters.size - a.voters.size || a.sentTime - b.sentTime);
  const groups: Summary['groups'] = [];
  for (const q of qs) {
    const k = keywords(q.text);
    const g = groups.find(g => sameQuestion(k, keywords(g.lead.text)));
    if (g) { g.others.push(q); g.votes += q.voters.size; } else groups.push({ lead: q, others: [], votes: q.voters.size });
  }
  groups.sort((a, b) => b.votes - a.votes);
  const polls = [...s.polls.values()].sort((a, b) => a.sentTime - b.sentTime).map(poll => ({ poll, ...pollTally(poll) }));
  const first = s.feed.find(m => m.type !== 'join')?.sentTime;
  const last = s.closedAt ?? s.feed[s.feed.length - 1]?.sentTime;
  return {
    people: s.people.size, asked: qs.length, answered: qs.filter(q => q.answered).length, open: qs.filter(q => !q.answered).length,
    votes: qs.reduce((n, q) => n + q.voters.size, 0), pollVotes: polls.reduce((n, p) => n + p.total, 0),
    messages: s.feed.filter(m => m.type === 'chat').length,
    minutes: first && last && last > first ? Math.max(1, Math.round((last - first) / 60000)) : null,
    groups, polls,
  };
}

// Recap as Markdown: paste it into notes, an email or a class page, or download it.
export function recap(title: string, code: string, s: RoomState): string {
  const r = summarize(s);
  const lines = [`# ${title} (room ${code})`, '',
    `People: ${r.people} · Questions: ${r.asked} (${r.answered} answered) · Votes: ${r.votes + r.pollVotes} · Messages: ${r.messages}${r.minutes ? ` · ${r.minutes} min` : ''}`, ''];
  if (r.groups.length) {
    lines.push('## Questions, most wanted first');
    for (const g of r.groups) {
      lines.push(`- (${g.votes} ${g.votes === 1 ? 'vote' : 'votes'}${g.lead.answered ? ', answered' : ', still open'}) ${g.lead.text}`);
      for (const o of g.others) lines.push(`  - also asked: ${o.text}`);
    }
    lines.push('');
  }
  for (const { poll, counts, total } of r.polls) {
    lines.push(`## Poll: ${poll.question} (${total} ${total === 1 ? 'vote' : 'votes'})`);
    poll.options.forEach((o, i) => lines.push(`- ${o}: ${counts[i]}${total ? ` (${Math.round(counts[i] * 100 / total)}%)` : ''}`));
    if (poll.round1) lines.push(`- Asked twice: ${changedMinds(poll)} of ${poll.round1.size} changed their mind`);
    lines.push('');
  }
  return lines.join('\n');
}
