import type { MsgType, RoomMsg } from '../state.ts';

export interface RoomInfo {
  code: string;
  title: string;
  ownerId: string;
  createdAt: number;
  memberCount?: number;
}

export type Status = 'connected' | 'connecting' | 'offline';

// The UI talks only to this interface. `NexconnBackend` is the real one;
// `MockBackend` runs fully offline (rooms shared across tabs of one browser).
export interface Backend {
  readonly kind: 'mock' | 'nexconn';
  connect(userId: string, name: string): Promise<void>;
  disconnect(): Promise<void>;
  createRoom(title: string): Promise<RoomInfo>;
  joinRoom(code: string): Promise<RoomInfo>;
  history(code: string): Promise<RoomMsg[]>;
  send(code: string, type: MsgType, body: Record<string, any>): Promise<RoomMsg>;
  sendTyping(code: string): void;
  onMessage(cb: (code: string, msg: RoomMsg) => void): void;
  onTyping(cb: (code: string, userIds: string[]) => void): void;
  onStatus(cb: (s: Status) => void): void;
}

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const groupIdFor = (code: string) => `rc${code}`;
export const codeFromGroupId = (id: string) => id.replace(/^rc/, '');
