// The room API: Azure Static Web Apps functions (src/index.js) and, locally, server/dev-api.mjs.
// The App Secret stays here, server-side. The browser only ever sees per-user tokens.
import { createHash, createHmac, randomInt } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const USER_ID = /^[A-Za-z0-9]{12,40}$/;
// Each browser keeps a random device secret; its chat user ID is derived from it here.
// Seeing someone's user ID in a message is then not enough to sign in as them.
export const DEVICE = /^[A-Za-z0-9]{24,64}$/;
export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{5}$/;

export const newCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const clip = (v, n) => String(v ?? '').trim().slice(0, n);

function config() {
  const appKey = process.env.NEXCONN_APP_KEY, secret = process.env.NEXCONN_APP_SECRET;
  const host = process.env.NEXCONN_API_HOST || 'api.sg-light-api.com';
  if (!appKey || !secret) throw Object.assign(new Error('Server is missing NEXCONN_APP_KEY / NEXCONN_APP_SECRET.'), { status: 500 });
  return { appKey, secret, hosts: [host, host.replace(/^api\./, 'api-b.')] };
}

// POST to the Nexconn Platform Chat API with the documented signature:
// Signature = sha1_hex(AppSecret + Nonce + Timestamp). Fails over to the backup domain.
export async function nexconn(path, body) {
  const { appKey, secret, hosts } = config();
  let lastErr;
  for (const host of hosts) {
    const nonce = String(randomInt(1e9)), timestamp = String(Date.now());
    const signature = createHash('sha1').update(secret + nonce + timestamp).digest('hex');
    try {
      const r = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: { 'App-Key': appKey, Nonce: nonce, Timestamp: timestamp, Signature: signature, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status >= 500) { lastErr = new Error(`Nexconn ${r.status}`); continue; }
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export const fail = (status, message) => Object.assign(new Error(message), { status });

// Runs one route on a parsed JSON body. Returns { status, body } for either host.
export async function run(fn, body) {
  try {
    return { status: 200, body: await fn(body || {}) };
  } catch (e) {
    if (!e.status) console.error(e);
    return { status: e.status || 502, body: { error: e.status ? e.message : 'Chat service unavailable. Try again.' } };
  }
}

export function userIdFor(device) {
  if (!DEVICE.test(String(device))) throw fail(400, 'Bad device ID.');
  return 'u' + createHmac('sha256', config().secret).update(`uid:${device}`).digest('hex').slice(0, 23);
}

// Issues a chat token for a guest. One device (one browser) is one Nexconn user.
export async function session({ device, name }) {
  const userId = userIdFor(device);
  const nick = clip(name, 24) || 'Guest';
  const j = await nexconn('/v4/auth/access-token/issue', { userId, name: nick });
  if (j.code !== 0 || !j.result?.accessToken) throw fail(502, `Token not issued (code ${j.code}).`);
  return { userId, token: j.result.accessToken };
}

// Creates a room: a group channel `rc<CODE>` owned by the host, open to join.
export async function rooms({ device, title }) {
  const userId = userIdFor(device);
  const name = clip(title, 60) || 'Untitled room';
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const j = await nexconn('/v4/group-channel/create', {
      channelId: `rc${code}`, name, owner: userId, permissions: { joinPerm: 1, memInvitePerm: 2 },
    });
    if (j.code === 0) return { code, title: name, ownerId: userId, createdAt: Date.now() };
    console.warn('group create failed', j.code, j.msg);
  }
  throw fail(502, 'Could not create the room. Try again.');
}

// Adds a guest to a room's group channel and returns the room's title and host.
async function joinAs(userId, code) {
  if (!ROOM_CODE.test(String(code))) throw fail(400, 'Room codes are 5 letters or digits.');
  const j = await nexconn('/v4/group-channel/join', { channelId: `rc${code}`, userIds: [userId] });
  if (j.code !== 0) throw fail(404, 'No room with that code.');
  const g = j.result ?? j;
  return { code, title: g.name || 'Room', ownerId: g.owner, createdAt: g.createdAt || Date.now(), memberCount: g.memberCount };
}
export const join = ({ device, code }) => joinAs(userIdFor(device), code);

// Host-only moderation, enforced by Nexconn itself (the room view also hides the posts):
// `remove` mutes a guest in this room for 24 hours; `close` freezes the room so nobody can post.
export async function moderate({ device, code, action, userId }) {
  const caller = userIdFor(device);
  const room = await joinAs(caller, code);
  if (room.ownerId !== caller) throw fail(403, 'Only the host can do that.');
  const channelId = `rc${code}`;
  let j;
  if (action === 'remove') {
    if (!USER_ID.test(String(userId)) || userId === caller) throw fail(400, 'Bad user ID.');
    j = await nexconn('/v4/group-channel/user/mute-list/add', { userIds: [userId], channelId, durationMinutes: 1440 });
  } else if (action === 'close') {
    j = await nexconn('/v4/group-channel/freeze-list/add', { channelIds: [channelId] });
  } else throw fail(400, 'Unknown action.');
  if (j.code !== 0) throw fail(502, `Moderation failed (code ${j.code}).`);
  return { ok: true };
}

export const routes = { session, rooms, join, moderate };
