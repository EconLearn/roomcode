import {
  NCEngine, AreaCode, LogLevel, GroupChannel, BaseChannel, ConnectionStatus,
  ConnectionStatusHandler, MessageHandler, SendMessageParams, SendTextMessageParams, TranslateHandler,
  TranslateMessageParam, type Message,
} from '@nexconn/chat';
import type { MsgType, RoomMsg } from '../state.ts';
import { codeFromGroupId, groupIdFor, type Backend, type RoomInfo, type Status } from './types.ts';

// Room actions are persisted custom messages in the room's group channel.
// Plain chat uses the SDK's built-in text message.
const TEXT = 'RC:TxtMsg';
const CUSTOM: Record<Exclude<MsgType, 'chat'>, string> = {
  question: 'RMC:Q', join: 'RMC:Join', vote: 'RMC:Vote', answered: 'RMC:Ans', poll: 'RMC:Poll', pollvote: 'RMC:PVote', pin: 'RMC:Pin', close: 'RMC:Close',
  hide: 'RMC:Hide', remove: 'RMC:Remove', focus: 'RMC:Focus', signal: 'RMC:Signal',
};
const TYPE_OF = new Map<string, MsgType>(Object.entries(CUSTOM).map(([k, v]) => [v, k as MsgType]));
// Votes are persisted (late joiners need them) but do not bump unread counts.
const QUIET = new Set(['RMC:Vote', 'RMC:PVote', 'RMC:Join', 'RMC:Hide', 'RMC:Remove', 'RMC:Focus', 'RMC:Signal']);
// Group channels have no typing API on Web, so typing is a transient status message.
const TYPING = 'RMC:Typing';
// The host's snapshot of the room for late joiners: also transient, never stored.
const SNAP = 'RMC:Snap';

export class TranslationUnavailable extends Error { override name = 'TranslationUnavailable'; }

async function api<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error (${r.status}).`);
  return j as T;
}

function toRoomMsg(m: Message): RoomMsg | null {
  const c = m.content as Record<string, any>;
  if (m.messageType === TEXT) {
    return { id: m.messageId, type: 'chat', senderId: m.senderUserId, senderName: c.senderUserInfo?.name || 'Guest', sentTime: m.sentTime, body: { text: c.text ?? c.content ?? '' } };
  }
  const type = TYPE_OF.get(m.messageType);
  if (!type) return null;
  const { n, ...body } = c;
  return { id: m.messageId, type, senderId: m.senderUserId, senderName: n || 'Guest', sentTime: m.sentTime, body };
}

export class NexconnBackend implements Backend {
  readonly kind = 'nexconn' as const;
  private userId = '';
  private device = '';
  private name = '';
  private token = '';
  private pending = new Map<string, (text: string | null) => void>();
  private msgCbs: ((code: string, m: RoomMsg) => void)[] = [];
  private typingCbs: ((code: string, ids: string[]) => void)[] = [];
  private statusCbs: ((s: Status) => void)[] = [];
  private snapCbs: ((code: string, senderId: string, msgs: RoomMsg[]) => void)[] = [];
  private lastTyping = 0;

  constructor(appKey: string, area: string) {
    NCEngine.initialize({ appKey, areaCode: area === 'SG' ? AreaCode.SG : AreaCode.NA, logLevel: LogLevel.WARN });
    NCEngine.registerCustomMessages([
      ...Object.values(CUSTOM).map(messageType => ({ messageType, isPersisted: true, isCounted: !QUIET.has(messageType) })),
      { messageType: TYPING, isPersisted: false, isCounted: false, isStatusMessage: true },
      { messageType: SNAP, isPersisted: false, isCounted: false, isStatusMessage: true },
    ]);
    NCEngine.addConnectionStatusHandler('roomcode', new ConnectionStatusHandler({
      onConnectionStatusChanged: ({ status }) => {
        const s: Status = status === ConnectionStatus.CONNECTED ? 'connected' : status === ConnectionStatus.CONNECTING ? 'connecting' : 'offline';
        this.statusCbs.forEach(cb => cb(s));
      },
    }));
    NCEngine.addMessageHandler('roomcode', new MessageHandler({
      onMessageReceived: ({ messages }) => {
        for (const m of messages) {
          if (m.messageType === TYPING) { this.markTyping(codeFromGroupId(m.channelIdentifier.channelId), m.senderUserId); continue; }
          if (m.messageType === SNAP) {
            const list = (m.content as Record<string, any>).m;
            if (Array.isArray(list)) this.snapCbs.forEach(cb => cb(codeFromGroupId(m.channelIdentifier.channelId), m.senderUserId, list));
            continue;
          }
          const rm = toRoomMsg(m);
          if (rm) this.msgCbs.forEach(cb => cb(codeFromGroupId(m.channelIdentifier.channelId), rm));
        }
      },
    }));
    // Built-in translation: results arrive here, keyed by the message ID we asked about.
    NCEngine.addTranslateHandler('roomcode', new TranslateHandler({
      onTranslationCompleted: ({ results }) => {
        for (const r of results) {
          const done = this.pending.get(r.identifier);
          if (!done) continue;
          this.pending.delete(r.identifier);
          done(r.code === 0 && r.translateInfo?.translatedText ? r.translateInfo.translatedText : null);
        }
      },
    }));
  }

  private typing = new Map<string, Map<string, number>>();
  private markTyping(code: string, userId: string) {
    if (userId === this.userId) return;
    const room = this.typing.get(code) ?? new Map<string, number>();
    room.set(userId, Date.now());
    this.typing.set(code, room);
    const emit = () => {
      const now = Date.now();
      this.typingCbs.forEach(cb => cb(code, [...room].filter(([, t]) => now - t < 4000).map(([id]) => id)));
    };
    emit();
    setTimeout(emit, 4100);
  }

  async connect(device: string, name: string) {
    this.device = device; this.name = name;
    if (!this.token) ({ userId: this.userId, token: this.token } = await api<{ userId: string; token: string }>('session', { device, name }));
    const r = await NCEngine.connect({ token: this.token });
    if (!r.isOk) {
      this.token = ''; // token may have expired; next connect asks for a fresh one
      throw new Error(`Could not connect (code ${r.code}).`);
    }
    return this.userId;
  }

  async disconnect() { await NCEngine.disconnect(); }
  setName(name: string) { this.name = name; }

  createRoom(title: string) { return api<RoomInfo>('rooms', { device: this.device, title }); }
  joinRoom(code: string) { return api<RoomInfo>('join', { device: this.device, code }); }
  async moderate(code: string, action: 'remove' | 'close', userId?: string) {
    await api('moderate', { device: this.device, code, action, userId });
  }

  async translate(items: { id: string; text: string }[], lang: string) {
    const out = new Map<string, string>();
    for (let i = 0; i < items.length; i += 10) { // the SDK takes up to 10 per request
      const batch = items.slice(i, i + 10);
      const waits = batch.map(it => new Promise<string | null>(resolve => {
        this.pending.set(it.id, resolve);
        setTimeout(() => { if (this.pending.get(it.id) === resolve) { this.pending.delete(it.id); resolve(null); } }, 15000);
      }));
      const r = await NCEngine.translateModule.translateMessages({
        list: batch.map(it => new TranslateMessageParam(it.id, 'auto', lang, it.text)), force: false,
      });
      if (!r.isOk) {
        batch.forEach(it => { this.pending.get(it.id)?.(null); this.pending.delete(it.id); });
        throw new TranslationUnavailable(`code ${r.code}`);
      }
      (await Promise.all(waits)).forEach((t, j) => { if (t) out.set(batch[j].id, t); });
    }
    return out;
  }

  async history(code: string): Promise<RoomMsg[]> {
    const query = BaseChannel.createMessagesQuery({
      channelIdentifier: new GroupChannel(groupIdFor(code)).identifier, startTime: 0, pageSize: 100, isAscending: true,
    });
    const out: RoomMsg[] = [];
    for (let page = 0; page < 20; page++) { // cap: 2,000 messages per room
      const r = await query.loadNextPage();
      if (!r.isOk || !r.data) break;
      for (const m of r.data.data) { const rm = toRoomMsg(m); if (rm) out.push(rm); }
      if (r.data.data.length < 100) break;
    }
    return out;
  }

  async send(code: string, type: MsgType, body: Record<string, any>): Promise<RoomMsg> {
    const channel = new GroupChannel(groupIdFor(code));
    const params: SendMessageParams<any> = type === 'chat'
      ? new SendTextMessageParams({ text: String(body.text), senderUserInfo: { userId: this.userId, name: this.name } })
      : new SendMessageParams({ ...body, n: this.name }, CUSTOM[type]);
    if (type === 'vote' || type === 'pollvote' || type === 'join' || type === 'signal' || type === 'focus') params.disableNotification = true;
    const r = await channel.sendMessage(params);
    if (!r.isOk || !r.data) throw new Error(`Message not sent (code ${r.code}).`);
    return toRoomMsg(r.data)!;
  }

  sendTyping(code: string) {
    if (Date.now() - this.lastTyping < 3000) return;
    this.lastTyping = Date.now();
    void new GroupChannel(groupIdFor(code)).sendMessage(new SendMessageParams({}, TYPING));
  }

  sendSnapshot(code: string, msgs: RoomMsg[]) {
    void new GroupChannel(groupIdFor(code)).sendMessage(new SendMessageParams({ m: msgs }, SNAP));
  }
  onSnapshot(cb: (code: string, senderId: string, msgs: RoomMsg[]) => void) { this.snapCbs.push(cb); }
  onMessage(cb: (code: string, m: RoomMsg) => void) { this.msgCbs.push(cb); }
  onTyping(cb: (code: string, ids: string[]) => void) { this.typingCbs.push(cb); }
  onStatus(cb: (s: Status) => void) { this.statusCbs.push(cb); }
}
