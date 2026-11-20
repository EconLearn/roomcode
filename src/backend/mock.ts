import type { MsgType, RoomMsg } from '../state.ts';
import { CODE_ALPHABET, type Backend, type RoomInfo, type Status } from './types.ts';

// Offline stand-in for Nexconn: rooms live in localStorage and messages fan out
// to other tabs over BroadcastChannel. Open two tabs to see a live room.
const KEY = 'roomcode:mock:rooms';
type Store = Record<string, { info: RoomInfo; msgs: RoomMsg[]; members?: string[]; joinedAt?: Record<string, number> }>;
// `?nohist` copies Nexconn's default: new members can't read messages from before they joined.
const NO_PREJOIN_HISTORY = new URLSearchParams(location.search).has('nohist');

const load = (): Store => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = (s: Store) => localStorage.setItem(KEY, JSON.stringify(s));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class MockBackend implements Backend {
  readonly kind = 'mock' as const;
  private bc = new BroadcastChannel('roomcode-mock');
  private userId = '';
  private name = '';
  private msgCbs: ((code: string, m: RoomMsg) => void)[] = [];
  private typingCbs: ((code: string, ids: string[]) => void)[] = [];
  private statusCbs: ((s: Status) => void)[] = [];
  private snapCbs: ((code: string, senderId: string, msgs: RoomMsg[]) => void)[] = [];
  private typing = new Map<string, Map<string, number>>();

  constructor() {
    this.bc.onmessage = (e) => {
      const d = e.data;
      if (d.kind === 'msg') this.msgCbs.forEach(cb => cb(d.code, d.msg));
      if (d.kind === 'typing' && d.userId !== this.userId) this.markTyping(d.code, d.userId);
      if (d.kind === 'snap') this.snapCbs.forEach(cb => cb(d.code, d.senderId, d.msgs));
    };
  }

  private markTyping(code: string, userId: string) {
    const room = this.typing.get(code) ?? new Map<string, number>();
    room.set(userId, Date.now());
    this.typing.set(code, room);
    const emit = () => {
      const now = Date.now();
      const ids = [...room].filter(([, t]) => now - t < 4000).map(([id]) => id);
      this.typingCbs.forEach(cb => cb(code, ids));
    };
    emit();
    setTimeout(emit, 4100);
  }

  async connect(device: string, name: string) {
    this.userId = 'u' + device.slice(0, 23); this.name = name;
    this.statusCbs.forEach(cb => cb('connecting'));
    await new Promise(r => setTimeout(r, 150));
    this.statusCbs.forEach(cb => cb('connected'));
    return this.userId;
  }
  async disconnect() { this.statusCbs.forEach(cb => cb('offline')); }
  setName(name: string) { this.name = name; }

  async createRoom(title: string): Promise<RoomInfo> {
    const s = load();
    let code = '';
    do { code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join(''); } while (s[code]);
    const info = { code, title, ownerId: this.userId, createdAt: Date.now() };
    s[code] = { info, msgs: [], members: [this.userId] };
    save(s);
    return info;
  }

  async joinRoom(code: string): Promise<RoomInfo> {
    const s = load(), r = s[code];
    if (!r) throw new Error('No room with that code.');
    r.members = [...new Set([...(r.members ?? []), this.userId])];
    r.joinedAt = { [r.info.ownerId]: r.info.createdAt, ...r.joinedAt };
    r.joinedAt[this.userId] ??= Date.now();
    save(s);
    return { ...r.info, memberCount: r.members.length };
  }

  async history(code: string) {
    const r = load()[code];
    if (!r) return [];
    const since = NO_PREJOIN_HISTORY ? r.joinedAt?.[this.userId] ?? 0 : 0;
    return r.msgs.filter(m => m.sentTime >= since);
  }

  async send(code: string, type: MsgType, body: Record<string, any>): Promise<RoomMsg> {
    const s = load();
    if (!s[code]) throw new Error('Room not found.');
    const msg: RoomMsg = { id: rid(), type, senderId: this.userId, senderName: this.name, sentTime: Date.now(), body };
    s[code].msgs.push(msg);
    save(s);
    this.bc.postMessage({ kind: 'msg', code, msg });
    return msg;
  }

  sendTyping(code: string) { this.bc.postMessage({ kind: 'typing', code, userId: this.userId }); }
  sendSnapshot(code: string, msgs: RoomMsg[]) { this.bc.postMessage({ kind: 'snap', code, senderId: this.userId, msgs }); }
  onSnapshot(cb: (code: string, senderId: string, msgs: RoomMsg[]) => void) { this.snapCbs.push(cb); }
  async moderate() { /* the offline demo has no server to enforce it */ }
  // Stand-in translation, so the flow can be tried offline.
  async translate(items: { id: string; text: string }[], lang: string) {
    await new Promise(r => setTimeout(r, 300));
    return new Map(items.map(it => [it.id, `[${lang}] ${it.text}`]));
  }
  onMessage(cb: (code: string, m: RoomMsg) => void) { this.msgCbs.push(cb); }
  onTyping(cb: (code: string, ids: string[]) => void) { this.typingCbs.push(cb); }
  onStatus(cb: (s: Status) => void) { this.statusCbs.push(cb); }
}
