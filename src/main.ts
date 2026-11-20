import './styles.css';
import qrcode from 'qrcode-generator';
import { MockBackend } from './backend/mock.ts';
import { clean } from './filter.ts';
import { normalizeCode, type Backend, type RoomInfo, type Status } from './backend/types.ts';
import {
  build, apply, rankedQuestions, pollTally, latestOpenPoll, recap, summarize, lookalikes, changedMinds, LIMITS,
  type RoomState, type RoomMsg, type Question, type Poll,
} from './state.ts';

// ---------- identity: one random device secret per browser, nickname only ----------
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
// `?tab` gives each browser tab its own guest (for demos and two-window testing).
const perTab = new URLSearchParams(location.search).has('tab');
if (perTab) {
  store.get = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  store.set = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } };
}
// The server derives the chat user ID from this secret, so nobody can sign in as
// someone else just by reading their user ID off a message.
function deviceSecret(): string {
  let id = store.get('roomcode:device');
  if (!id) {
    const a = new Uint8Array(32); crypto.getRandomValues(a);
    id = Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    store.set('roomcode:device', id);
  }
  return id;
}
const DEVICE = deviceSecret();
let ME = store.get('roomcode:me') || ''; // known after the first connect
const ADJ = ['Quiet', 'Bright', 'Swift', 'Curious', 'Calm', 'Bold', 'Lucky', 'Clever', 'Sunny', 'Brave'];
const ANIMAL = ['Otter', 'Falcon', 'Panda', 'Fox', 'Heron', 'Lynx', 'Koala', 'Orca', 'Wren', 'Badger'];
const suggestName = () => `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${ANIMAL[Math.floor(Math.random() * ANIMAL.length)]}`;
let myName = store.get('roomcode:name') || '';
// Larger text: one switch in the room menu, remembered on this device.
if (store.get('roomcode:big') === '1') document.documentElement.classList.add('big');

// ---------- backend: real Nexconn when an App Key is configured, else offline mock ----------
const APP_KEY = import.meta.env.VITE_NEXCONN_APP_KEY as string | undefined;
const forceMock = new URLSearchParams(location.search).has('mock');
let backend: Backend;
async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (APP_KEY && !forceMock) {
    const { NexconnBackend } = await import('./backend/nexconn.ts');
    backend = new NexconnBackend(APP_KEY, (import.meta.env.VITE_NEXCONN_AREA as string) || 'SG');
  } else backend = new MockBackend();
  backend.onStatus(onStatus);
  backend.onMessage(onIncoming);
  backend.onSnapshot(onSnapshot);
  backend.onTyping((code, ids) => { if (room && code === room.info.code) { typingIds = ids; renderTyping(); } });
  return backend;
}
let status: Status = 'offline';
let connected = false;
async function ensureConnected() {
  const b = await getBackend();
  if (!connected) {
    ME = await b.connect(DEVICE, myName || 'Guest'); connected = true;
    store.set('roomcode:me', ME);
  }
  return b;
}

// ---------- tiny DOM helpers ----------
const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// For anything people typed: escaped, with offensive words masked.
const txt = (s: unknown) => esc(clean(String(s ?? '')));
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const joinUrl = (code: string) => `${location.origin}${location.pathname}#/r/${code}`;
function qrSvg(text: string) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
function toast(text: string) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};
const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 6-6 6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-7"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17h.01"/></svg>',
};

// ---------- sheets (modals) ----------
function sheet(html: string, onMount?: (el: HTMLElement, close: () => void) => void, dismissable = true) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) close(); };
  scrim.addEventListener('click', e => { if ((e.target === scrim && dismissable) || (e.target as HTMLElement).closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  onMount?.(scrim.querySelector('.sheet')!, close);
  ($<HTMLInputElement>('input, textarea', scrim))?.focus();
  return close;
}

function askName(): Promise<void> {
  return new Promise(resolve => {
    const suggestion = myName || suggestName();
    sheet(`
      <h2>What should the room call you?</h2>
      <p class="muted">Only this nickname is shared. No email, no account.</p>
      <form id="nf"><input class="field" id="nick" maxlength="${LIMITS.name}" value="${esc(suggestion)}" autocomplete="nickname" aria-label="Nickname" />
      <div class="row"><button class="btn accent block" type="submit">Save</button></div></form>`,
      (el, close) => {
        const input = $<HTMLInputElement>('#nick', el)!; input.select();
        $<HTMLFormElement>('#nf', el)!.onsubmit = e => {
          e.preventDefault();
          myName = input.value.trim().slice(0, LIMITS.name) || suggestion;
          store.set('roomcode:name', myName);
          backend?.setName(myName);
          if (room) room.state.people.set(ME, myName);
          close(); resolve();
        };
      });
  });
}

// ---------- home ----------
function renderHome(prefill = '', error = '') {
  room = null;
  document.title = 'Roomcode';
  app.innerHTML = `
  <div class="home-wrap">
  <main class="home">
    <div class="logo"><span class="logo-mark"><i></i><i></i><i></i><i></i></span>Roomcode</div>
    <h1>Hear from <em>the whole room</em>, not just the loudest voice.</h1>
    <p class="lede">Show a QR. Everyone asks, votes and answers polls from their phone, in their own language, with or without their name. No app, no account.</p>
    <form id="jf">
      <input class="code-input" id="code" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false"
        maxlength="5" placeholder="CODE" value="${esc(prefill)}" aria-label="Room code" />
      <p class="err" id="jerr" role="alert">${esc(error)}</p>
      <button class="btn block" id="joinBtn" type="submit">Join room</button>
    </form>
    <div class="or">or</div>
    <button class="btn accent block" id="startBtn">Start a room</button>
    <ol class="how">
      <li><b>1</b><span><strong>Start a room</strong> for your class, club meeting or event.</span></li>
      <li><b>2</b><span><strong>Show the QR</strong> on the board. Everyone joins from their phone in seconds.</span></li>
      <li><b>3</b><span><strong>Everyone gets a voice.</strong> The best questions get voted to the top, polls show what the room thinks, and one quiet tap tells you who is lost.</span></li>
    </ol>
    <p class="foot"><a href="#/r/${FEEDBACK_CODE}">Ideas or problems? Tell us in room ${FEEDBACK_CODE}</a><br/>Built on the Nexconn Chat SDK. <span class="mode-pill">${APP_KEY && !forceMock ? 'Live' : 'Offline demo: rooms are shared between tabs of this browser'}</span></p>
  </main>
  <aside class="home-art" aria-hidden="true">
    <div class="art-card"><div class="now">Answering now</div><b>Why do cells need mitochondria if they already have a nucleus?</b><small>▲ 14 · Anonymous</small></div>
    <div class="art-card"><span class="tag q">Second take</span><b>Where is most ATP made?</b>
      <div class="art-bar"><i style="width:82%"></i><span>In the mitochondria</span><span><s>54%</s> 82%</span></div>
      <div class="art-bar"><i style="width:18%"></i><span>In the nucleus</span><span><s>46%</s> 18%</span></div>
      <div class="moved"><b>8</b> of 28 changed their mind</div></div>
    <div class="art-card lost-meter on"><div class="lm-row"><span>${ICON.hand}<b>4 people lost</b></span></div><div class="lm-bar"><i style="width:15%"></i></div><p class="muted small">One private tap. The host sees the count, never names.</p></div>
    <p class="art-note">What a room looks like (example)</p>
  </aside>
  </div>`;
  const code = $<HTMLInputElement>('#code')!;
  code.oninput = () => { code.value = normalizeCode(code.value); };
  $<HTMLFormElement>('#jf')!.onsubmit = e => {
    e.preventDefault();
    const c = normalizeCode(code.value);
    if (c.length !== 5) { $('#jerr')!.textContent = 'Room codes have 5 letters or digits.'; return; }
    location.hash = `#/r/${c}`;
  };
  $('#startBtn')!.onclick = startRoomFlow;
}

function startRoomFlow() {
  sheet(`
    <h2>Start a room</h2>
    <p class="muted">Give it a name people will recognise.</p>
    <form id="sf"><input class="field" id="title" maxlength="${LIMITS.title}" placeholder="e.g. Period 3 Econ · Q&amp;A" aria-label="Room name" />
    <p class="err" id="serr" role="alert"></p>
    <div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="submit" id="sgo">Create</button></div></form>`,
    (el, close) => {
      $<HTMLFormElement>('#sf', el)!.onsubmit = async e => {
        e.preventDefault();
        const btn = $<HTMLButtonElement>('#sgo', el)!; btn.disabled = true; btn.textContent = 'Creating…';
        try {
          if (!myName) { myName = suggestName(); store.set('roomcode:name', myName); }
          const b = await ensureConnected();
          const info = await b.createRoom($<HTMLInputElement>('#title', el)!.value.trim() || 'Untitled room');
          close();
          location.hash = `#/r/${info.code}`;
          setTimeout(() => showShare(info.code), 300);
        } catch (err) {
          $('#serr', el)!.textContent = (err as Error).message; btn.disabled = false; btn.textContent = 'Create';
        }
      };
    });
}

// ---------- room ----------
type Tab = 'chat' | 'questions' | 'poll' | 'recap';
interface Room { info: RoomInfo; state: RoomState; msgs: RoomMsg[]; tab: Tab; anon: boolean; }
let room: Room | null = null;
let typingIds: string[] = [];
const isHost = () => !!room && room.info.ownerId === ME;
const ROOM_TTL = 24 * 3600 * 1000;
// The public feedback room never closes.
const FEEDBACK_CODE = 'FEEDB';

async function openRoom(code: string, screen: boolean) {
  app.innerHTML = `<div class="empty" style="padding-top:30vh"><b>Joining ${esc(code)}…</b></div>`;
  try {
    // No name prompt: a guest gets a friendly nickname and can change it from the room.
    if (!screen && !myName) { myName = suggestName(); store.set('roomcode:name', myName); }
    const b = await ensureConnected();
    const info = await b.joinRoom(code);
    const msgs = await b.history(code);
    room = { info, msgs, state: build(info.ownerId, msgs), tab: 'questions', anon: false };
    if (!screen) room.state.people.set(ME, myName);
    if (Date.now() - info.createdAt > ROOM_TTL && code !== FEEDBACK_CODE) room.state.closed = true;
    if (room.state.closed) room.tab = 'recap';
    if (code === FEEDBACK_CODE) room.tab = 'chat';
    document.title = `${info.title} · Roomcode`;
    screen ? renderScreen() : renderRoom();
    // Say hello once per room, so everyone sees who arrived and the count is live.
    const seenKey = `roomcode:joined:${code}`;
    if (!screen && !room.state.closed && !store.get(seenKey)) {
      store.set(seenKey, '1');
      sendAndApply('join', {}).catch(() => store.set(seenKey, ''));
    }
  } catch (err) {
    renderHome(code, (err as Error).message);
  }
}

function onIncoming(code: string, m: RoomMsg) {
  if (!room || room.info.code !== code || room.msgs.some(x => x.id === m.id)) return;
  room.msgs.push(m);
  const before = room.state.feed.length, wasClosed = room.state.closed;
  apply(room.state, m);
  typingIds = typingIds.filter(id => id !== m.senderId);
  if (m.type === 'join' && m.senderId !== ME && isHost()) queueSnapshot();
  if ($('.screen')) return renderScreen();
  if (room.state.closed && !wasClosed) { room.tab = 'recap'; return renderRoom(); } // everyone lands on the recap
  renderLive(room.state.feed.length > before && m.senderId !== ME);
}

// ---------- snapshots for late joiners ----------
// New group members may not be able to read history from before they joined (a
// Nexconn console setting). So when someone new joins, the host's open screen (phone
// or projector) sends the room so far as one transient message.
const MSG_TYPES = new Set(['chat', 'question', 'vote', 'answered', 'poll', 'pollvote', 'pin', 'close', 'join', 'hide', 'remove', 'focus', 'signal']);
let snapTimer: number | undefined;
function queueSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = window.setTimeout(() => {
    if (!room || !isHost()) return;
    const code = room.info.code;
    // Everything except chat, plus the latest chat, kept under ~60 KB.
    const keep = room.msgs.filter(m => m.type !== 'chat');
    const chat = room.msgs.filter(m => m.type === 'chat');
    let n = Math.min(chat.length, 60), list: RoomMsg[];
    do { list = [...keep, ...chat.slice(chat.length - n)]; n = Math.floor(n / 2); } while (JSON.stringify(list).length > 60_000 && n > 0);
    if (JSON.stringify(list).length > 60_000) list = keep.slice(-300);
    backend.sendSnapshot(code, list);
  }, 1500);
}

function onSnapshot(code: string, senderId: string, list: RoomMsg[]) {
  if (!room || room.info.code !== code || senderId !== room.info.ownerId) return; // only the host's snapshot counts
  const have = new Set(room.msgs.map(m => m.id));
  const fresh = list.filter(m => m && typeof m.id === 'string' && !have.has(m.id) && MSG_TYPES.has(m.type) &&
    typeof m.senderId === 'string' && typeof m.sentTime === 'number' && m.body && typeof m.body === 'object');
  if (!fresh.length) return;
  room.msgs.push(...fresh);
  room.state = build(room.info.ownerId, room.msgs);
  if (!$('.screen')) room.state.people.set(ME, myName);
  if (Date.now() - room.info.createdAt > ROOM_TTL && code !== FEEDBACK_CODE) room.state.closed = true;
  if (room.state.closed && room.tab !== 'recap' && !$('#box')?.matches(':focus')) room.tab = 'recap';
  $('.screen') ? renderScreen() : renderRoom();
}

// People who have said hello in this room (the projector tab is not a person).
const peopleCount = () => room ? Math.max(room.state.people.size, 1) : 0;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const wide = () => matchMedia('(min-width: 980px)').matches;

// ---------- connection: a calm banner, and a catch-up after every reconnect ----------
let wasOnline = false;
let bannerTimer: number | undefined;
function onStatus(s: Status) {
  const back = s === 'connected' && status !== 'connected' && wasOnline;
  status = s;
  if (s === 'connected') wasOnline = true;
  renderTop();
  clearTimeout(bannerTimer);
  // Wait a moment before saying anything: most drops heal by themselves.
  bannerTimer = window.setTimeout(renderBanner, s === 'connected' ? 0 : 1500);
  if (back && room && connected) void catchUp();
}
function renderBanner() {
  const el = $('#banner'); if (!el) return;
  el.innerHTML = wasOnline && status !== 'connected'
    ? `<div class="banner" role="status">${status === 'connecting' ? 'Reconnecting…' : 'You are offline.'} Posts will show up again when you are back.</div>` : '';
}
async function catchUp() {
  if (!room) return;
  try {
    const msgs = await backend.history(room.info.code);
    const have = new Set(room.msgs.map(m => m.id));
    const fresh = msgs.filter(m => !have.has(m.id));
    if (!fresh.length) return;
    room.msgs.push(...fresh);
    room.state = build(room.info.ownerId, room.msgs);
    if (!$('.screen')) room.state.people.set(ME, myName);
    if ($('.screen')) renderScreen(); else renderLive(false);
  } catch { /* the next message or reconnect will try again */ }
}

function renderRoom() {
  const host = isHost();
  app.innerHTML = `
  <div class="room${host ? ' hosting' : ''}">
    ${host ? '<aside class="dash" id="dash" aria-label="Host controls"></aside>' : ''}
    <div class="col">
      <header class="top" id="top"></header>
      <div id="banner"></div>
      <div id="pin"></div>
      <nav class="tabs" id="tabs" role="tablist"></nav>
      <section class="pane" id="pane" aria-live="polite"></section>
      <div class="typing" id="typing"></div>
      <footer id="composer"></footer>
    </div>
  </div>`;
  renderBanner(); renderLive(true, true);
  if (matchMedia('(pointer: fine)').matches) $<HTMLTextAreaElement>('#box')?.focus();
}

// Re-renders every live part of the room; the composer keeps what the user is typing.
function renderLive(stickToBottom: boolean, fullComposer = false) {
  renderTop(); renderDash(); renderPin(); renderTabs(); renderPane(stickToBottom); renderTyping(); renderComposer(fullComposer);
}

function renderTop() {
  const el = $('#top'); if (!el || !room) return;
  const n = peopleCount();
  el.innerHTML = `
    <a class="icon-btn" href="#/" aria-label="Leave room">${ICON.back}</a>
    <div class="title"><b>${txt(room.info.title)}</b>
      <small><span class="dot ${room.state.closed ? 'offline' : status}"></span><span>${room.state.closed ? `Ended · ${plural(n, 'person', 'people')}` : status === 'connected' ? plural(n, 'person', 'people') : status === 'connecting' ? 'Connecting…' : 'Offline'}${isHost() ? ' · you host' : ''}</span></small></div>
    <button class="code-chip" data-act="share" aria-label="Show join code">${esc(room.info.code)}</button>
    <button class="icon-btn" data-act="menu" aria-label="Room menu">${ICON.more}</button>`;
}

// The host's side panel on a laptop: the join code, the room's numbers and every control in one place.
function renderDash() {
  const el = $('#dash'); if (!el || !room) return;
  const s = room.state, r = summarize(s), closed = s.closed, lost = s.lost.size, n = peopleCount();
  const key = `${room.info.code}|${closed}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = `
      <div class="dash-card join-card">
        <span class="tag q">You host this room</span>
        <div class="dash-qr">${qrSvg(joinUrl(room.info.code))}</div>
        <div class="dash-code">${esc(room.info.code)}</div>
    
        <div class="row"><button class="btn ghost small" data-act="copylink">Copy link</button><button class="btn small" data-act="screen">Projector view</button></div>
      </div>
      <div class="dash-card"><dl class="stats" id="dstats"></dl><div id="dlost"></div></div>
      <div class="dash-card dash-actions">
        ${closed ? '' : '<button class="btn accent block" data-act="newpoll">Start a poll</button><button class="btn ghost block" data-act="pinmsg">Pin an announcement</button>'}
        <button class="btn ghost block" data-act="recap">Copy recap</button>
        ${closed ? '<button class="btn accent block" data-act="startown">Start a new room</button>' : '<button class="btn ghost block danger" data-act="end">End room for everyone</button>'}
      </div>
      <p class="muted small dash-tip">Tap ••• on any post to hide it or remove the person. <a href="./guide.html" target="_blank" rel="noopener">One-page guide</a></p>`;
  }
  $('#dstats', el)!.innerHTML = ([['People', n], ['Open', r.open], ['Answered', r.answered], ['Upvotes', r.votes]] as [string, number][])
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#dlost', el)!.innerHTML = closed ? '' : lostMeter(lost, n);
}

// "I'm lost": how many people privately said they are not following. Counted, never named.
function lostMeter(lost: number, people: number) {
  const guests = Math.max(1, people - 1), pct = Math.min(100, Math.round(lost * 100 / guests));
  return `<div class="lost-meter${lost ? ' on' : ''}"><div class="lm-row"><span>${ICON.hand}<b>${lost ? `${plural(lost, 'person', 'people')} lost` : 'Nobody is lost'}</b></span>
      ${lost ? '<button class="link-btn" data-act="clearlost">Clear after re-explaining</button>' : ''}</div>
    <div class="lm-bar"><i style="width:${pct}%"></i></div>
    <p class="muted small">${lost ? 'No names are shown. Slow down or take a question.' : 'Guests can tap “I’m lost” privately. Only you see the count.'}</p></div>`;
}

function renderPin() {
  const el = $('#pin'); if (!el || !room) return;
  const lost = room.state.lost.size;
  // On a phone the host sees the "lost" count as a strip under the header (the laptop dashboard has its own meter).
  el.innerHTML = (isHost() && lost && !room.state.closed ? `<button class="lost-strip" data-act="lost">${ICON.hand}<b>${plural(lost, 'person', 'people')} lost</b><span>No names. Tap for details</span></button>` : '') +
    (room.state.pin ? `<div class="pin">${ICON.pin}<span>${txt(room.state.pin)}</span></div>` : '');
}

function renderTabs() {
  const el = $('#tabs'); if (!el || !room) return;
  const open = [...room.state.questions.values()].filter(q => !q.answered).length;
  const poll = latestOpenPoll(room.state);
  const voted = poll?.votes.has(ME);
  const tab = (id: Tab, label: string, badge = '') =>
    `<button class="tab" role="tab" data-tab="${id}" aria-selected="${room!.tab === id}">${label}${badge}</button>`;
  el.innerHTML = (room.state.closed ? tab('recap', 'Recap') : '') +
    tab('questions', 'Questions', open ? ` <span class="badge">${open}</span>` : '') +
    tab('chat', 'Chat') +
    tab('poll', 'Polls', poll && !voted && !room.state.closed ? ' <span class="badge">1</span>' : '');
}

function questionCard(q: Question, rank = -1) {
  const mine = q.voters.has(ME), s = room!.state;
  const name = q.anonymous ? 'Anonymous' : txt(q.authorName);
  const focus = s.focus === q.id;
  const hostCtl = isHost() && !s.closed ? `<div class="qctl">
      ${q.answered ? `<button class="chip-btn" data-answer="${esc(q.id)}" data-val="false">Reopen</button>`
        : focus ? `<button class="chip-btn primary" data-answer="${esc(q.id)}" data-val="true">Done, next</button><button class="chip-btn" data-focus="">Stop</button>`
        : `<button class="chip-btn dark" data-focus="${esc(q.id)}">Answer now</button><button class="chip-btn" data-answer="${esc(q.id)}" data-val="true">Answered</button>`}
      ${q.answered ? '' : `<button class="chip-btn" data-tovote="${esc(q.id)}" title="Turn this question into a Yes / No / Not sure poll">Poll it</button>`}${modBtn(q.id, q.authorId)}</div>` : '';
  return `<article class="qcard${q.answered ? ' answered' : ''}${focus ? ' focus' : rank === 0 && !q.answered && q.voters.size > 1 ? ' top1' : ''}">
    <button class="vote" data-vote="${esc(q.id)}" aria-pressed="${mine}" aria-label="Upvote, ${q.voters.size} votes" ${s.closed ? 'disabled' : ''}>${ICON.up}${q.voters.size}</button>
    <div class="qbody">${focus ? '<div class="now">Answering now</div>' : ''}<div class="qtext">${txt(q.text)}</div>${trLine(q.id)}
      <div class="qmeta">${q.answered ? '<span class="tag ok">Answered</span>' : ''}<span>${name} · ${ago(q.sentTime)}${q.authorId === ME ? ' · you' : ''}</span></div>${hostCtl}</div>
  </article>`;
}

// Each option's share in the first round of a second-take poll.
function pollWas(p: Poll): number[] {
  const c = p.options.map(() => 0);
  for (const i of p.round1!.values()) c[i]++;
  const t = p.round1!.size;
  return c.map(n => (t ? Math.round(n * 100 / t) : 0));
}

function pollCard(p: Poll) {
  const { counts, total } = pollTally(p);
  const mine = p.votes.get(ME);
  const over = p.closed || room!.state.closed;
  const showResults = mine !== undefined || over || isHost();
  const was = p.round1 ? pollWas(p) : null;
  const moved = changedMinds(p), second = !!p.round1;
  const first = p.round1?.get(ME);
  return `<article class="poll"><span class="tag ${over ? '' : 'q'}">${over ? 'Final result' : second ? 'Second take' : 'Live poll'}</span><h3>${txt(p.question)}</h3>${trLine(p.id)}
    ${second && !over && first !== undefined && !isHost() ? `<p class="retake">${mine !== undefined && mine !== first ? `First you said <b>${txt(p.options[first])}</b>. Now <b>${txt(p.options[mine])}</b>.` : `You said <b>${txt(p.options[first])}</b>. Still think so? Tap another to change.`}</p>` : ''}
    ${p.options.map((o, i) => {
      const pct = total ? Math.round(counts[i] * 100 / total) : 0;
      return `<button class="opt${mine === i ? ' mine' : ''}" data-poll="${esc(p.id)}" data-opt="${i}" ${over ? 'disabled' : ''}>
        <div class="fill" style="width:${showResults ? pct : 0}%"></div>${was && showResults ? `<i class="was" style="left:${was[i]}%" title="First answer: ${was[i]}%"></i>` : ''}<span><span>${txt(o)}</span>${showResults ? `<span>${was && was[i] !== pct ? `<s>${was[i]}%</s> ` : ''}${pct}%</span>` : ''}</span></button>`;
    }).join('')}
    <div class="foot-note"><span>${plural(total, 'vote')}${over ? '' : mine === undefined ? ' · tap to vote' : ' · tap another to change'}</span>
    ${isHost() && !over ? `<span class="pctl">${!second && total ? `<button class="link-btn" data-retake="${esc(p.id)}" title="After you have discussed it, let everyone answer again and see who moved">Ask again</button>` : ''}<button class="link-btn" data-closepoll="${esc(p.id)}">Close poll</button></span>` : ''}</div>
    ${second ? `<div class="moved"><b>${moved}</b> of ${p.round1!.size} changed their mind</div>` : ''}</article>`;
}

// The recap everyone lands on when the room ends: the numbers, what the room most wanted, poll results.
function recapView() {
  const s = room!.state, r = summarize(s);
  const stats = ([['People', r.people], ['Questions', r.asked], ['Answered', r.answered], ['Upvotes', r.votes]] as [string, number][])
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const groups = r.groups.slice(0, 8).map(g => `<li><span class="rv">${g.votes}</span><div><b>${txt(g.lead.text)}</b>
      <small>${g.lead.answered ? '<span class="tag ok">Answered</span>' : '<span class="tag">Still open</span>'}${g.others.length ? ` asked ${g.others.length + 1} ways` : ''}</small>
      ${g.others.map(o => `<p class="also">also: ${txt(o.text)}</p>`).join('')}</div></li>`).join('');
  return `<article class="recap">
    <span class="tag">Recap${r.minutes ? ` · ran ${r.minutes} min` : ''}</span><h2>${txt(room!.info.title)}</h2>
    <dl class="stats">${stats}</dl>
    ${groups ? `<h3>Most wanted</h3><ol class="rlist">${groups}</ol>` : '<p class="muted">No questions were asked in this room.</p>'}
    ${r.polls.length ? '<h3>Polls</h3>' + r.polls.map(p => pollCard(p.poll)).join('') : ''}
    <div class="row"><button class="btn" data-act="recap">Copy recap</button><button class="btn ghost" data-act="dlrecap">Download</button></div>
  </article>`;
}

function renderPane(stickToBottom: boolean) {
  const el = $('#pane'); if (!el || !room) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const s = room.state;
  let html = '';
  if (room.tab === 'recap') {
    html = recapView();
  } else if (room.tab === 'chat') {
    let prev = '';
    const feed = s.feed.filter(m => m.type === 'chat' || m.type === 'join');
    for (let i = 0; i < feed.length; i++) {
      const m = feed[i];
      if (m.type === 'join') {
        const names: string[] = [];
        while (i < feed.length && feed[i].type === 'join') { names.push(feed[i].senderId === ME ? 'You' : feed[i].senderName || 'Guest'); i++; }
        i--;
        const shown = names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : names.join(names.length === 2 ? ' and ' : ', ');
        html += `<div class="sys">${txt(shown)} joined</div>`;
        prev = '';
        continue;
      }
      const me = m.senderId === ME, cont = prev === m.senderId;
      const host = m.senderId === s.ownerId ? ' <span class="host">· host</span>' : '';
      html += `<div class="msg${me ? ' me' : ''}${cont ? ' cont' : ''}"><div class="who">${me ? 'You' : txt(m.senderName)}${host}</div><div class="brow"><div class="bubble">${txt(m.body.text)}${trLine(m.id)}</div>${modBtn(m.id, m.senderId)}</div></div>`;
      prev = m.senderId;
    }
    if (!feed.some(m => m.type === 'chat')) html += `<div class="empty"><b>Side chat</b>${s.removed.has(ME) ? 'You can still read along.' : 'Say hi, share a link, react to the talk. Questions go in the Questions tab so the room can vote on them.'}</div>`;
  } else if (room.tab === 'questions') {
    const qs = rankedQuestions(s);
    html = qs.length ? qs.map((q, i) => questionCard(q, i)).join('')
      : isHost() && !s.closed && !wide() ? hostGuide(true)
      : `<div class="empty"><b>${s.closed ? 'No questions were asked.' : 'Ask the first question'}</b>${s.closed ? '' : isHost() ? 'Questions appear here as people ask. The room votes the best ones to the top.' : 'Type it in the box below. The room votes the best ones to the top, and you can hide your name.'}</div>`;
  } else {
    const polls = [...s.polls.values()].sort((a, b) => b.sentTime - a.sentTime);
    html = (isHost() && !s.closed ? `<button class="btn accent block" data-act="newpoll" style="margin:4px 0 6px">New poll</button>` : '') +
      (polls.length ? polls.map(pollCard).join('') : `<div class="empty"><b>No polls yet.</b>${isHost() ? 'Ask the room a quick question with 2 to 6 answers.' : 'When the host starts one, it shows up here.'}</div>`);
  }
  el.innerHTML = html;
  if (room.tab === 'chat' && (stickToBottom || nearBottom)) el.scrollTop = el.scrollHeight;
  queueTranslations();
}

function renderTyping() {
  const el = $('#typing'); if (!el || !room) return;
  const names = room.tab === 'chat' ? typingIds.map(id => clean(room!.state.people.get(id) || 'Someone')).slice(0, 2) : [];
  el.textContent = names.length ? `${names.join(' and ')}${typingIds.length > 2 ? ' and others' : ''} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}

// Voice-to-text for questions and messages, where the browser offers it.
const Speech: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let listening: any = null;
function toggleDictation(box: HTMLTextAreaElement, btn: HTMLElement) {
  if (listening) { listening.stop(); return; }
  const rec = new Speech();
  rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
  const before = box.value ? box.value.replace(/\s*$/, ' ') : '';
  rec.onresult = (e: any) => {
    box.value = (before + Array.from(e.results as ArrayLike<any>).map(r => r[0].transcript).join('')).slice(0, box.maxLength);
    box.dispatchEvent(new Event('input'));
  };
  rec.onerror = (e: any) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow the microphone to speak your question'); };
  rec.onend = () => { listening = null; btn.setAttribute('aria-pressed', 'false'); box.focus(); };
  try { rec.start(); listening = rec; btn.setAttribute('aria-pressed', 'true'); toast('Listening… speak now'); } catch { listening = null; }
}

let composerKey = '';
function renderComposer(full: boolean) {
  const el = $('#composer'); if (!el || !room) return;
  const s = room.state;
  if (s.closed) {
    composerKey = 'closed';
    el.innerHTML = `<div class="closed-bar"><p>This room has ended.${isHost() ? '' : ' Thanks for joining.'}</p>
      <button class="btn accent block" data-act="startown">${isHost() ? 'Start a new room' : 'Run your own room. It takes 10 seconds'}</button></div>`;
    return;
  }
  if (s.removed.has(ME)) {
    composerKey = 'removed';
    el.innerHTML = `<div class="closed-bar"><p>The host removed you from this room.</p></div>`;
    return;
  }
  if (room.tab === 'poll' || room.tab === 'recap') { composerKey = room.tab; el.innerHTML = ''; return; }
  const q = room.tab === 'questions';
  const key = `${room.tab}|${myName}|${s.lost.has(ME)}`;
  if (!full && key === composerKey && $('#box', el)) return; // keep what the user is typing
  const draft = key.split('|')[0] === composerKey.split('|')[0] ? $<HTMLTextAreaElement>('#box', el)?.value ?? '' : '';
  const hadFocus = !!$('#box', el)?.matches(':focus');
  composerKey = key;
  const lost = s.lost.has(ME);
  el.innerHTML = `<div class="composer">
    <div id="dupes"></div>
    <div class="who-row"><span>Posting as <button class="link-btn" data-act="rename">${txt(myName)}</button></span>
      ${q ? `<label class="anon"><input type="checkbox" id="anon" ${room.anon ? 'checked' : ''}/> Hide my name</label>` : ''}
      ${!isHost() ? `<button class="lost-btn" data-act="imlost" aria-pressed="${lost}" title="Only the host sees how many people tapped this. No names.">${ICON.hand}${lost ? 'You said: lost' : 'I’m lost'}</button>` : ''}</div>
    <form class="compose-row" id="cf">
      <textarea id="box" rows="1" maxlength="${q ? LIMITS.question : LIMITS.chat}" placeholder="${q ? 'Ask the room a question…' : 'Message the room…'}" aria-label="${q ? 'Your question' : 'Message'}"></textarea>
      ${Speech ? `<button class="mic" id="micBtn" type="button" aria-pressed="false" aria-label="Speak instead of typing">${ICON.mic}</button>` : ''}
      <button class="send" id="sendBtn" type="submit" aria-label="${q ? 'Ask' : 'Send'}" disabled>${q ? 'Ask' : ICON.send}</button>
    </form></div>`;
  const box = $<HTMLTextAreaElement>('#box', el)!, send = $<HTMLButtonElement>('#sendBtn', el)!;
  const grow = () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 140) + 'px'; send.disabled = !box.value.trim(); };
  const dupes = () => {
    const d = $('#dupes', el)!;
    const similar = q ? lookalikes(room!.state, box.value).filter(x => x.authorId !== ME && !x.voters.has(ME)) : [];
    d.innerHTML = similar.length ? `<div class="dupes"><b>Already asked? Vote for it instead.</b>${similar.map(x =>
      `<button type="button" data-dupe="${esc(x.id)}"><span>${txt(x.text)}</span><i>${ICON.up}${x.voters.size}</i></button>`).join('')}</div>` : '';
  };
  box.oninput = () => { grow(); dupes(); if (box.value.trim() && !q) backend.sendTyping(room!.info.code); };
  box.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $<HTMLFormElement>('#cf', el)!.requestSubmit(); } };
  $<HTMLInputElement>('#anon', el)?.addEventListener('change', e => { room!.anon = (e.target as HTMLInputElement).checked; });
  const mic = $('#micBtn', el); if (mic) mic.onclick = () => toggleDictation(box, mic);
  $('#dupes', el)!.addEventListener('click', async e => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-dupe]')?.dataset.dupe; if (!id) return;
    box.value = ''; grow(); dupes();
    try { await sendAndApply('vote', { qid: id, up: true }); toast('Voted for it instead. Good call.'); } catch (err) { toast((err as Error).message); }
  });
  $<HTMLFormElement>('#cf', el)!.onsubmit = async e => {
    e.preventDefault();
    const text = box.value.trim(); if (!text || !room) return;
    box.value = ''; grow(); dupes();
    try {
      await sendAndApply(q ? 'question' : 'chat', q ? { text, anonymous: room.anon } : { text });
      if (q) toast('Asked. The room can vote it up.');
    } catch (err) { box.value = text; grow(); toast((err as Error).message); }
    box.focus();
  };
  if (draft) { box.value = draft; grow(); dupes(); }
  if (hadFocus) box.focus();
}

async function sendAndApply(type: RoomMsg['type'], body: Record<string, any>) {
  if (!room) return;
  const code = room.info.code;
  const m = await backend.send(code, type, body);
  onIncoming(code, m);
}

async function endRoom() {
  if (!room || !confirm('End this room? Nobody will be able to post after this, and everyone sees the recap.')) return;
  await sendAndApply('close', {}).catch(err => toast(err.message));
  backend.moderate(room.info.code, 'close').catch(() => { /* the room view already ignores later posts */ });
}

// One delegated click handler for the whole room view.
app.addEventListener('click', async e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tab],[data-focus],[data-tovote],[data-retake],[data-vote],[data-answer],[data-poll],[data-closepoll],[data-mod]');
  if (!t || !room) return;
  const d = t.dataset;
  try {
    if (d.tab) { room.tab = d.tab as Tab; renderTabs(); renderPane(true); renderTyping(); renderComposer(false); }
    else if (d.focus !== undefined) { await sendAndApply('focus', { qid: d.focus }); }
    else if (d.tovote) {
      const q = room.state.questions.get(d.tovote); if (!q) return;
      await sendAndApply('poll', { question: q.text.slice(0, LIMITS.pollQuestion), options: ['Yes', 'No', 'Not sure'] });
      room.tab = 'poll'; renderLive(true); toast('Poll started from the question');
    }
    else if (d.retake) { await sendAndApply('poll', { retake: d.retake }); toast('Second take: everyone can answer again'); }
    else if (d.vote) { const q = room.state.questions.get(d.vote)!; await sendAndApply('vote', { qid: d.vote, up: !q.voters.has(ME) }); }
    else if (d.answer) { await sendAndApply('answered', { qid: d.answer, answered: d.val === 'true' }); }
    else if (d.poll) { await sendAndApply('pollvote', { pollId: d.poll, option: Number(d.opt) }); }
    else if (d.closepoll) { await sendAndApply('pin', { text: room.state.pin ?? '', closePollId: d.closepoll }); }
    else if (d.mod) showModerate(d.mod, d.uid!);
    else if (d.act === 'share') showShare(room.info.code);
    else if (d.act === 'screen') location.hash = `#/r/${room.info.code}/screen`;
    else if (d.act === 'menu') showMenu();
    else if (d.act === 'newpoll') showNewPoll();
    else if (d.act === 'recap') copyRecap();
    else if (d.act === 'dlrecap') downloadRecap();
    else if (d.act === 'pinmsg') showPin();
    else if (d.act === 'end') await endRoom();
    else if (d.act === 'copylink') { const u = joinUrl(room.info.code); try { await navigator.clipboard.writeText(u); toast('Link copied'); } catch { toast(u); } }
    else if (d.act === 'rename') { await askName(); renderComposer(true); toast(`You're now ${myName}`); }
    else if (d.act === 'imlost') {
      const on = !room.state.lost.has(ME);
      await sendAndApply('signal', { on });
      toast(on ? 'The host can see that someone is lost. Not who.' : 'Glad you are back on track');
    }
    else if (d.act === 'clearlost') { await sendAndApply('signal', { clear: true }); toast('Cleared'); }
    else if (d.act === 'lost') sheet(`<h2>Who is lost?</h2>${lostMeter(room.state.lost.size, peopleCount())}<div class="row"><button class="btn" data-close>Close</button></div>`,
      el => el.addEventListener('click', async e => { if ((e.target as HTMLElement).closest('[data-act="clearlost"]')) { await sendAndApply('signal', { clear: true }); document.querySelector('.scrim')?.remove(); } }));
    else if (d.act === 'startown') { location.hash = '#/'; setTimeout(startRoomFlow, 50); }
  } catch (err) { toast((err as Error).message); }
});

// The host's playbook. Shown in an empty room and from the menu.
const GUIDE_STEPS: [string, string, string][] = [
  ['Start', 'Put the code on the board', 'Tap <b>Projector view</b> (or the code chip) and show it on the screen.'],
  ['1 min', 'Say one line', '“Scan this and ask anything. You can hide your name. If I lose you, tap I’m lost.”'],
  ['2 min', 'Let questions come in', 'The room votes the best ones to the top. Tap <b>Answer now</b> to put one on every screen, then <b>Done, next</b>.'],
  ['6 min', 'Run a quick poll', '<b>Start a poll</b> with 2 to 6 answers. After you discuss it, <b>Ask again</b> and see who changed their mind.'],
  ['9 min', 'Pin the takeaway', 'Menu → <b>Pin an announcement</b>: the next step or the homework.'],
  ['10 min', 'End and keep the recap', 'Menu → <b>End room</b>. Every phone and the projector switch to the recap; copy or download it.'],
];
function hostGuide(inline: boolean) {
  return `<div class="guide${inline ? ' inline' : ''}">
    ${inline ? '<span class="tag q">You host this room</span>' : ''}
    <h3>Run a 10-minute session</h3>
    ${inline ? `<div class="row"><button class="btn accent" data-act="screen">Projector view</button><button class="btn ghost" data-act="share">Show QR</button></div>` : ''}
    <ol>${GUIDE_STEPS.map(([t, h, d]) => `<li><span class="t">${t}</span><div><b>${h}</b><p>${d}</p></div></li>`).join('')}</ol>
    <p class="muted small">Tap ••• on any post to hide it or remove the person. Guests can privately tap “I’m lost”; you see the count, never names. <a href="./guide.html" target="_blank" rel="noopener">One-page guide for teachers</a></p>
  </div>`;
}

// ---------- moderation (host only) ----------
// Hiding and removing are room messages, so every phone and the projector drop the
// posts at once; Nexconn also mutes a removed person so they cannot post again.
const modBtn = (id: string, author: string) => isHost() && author !== ME
  ? `<button class="mod-btn" data-mod="${esc(id)}" data-uid="${esc(author)}" aria-label="Moderate">${ICON.more}</button>` : '';

function showModerate(id: string, uid: string) {
  const name = clean(room!.state.people.get(uid) || 'this person');
  sheet(`<h2>Moderate</h2><p class="muted">Only you, the host, see this.</p>
    <div class="menu-list">
      <button data-h="hide">Hide this post</button>
      <button data-h="remove" class="danger">Remove ${esc(name)} from the room</button>
      <button data-close>Cancel</button>
    </div><p class="muted small">Removing hides everything they posted and stops them posting here for 24 hours.</p>`,
    (el, close) => {
      el.addEventListener('click', async e => {
        const h = (e.target as HTMLElement).closest<HTMLElement>('[data-h]')?.dataset.h; if (!h) return;
        close();
        try {
          if (h === 'hide') { await sendAndApply('hide', { id }); toast('Post hidden'); }
          if (h === 'remove') {
            await sendAndApply('remove', { userId: uid });
            await backend.moderate(room!.info.code, 'remove', uid).catch(() => { /* posts stay hidden either way */ });
            toast(`${name} was removed`);
          }
        } catch (err) { toast((err as Error).message); }
      });
    });
}

// ---------- translation (Nexconn built-in translation) ----------
// With a language chosen, other people's posts show a translated line under them.
const LANGS: [string, string][] = [
  ['es', 'Español'], ['zh', '中文'], ['vi', 'Tiếng Việt'], ['ko', '한국어'], ['tl', 'Tagalog'], ['ar', 'العربية'],
  ['ru', 'Русский'], ['uk', 'Українська'], ['pt', 'Português'], ['fr', 'Français'], ['hi', 'हिन्दी'], ['ja', '日本語'],
  ['fa', 'فارسی'], ['de', 'Deutsch'], ['en', 'English'],
];
let lang = store.get('roomcode:lang') || '';
const translated = new Map<string, string>(); // `${lang}:${id}` -> text
const asked = new Set<string>();
let trJustPicked = false;
let trTimer: number | undefined;
// When the translation service is switched off, hide the feature for a few hours
// instead of showing errors; it comes back by itself once the service is on.
const TR_DOWN_MS = 3 * 3600 * 1000;
const trDown = () => Date.now() - Number(store.get('roomcode:trdown') || 0) < TR_DOWN_MS;

function trLine(id: string) {
  const t = lang && translated.get(`${lang}:${id}`);
  return t ? `<div class="tr" lang="${esc(lang)}">${txt(t)}</div>` : '';
}

// Translates what is on screen and not yet translated: others' posts, newest 40.
function queueTranslations() {
  if (!lang || !room || trDown()) return;
  clearTimeout(trTimer);
  trTimer = window.setTimeout(async () => {
    if (!room) return;
    const items = room.state.feed.slice(-40)
      .filter(m => m.senderId !== ME && m.type !== 'join' && !asked.has(`${lang}:${m.id}`))
      .map(m => ({ id: m.id, text: String(m.type === 'poll' ? m.body.question : m.body.text ?? '').slice(0, 300) }))
      .filter(it => it.text.trim());
    if (!items.length) return;
    const target = lang, justPicked = trJustPicked;
    trJustPicked = false;
    items.forEach(it => asked.add(`${target}:${it.id}`));
    try {
      const out = await backend.translate(items, target);
      const src = new Map(items.map(it => [it.id, it.text]));
      for (const [id, t] of out) if (t.trim().toLowerCase() !== src.get(id)!.trim().toLowerCase()) translated.set(`${target}:${id}`, t);
      if (out.size && room && !$('.screen')) renderPane(false);
    } catch (err) {
      items.forEach(it => asked.delete(`${target}:${it.id}`));
      if (err instanceof Error && err.name === 'TranslationUnavailable') {
        store.set('roomcode:trdown', String(Date.now()));
        if (justPicked) toast('Translation unavailable right now');
      }
    }
  }, 250);
}

function showLanguages() {
  sheet(`<h2>Translate messages</h2><p class="muted">Other people's posts get a line in your language. Translation by Nexconn.</p>
    <div class="lang-grid">${LANGS.map(([c, n]) => `<button data-l="${c}" aria-pressed="${lang === c}">${esc(n)}</button>`).join('')}</div>
    <div class="row"><button class="btn ghost" data-l="">Turn off</button><button class="btn" data-close>Done</button></div>`,
    (el, close) => {
      el.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-l]'); if (!b) return;
        lang = b.dataset.l!; store.set('roomcode:lang', lang); trJustPicked = !!lang;
        close(); renderPane(false);
        toast(lang ? `Translating into ${LANGS.find(l => l[0] === lang)![1]}` : 'Translation off');
      });
    });
}

function showShare(code: string) {
  const url = joinUrl(code);
  sheet(`<h2>Invite the room</h2><p class="muted">Point a phone camera at the code. No app, no account.</p>
    <div class="share-qr">${qrSvg(url)}</div><div class="share-code">${esc(code)}</div><div class="share-url">or enter the code at ${esc(location.host)}</div>
    <div class="row"><button class="btn ghost" id="copyLink">Copy link</button><a class="btn" href="#/r/${esc(code)}/screen">Projector view</a></div>`,
    (el, close) => {
      $('#copyLink', el)!.onclick = async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
      };
      el.querySelector('a')!.addEventListener('click', close);
    });
}

function showMenu() {
  const host = isHost(), closed = room!.state.closed;
  sheet(`<h2>${txt(room!.info.title)}</h2><p class="muted">Room ${esc(room!.info.code)} · ${plural(peopleCount(), 'person', 'people')}</p>
    <div class="menu-list">
      <button data-m="share">Show QR and code</button>
      ${host ? '<button data-m="guide">How to run a 10-minute session</button>' : ''}
      <button data-m="screen">Open projector view</button>
      ${host && !closed ? '<button data-m="pin">Pin an announcement</button><button data-m="poll">Start a poll</button>' : ''}
      ${host || closed ? '<button data-m="recap">Copy recap (questions and poll results)</button>' : ''}
      <button data-m="big">${document.documentElement.classList.contains('big') ? 'Normal text size' : 'Larger text'}</button>
      ${trDown() ? '' : `<button data-m="lang">Translate messages${lang ? ` (${esc(LANGS.find(l => l[0] === lang)?.[1] ?? lang)})` : ''}</button>`}
      <button data-m="name">Change my nickname</button>
      ${host && !closed ? '<button data-m="end" class="danger">End room for everyone</button>' : ''}
    </div>`,
    (el, close) => {
      el.addEventListener('click', async e => {
        const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m; if (!m) return;
        close();
        if (m === 'share') showShare(room!.info.code);
        if (m === 'guide') sheet(hostGuide(false) + '<div class="row"><button class="btn" data-close>Got it</button></div>');
        if (m === 'screen') location.hash = `#/r/${room!.info.code}/screen`;
        if (m === 'pin') showPin();
        if (m === 'poll') showNewPoll();
        if (m === 'recap') copyRecap();
        if (m === 'name') { await askName(); renderComposer(true); toast(`You're now ${myName}`); }
        if (m === 'big') { const on = document.documentElement.classList.toggle('big'); store.set('roomcode:big', on ? '1' : ''); }
        if (m === 'lang') showLanguages();
        if (m === 'end') await endRoom();
      });
    });
}

function showPin() {
  sheet(`<h2>Pin an announcement</h2><p class="muted">Shows at the top for everyone. Leave empty to unpin.</p>
    <form id="pf"><textarea class="field" style="height:96px;padding:12px 16px" id="pt" maxlength="${LIMITS.pin}">${esc(room!.state.pin ?? '')}</textarea>
    <div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="submit">Pin</button></div></form>`,
    (el, close) => {
      $<HTMLFormElement>('#pf', el)!.onsubmit = async e => {
        e.preventDefault(); close();
        await sendAndApply('pin', { text: $<HTMLTextAreaElement>('#pt', el)!.value.trim() }).catch(err => toast(err.message));
      };
    });
}

function showNewPoll() {
  sheet(`<h2>New poll</h2><p class="muted">Everyone sees it live. One vote each; they can change it until you close the poll.</p>
    <form id="npf"><input class="field" id="pq" maxlength="${LIMITS.pollQuestion}" placeholder="Question" aria-label="Poll question" />
    <div class="opts" id="po" style="margin-top:10px"></div>
    <button class="link-btn" type="button" id="addOpt" style="margin:10px 2px">+ Add option</button>
    <p class="err" id="perr" role="alert"></p>
    <div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="submit">Start poll</button></div></form>`,
    (el, close) => {
      const po = $('#po', el)!;
      const add = (v = '') => {
        if (po.children.length >= LIMITS.pollOptions) return;
        const i = document.createElement('input');
        i.className = 'field'; i.maxLength = LIMITS.pollOption; i.placeholder = `Option ${po.children.length + 1}`; i.value = v;
        po.append(i);
      };
      add(); add();
      $('#addOpt', el)!.onclick = () => add();
      $<HTMLFormElement>('#npf', el)!.onsubmit = async e => {
        e.preventDefault();
        const question = $<HTMLInputElement>('#pq', el)!.value.trim();
        const options = [...po.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        if (!question || options.length < 2) { $('#perr', el)!.textContent = 'Add a question and at least 2 options.'; return; }
        close();
        await sendAndApply('poll', { question, options }).catch(err => toast(err.message));
        room!.tab = 'poll'; renderTabs(); renderPane(true); renderComposer(false);
      };
    });
}

function downloadRecap() {
  const text = clean(recap(room!.info.title, room!.info.code, room!.state));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = `${room!.info.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'roomcode'}-recap.md`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyRecap() {
  const text = clean(recap(room!.info.title, room!.info.code, room!.state));
  try { await navigator.clipboard.writeText(text); toast('Recap copied'); }
  catch { sheet(`<h2>Recap</h2><textarea class="field" style="height:50vh;padding:12px" readonly>${esc(text)}</textarea>`); }
}

// ---------- projector view ----------
function renderScreen() {
  if (!room) return;
  const s = room.state, url = joinUrl(room.info.code);
  const people = peopleCount();
  const ranked = rankedQuestions(s).filter(q => !q.answered);
  const lead = ranked[0], next = ranked.slice(1, 4);
  const poll = latestOpenPoll(s) ?? [...s.polls.values()].sort((a, b) => b.sentTime - a.sentTime)[0];
  const pollHtml = (p: Poll | undefined, final = false) => {
    if (!p) return '';
    const { counts, total } = pollTally(p);
    const was = p.round1 ? pollWas(p) : null;
    return `<div class="spoll"><h2><span class="lbl">${final || p.closed ? 'Final result' : p.round1 ? 'Second take' : 'Live poll'}</span>${txt(p.question)} <span class="muted">· ${plural(total, 'vote')}</span></h2>
      ${p.options.map((o, i) => { const pct = total ? Math.round(counts[i] * 100 / total) : 0;
        return `<div class="sopt"><div class="fill" style="width:${pct}%"></div>${was ? `<i class="was" style="left:${was[i]}%"></i>` : ''}<span><span>${txt(o)}</span><span>${was && was[i] !== pct ? `<s>${was[i]}%</s> ` : ''}${pct}%</span></span></div>`; }).join('')}
      ${p.round1 ? `<div class="smoved"><b>${changedMinds(p)}</b> of ${p.round1.size} changed their mind after talking it over</div>` : ''}</div>`;
  };
  const back = `<a class="sback" href="#/r/${esc(room.info.code)}" aria-label="Back to the room" title="Back to the room (Esc)">×</a>`;
  if (s.closed) {
    // Closing slide: what the room did, and how to run the next one.
    const r = summarize(s), home = `${location.origin}${location.pathname}`;
    app.innerHTML = `<div class="screen ended">
      <section>
        <div class="lbl">That's a wrap · ${txt(room.info.title)}</div>
        <h1 class="lead">Thank you for ${r.asked > 1 ? `your ${r.asked} questions` : 'joining'}.</h1>
        <div class="sstats">${([['people', r.people], ['questions', r.asked], ['upvotes', r.votes], ...(r.pollVotes ? [['poll votes', r.pollVotes]] : [])] as [string, number][]).map(([k, v]) => `<div><b>${v}</b>${k}</div>`).join('')}</div>
        ${r.groups.length ? `<div class="lbl">Most wanted</div>` + r.groups.slice(0, 3).map(g => `<div class="sq${g.lead.answered ? ' done' : ''}"><span class="n">▲ ${g.votes}</span><span>${txt(g.lead.text)}</span></div>`).join('') : ''}
        ${pollHtml(r.polls[r.polls.length - 1]?.poll, true)}
      </section>
      <aside class="join own">${qrSvg(home)}<div class="lbl"><b>Run your own room</b><br/>Scan. It takes 10 seconds.</div></aside>${back}</div>`;
    return;
  }
  app.innerHTML = `<div class="screen">
    <section>
      <div class="shead"><b>${txt(room.info.title)}</b><span>${plural(people, 'person', 'people')} in the room</span></div>
      ${s.pin ? `<div class="spin">${txt(s.pin)}</div>` : ''}
      ${lead ? `<div class="lbl${s.focus === lead.id ? ' now' : ''}">${s.focus === lead.id ? 'Answering now' : 'Top question'}</div>
        <h1 class="lead${lead.text.length > 110 ? ' long' : ''}">${txt(lead.text)}</h1>
        <div class="lmeta">▲ ${plural(lead.voters.size, 'vote')} · ${lead.anonymous ? 'Anonymous' : txt(lead.authorName)}</div>`
        : `<h1 class="lead dim">Scan the code and ask the first question.</h1>`}
      ${next.length ? `<div class="lbl">Up next</div>` + next.map(q => `<div class="sq"><span class="n">▲ ${q.voters.size}</span><span>${txt(q.text)}</span></div>`).join('') : ''}
      ${pollHtml(poll)}
    </section>
    <aside class="join">${qrSvg(url)}<div class="lbl">Scan to join. No app, no account.</div><div class="big">${esc(room.info.code)}</div><div class="host">${esc(location.host)}</div></aside>${back}</div>`;
}

// ---------- idle handling: free the connection when the tab is hidden ----------
// The Free plan caps concurrent connections, so a hidden tab disconnects after
// 2 minutes and catches up from history when it comes back.
let idleTimer: number | undefined;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    idleTimer = window.setTimeout(async () => { if (connected) { connected = false; await backend.disconnect(); } }, 120_000);
  } else {
    clearTimeout(idleTimer);
    if (!connected && room) {
      try {
        await ensureConnected();
        const msgs = await backend.history(room.info.code);
        room.msgs = msgs; room.state = build(room.info.ownerId, msgs);
        if (!$('.screen')) room.state.people.set(ME, myName);
        $('.screen') ? renderScreen() : renderRoom();
      } catch (err) { toast((err as Error).message); }
    }
  }
});

// ---------- router ----------
function route() {
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9]{5})(\/screen)?$/);
  if (!m) return renderHome();
  const code = normalizeCode(m[1]), screen = !!m[2];
  if (room && room.info.code === code) return screen ? renderScreen() : renderRoom();
  void openRoom(code, screen);
}
window.addEventListener('hashchange', route);
// On the projector, Esc goes back to the room.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && room && $('.screen') && !$('.scrim')) location.hash = `#/r/${room.info.code}`; });
setInterval(() => { if (room && $('.qmeta')) renderPane(false); }, 60_000); // refresh "x min ago"
route();
