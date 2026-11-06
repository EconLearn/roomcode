// Room state is a pure fold over the room's message history.
// Every action (question, vote, poll, pin, close) is a persisted chat message,
// so a late joiner rebuilds the exact room by replaying history.

export type MsgType = 'chat' | 'question' | 'vote' | 'answered' | 'poll' | 'pollvote' | 'pin' | 'close' | 'join' | 'hide' | 'remove';

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
}

export function emptyState(ownerId: string): RoomState {
  return { ownerId, feed: [], questions: new Map(), polls: new Map(), pin: null, closed: false, people: new Map([[ownerId, 'Host']]), hidden: new Set(), removed: new Set() };
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
      if (q && isHost) q.answered = m.body.answered !== false;
      break;
    }
    case 'poll': {
      if (!isHost) return s;
      const question = clip(m.body.question, LIMITS.pollQuestion);
      const options = (Array.isArray(m.body.options) ? m.body.options : [])
        .map((o: unknown) => clip(o, LIMITS.pollOption)).filter(Boolean).slice(0, LIMITS.pollOptions);
      if (!question || options.length < 2) return s;
      s.polls.set(m.id, { id: m.id, question, options, votes: new Map(), closed: false, sentTime: m.sentTime });
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
      if (isHost) s.closed = true;
      break;
    }
    case 'hide': {
      const id = String(m.body.id);
      if (!isHost) return s;
      s.hidden.add(id);
      s.feed = s.feed.filter(f => f.id !== id);
      s.questions.delete(id);
      s.polls.delete(id);
      break;
    }
    case 'remove': {
      const uid = String(m.body.userId);
      if (!isHost || uid === s.ownerId) return s;
      s.removed.add(uid);
      s.feed = s.feed.filter(f => f.senderId !== uid);
      for (const [id, q] of s.questions) { if (q.authorId === uid) s.questions.delete(id); else q.voters.delete(uid); }
      for (const p of s.polls.values()) p.votes.delete(uid);
      s.people.delete(uid);
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
    Number(a.answered) - Number(b.answered) || b.voters.size - a.voters.size || a.sentTime - b.sentTime);
}

export function pollTally(p: Poll): { counts: number[]; total: number } {
  const counts = p.options.map(() => 0);
  for (const i of p.votes.values()) counts[i]++;
  return { counts, total: p.votes.size };
}

export function latestOpenPoll(s: RoomState): Poll | null {
  let best: Poll | null = null;
  for (const p of s.polls.values()) if (!p.closed && (!best || p.sentTime > best.sentTime)) best = p;
  return best;
}

// Plain-text recap the host can paste into notes, an email or a class page.
export function recap(title: string, code: string, s: RoomState): string {
  const msgs = s.feed.filter(m => m.type !== 'join').length;
  const lines = [`# ${title} (room ${code})`, '', `People: ${s.people.size} · Messages: ${msgs}`, ''];
  const qs = rankedQuestions(s);
  if (qs.length) {
    lines.push('## Questions');
    for (const q of qs) lines.push(`- (${q.voters.size} votes${q.answered ? ', answered' : ''}) ${q.text}`);
    lines.push('');
  }
  for (const p of s.polls.values()) {
    const { counts, total } = pollTally(p);
    lines.push(`## Poll: ${p.question} (${total} votes)`);
    p.options.forEach((o, i) => lines.push(`- ${o}: ${counts[i]}`));
    lines.push('');
  }
  return lines.join('\n');
}
