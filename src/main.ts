import './styles.css';
import qrcode from 'qrcode-generator';
import { MockBackend } from './backend/mock.ts';
import { clean } from './filter.ts';
import { normalizeCode, type Backend, type RoomInfo, type Status } from './backend/types.ts';
import {
  build, apply, rankedQuestions, pollTally, latestOpenPoll, recap, isQuiet, LIMITS,
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
  backend.onStatus(s => { status = s; renderTop(); });
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
  if (myName) return Promise.resolve();
  return new Promise(resolve => {
    const suggestion = suggestName();
    sheet(`
      <h2>What should the room call you?</h2>
      <p class="muted">Only this nickname is shared. No email, no account.</p>
      <form id="nf"><input class="field" id="nick" maxlength="${LIMITS.name}" value="${esc(suggestion)}" autocomplete="nickname" aria-label="Nickname" />
      <div class="row"><button class="btn accent block" type="submit">Join the room</button></div></form>`,
      (el, close) => {
        const input = $<HTMLInputElement>('#nick', el)!; input.select();
        $<HTMLFormElement>('#nf', el)!.onsubmit = e => {
          e.preventDefault();
          myName = input.value.trim().slice(0, LIMITS.name) || suggestion;
          store.set('roomcode:name', myName);
          close(); resolve();
        };
      }, false);
  });
}

// ---------- home ----------
function renderHome(prefill = '', error = '') {
  room = null;
  document.title = 'Roomcode';
  app.innerHTML = `
  <main class="home">
    <div class="logo"><span class="logo-mark"><i></i><i></i><i></i><i></i></span>Roomcode</div>
    <h1>A live chat for <em>any room</em> you're in.</h1>
    <p class="lede">Scan the code, ask questions, vote and run polls. No app, no account. Rooms close after 24 hours.</p>
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
      <li><b>3</b><span><strong>Everyone gets a voice.</strong> The best questions get voted to the top. Quick polls show what the room thinks.</span></li>
    </ol>
    <p class="foot"><a href="#/r/${FEEDBACK_CODE}">Ideas or problems? Tell us in room ${FEEDBACK_CODE}</a><br/>Built on the Nexconn Chat SDK. <span class="mode-pill">${APP_KEY && !forceMock ? 'Live' : 'Offline demo: rooms are shared between tabs of this browser'}</span></p>
  </main>`;
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
type Tab = 'chat' | 'questions' | 'poll';
interface Room { info: RoomInfo; state: RoomState; msgs: RoomMsg[]; tab: Tab; mode: 'chat' | 'question'; anon: boolean; }
let room: Room | null = null;
let typingIds: string[] = [];
const isHost = () => !!room && room.info.ownerId === ME;
const ROOM_TTL = 24 * 3600 * 1000;
// The public feedback room never closes.
const FEEDBACK_CODE = 'FEEDB';

async function openRoom(code: string, screen: boolean) {
  app.innerHTML = `<div class="empty" style="padding-top:30vh"><b>Joining ${esc(code)}…</b></div>`;
  try {
    if (!screen) await askName();
    const b = await ensureConnected();
    const info = await b.joinRoom(code);
    const msgs = await b.history(code);
    room = { info, msgs, state: build(info.ownerId, msgs), tab: 'chat', mode: 'chat', anon: false };
    if (!screen) room.state.people.set(ME, myName);
    if (Date.now() - info.createdAt > ROOM_TTL && code !== FEEDBACK_CODE) room.state.closed = true;
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
  const before = room.state.feed.length;
  apply(room.state, m);
  typingIds = typingIds.filter(id => id !== m.senderId);
  if (m.type === 'join' && m.senderId !== ME && isHost()) queueSnapshot();
  if ($('.screen')) return renderScreen();
  renderTop(); renderPin(); renderTabs(); renderPane(room.state.feed.length > before && m.senderId !== ME); renderTyping(); renderComposer(false);
}

// ---------- snapshots for late joiners ----------
// New group members may not be able to read history from before they joined (a
// Nexconn console setting). So when someone new joins, the host's open screen (phone
// or projector) sends the room so far as one transient message.
const MSG_TYPES = new Set(['chat', 'question', 'vote', 'answered', 'poll', 'pollvote', 'pin', 'close', 'join', 'hide', 'remove']);
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
  $('.screen') ? renderScreen() : renderRoom();
}

function renderRoom() {
  app.innerHTML = `
  <div class="room">
    <header class="top" id="top"></header>
    <div id="pin"></div>
    <nav class="tabs" id="tabs" role="tablist"></nav>
    <section class="pane" id="pane" aria-live="polite"></section>
    <div class="typing" id="typing"></div>
    <footer id="composer"></footer>
  </div>`;
  renderTop(); renderPin(); renderTabs(); renderPane(true); renderTyping(); renderComposer(true);
  if (matchMedia('(pointer: fine)').matches) $<HTMLTextAreaElement>('#box')?.focus();
}

function renderTop() {
  const el = $('#top'); if (!el || !room) return;
  const n = Math.max(room.state.people.size, room.info.memberCount ?? 0);
  el.innerHTML = `
    <a class="icon-btn" href="#/" aria-label="Leave room">${ICON.back}</a>
    <div class="title"><b>${txt(room.info.title)}</b>
      <small><span class="dot ${status}"></span>${status === 'connected' ? `${n} ${n === 1 ? 'person' : 'people'}` : status === 'connecting' ? 'Connecting…' : 'Offline'}${isHost() ? ' · you host' : ''}</small></div>
    <button class="code-chip" data-act="share" aria-label="Show join code">${esc(room.info.code)}</button>
    <button class="icon-btn" data-act="menu" aria-label="Room menu">${ICON.more}</button>`;
}

function renderPin() {
  const el = $('#pin'); if (!el || !room) return;
  el.innerHTML = room.state.pin ? `<div class="pin">${ICON.pin}<span>${txt(room.state.pin)}</span></div>` : '';
}

function renderTabs() {
  const el = $('#tabs'); if (!el || !room) return;
  const open = [...room.state.questions.values()].filter(q => !q.answered).length;
  const poll = latestOpenPoll(room.state);
  const voted = poll?.votes.has(ME);
  const tab = (id: Tab, label: string, badge = '') =>
    `<button class="tab" role="tab" data-tab="${id}" aria-selected="${room!.tab === id}">${label}${badge}</button>`;
  el.innerHTML = tab('chat', 'Chat') +
    tab('questions', 'Questions', open ? ` <span class="badge">${open}</span>` : '') +
    tab('poll', 'Polls', poll && !voted ? ' <span class="badge">1</span>' : '');
}

function questionCard(q: Question, rank = -1) {
  const mine = q.voters.has(ME);
  const name = q.anonymous ? 'Anonymous' : txt(q.authorName);
  return `<article class="qcard${q.answered ? ' answered' : ''}${rank === 0 && !q.answered && q.voters.size > 1 ? ' top1' : ''}">
    <button class="vote" data-vote="${esc(q.id)}" aria-pressed="${mine}" aria-label="Upvote, ${q.voters.size} votes" ${room!.state.closed ? 'disabled' : ''}>${ICON.up}${q.voters.size}</button>
    <div class="qbody"><div class="qtext">${txt(q.text)}</div>${trLine(q.id)}
      <div class="qmeta">${q.answered ? '<span class="tag ok">Answered</span>' : '<span class="tag q">Question</span>'}<span>${name} · ${ago(q.sentTime)}</span>
      ${isHost() && !room!.state.closed ? `<button class="link-btn" data-answer="${esc(q.id)}" data-val="${!q.answered}">${q.answered ? 'Reopen' : 'Mark answered'}</button>` : ''}${modBtn(q.id, q.authorId)}</div></div>
  </article>`;
}

function pollCard(p: Poll) {
  const { counts, total } = pollTally(p);
  const mine = p.votes.get(ME);
  const showResults = mine !== undefined || p.closed || isHost();
  return `<article class="poll"><span class="tag ${p.closed ? '' : 'q'}">${p.closed ? 'Poll closed' : 'Live poll'}</span><h3>${txt(p.question)}</h3>${trLine(p.id)}
    ${p.options.map((o, i) => {
      const pct = total ? Math.round(counts[i] * 100 / total) : 0;
      return `<button class="opt${mine === i ? ' mine' : ''}" data-poll="${esc(p.id)}" data-opt="${i}" ${p.closed || room!.state.closed ? 'disabled' : ''}>
        <div class="fill" style="width:${showResults ? pct : 0}%"></div><span><span>${txt(o)}</span>${showResults ? `<span>${pct}%</span>` : ''}</span></button>`;
    }).join('')}
    <div class="foot-note"><span>${total} ${total === 1 ? 'vote' : 'votes'}${mine === undefined && !p.closed ? ' · tap to vote' : ''}</span>
    ${isHost() && !p.closed && !room!.state.closed ? `<button class="link-btn" data-closepoll="${esc(p.id)}">Close poll</button>` : ''}</div></article>`;
}

function renderPane(stickToBottom: boolean) {
  const el = $('#pane'); if (!el || !room) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const s = room.state;
  let html = '';
  if (room.tab === 'chat') {
    let prev = '';
    const feed = s.feed;
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
      if (m.type === 'chat') {
        const me = m.senderId === ME, cont = prev === m.senderId;
        const host = m.senderId === s.ownerId ? ' <span class="host">· host</span>' : '';
        html += `<div class="msg${me ? ' me' : ''}${cont ? ' cont' : ''}"><div class="who">${me ? 'You' : txt(m.senderName)}${host}</div><div class="brow"><div class="bubble">${txt(m.body.text)}${trLine(m.id)}</div>${modBtn(m.id, m.senderId)}</div></div>`;
        prev = m.senderId;
      } else {
        const q = s.questions.get(m.id), p = s.polls.get(m.id);
        if (q) html += questionCard(q); if (p) html += pollCard(p);
        prev = '';
      }
    }
    if (isQuiet(s)) html = (isHost() && !s.closed ? hostGuide(true)
      : `<div class="empty"><b>The room is quiet.</b>${s.removed.has(ME) ? 'You can still read along.' : 'Say hi, or ask the first question.'}</div>`) + html;
  } else if (room.tab === 'questions') {
    const qs = rankedQuestions(s);
    html = qs.length ? qs.map((q, i) => questionCard(q, i)).join('')
      : `<div class="empty"><b>No questions yet.</b>Switch the box below to “Question”. The room votes the best ones to the top.</div>`;
  } else {
    const polls = [...s.polls.values()].sort((a, b) => b.sentTime - a.sentTime);
    html = (isHost() && !s.closed ? `<button class="btn accent block" data-act="newpoll" style="margin:4px 0 6px">New poll</button>` : '') +
      (polls.length ? polls.map(pollCard).join('') : `<div class="empty"><b>No polls yet.</b>${isHost() ? 'Ask the room a quick question with 2 to 6 answers.' : 'The host can start one.'}</div>`);
  }
  el.innerHTML = html;
  if (room.tab === 'chat' && !isQuiet(s) && (stickToBottom || nearBottom)) el.scrollTop = el.scrollHeight;
  queueTranslations();
}

function renderTyping() {
  const el = $('#typing'); if (!el || !room) return;
  const names = typingIds.map(id => clean(room!.state.people.get(id) || 'Someone')).slice(0, 2);
  el.textContent = names.length ? `${names.join(' and ')}${typingIds.length > 2 ? ' and others' : ''} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}

function renderComposer(full: boolean) {
  const el = $('#composer'); if (!el || !room) return;
  if (room.state.closed) {
    el.innerHTML = `<div class="closed-bar"><p>This room has ended.${isHost() ? ' <button class="link-btn" data-act="recap">Copy recap</button>' : ' Thanks for joining.'}</p>
      <button class="btn accent block" data-act="startown">${isHost() ? 'Start a new room' : 'Run your own room. It takes 10 seconds'}</button></div>`;
    return;
  }
  if (room.state.removed.has(ME)) {
    el.innerHTML = `<div class="closed-bar"><p>The host removed you from this room.</p></div>`;
    return;
  }
  if (!full && $('#box', el)) return; // keep what the user is typing
  const q = room.mode === 'question';
  el.innerHTML = `<div class="composer">
    <div><span class="seg" role="group" aria-label="Message type">
      <button data-mode="chat" aria-pressed="${!q}">Message</button><button data-mode="question" aria-pressed="${q}">Question</button></span>
      ${q ? `<label class="anon"><input type="checkbox" id="anon" ${room.anon ? 'checked' : ''}/> Hide my name</label>` : ''}</div>
    <form class="compose-row" id="cf">
      <textarea id="box" rows="1" maxlength="${q ? LIMITS.question : LIMITS.chat}" placeholder="${q ? 'Ask the room a question…' : 'Message the room…'}" aria-label="${q ? 'Question' : 'Message'}"></textarea>
      <button class="send" id="sendBtn" type="submit" aria-label="Send" disabled>${ICON.send}</button>
    </form></div>`;
  const box = $<HTMLTextAreaElement>('#box', el)!, send = $<HTMLButtonElement>('#sendBtn', el)!;
  const grow = () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 140) + 'px'; send.disabled = !box.value.trim(); };
  box.oninput = () => { grow(); if (box.value.trim()) backend.sendTyping(room!.info.code); };
  box.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $<HTMLFormElement>('#cf', el)!.requestSubmit(); } };
  $<HTMLInputElement>('#anon', el)?.addEventListener('change', e => { room!.anon = (e.target as HTMLInputElement).checked; });
  $<HTMLFormElement>('#cf', el)!.onsubmit = async e => {
    e.preventDefault();
    const text = box.value.trim(); if (!text || !room) return;
    box.value = ''; grow();
    const asQuestion = room.mode === 'question';
    try {
      await sendAndApply(asQuestion ? 'question' : 'chat', asQuestion ? { text, anonymous: room.anon } : { text });
      if (asQuestion) { toast('Question posted. Others can vote it up.'); }
    } catch (err) { box.value = text; grow(); toast((err as Error).message); }
    box.focus();
  };
}

async function sendAndApply(type: RoomMsg['type'], body: Record<string, any>) {
  if (!room) return;
  const code = room.info.code;
  const m = await backend.send(code, type, body);
  onIncoming(code, m);
}

// One delegated click handler for the whole room view.
app.addEventListener('click', async e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tab],[data-mode],[data-vote],[data-answer],[data-poll],[data-closepoll],[data-mod]');
  if (!t || !room) return;
  const d = t.dataset;
  try {
    if (d.tab) { room.tab = d.tab as Tab; renderTabs(); renderPane(true); }
    else if (d.mode) {
      const draft = $<HTMLTextAreaElement>('#box')?.value ?? '';
      room.mode = d.mode as Room['mode']; renderComposer(true);
      const box = $<HTMLTextAreaElement>('#box')!; box.value = draft; box.dispatchEvent(new Event('input')); box.focus();
    }
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
    else if (d.act === 'startown') { location.hash = '#/'; setTimeout(startRoomFlow, 50); }
  } catch (err) { toast((err as Error).message); }
});

// The host's playbook. Shown in an empty room and from the menu.
const GUIDE_STEPS: [string, string, string][] = [
  ['0:00', 'Put the code on the board', 'Tap <b>Projector view</b> (or the code chip) and show it on the screen.'],
  ['0:01', 'Say one line', '“Scan this, pick a nickname. Ask anything. You can hide your name.”'],
  ['0:02', 'Let questions come in', 'The room votes the best ones to the top. Answer them out loud, then tap <b>Mark answered</b>.'],
  ['0:06', 'Run a quick poll', 'Polls tab → <b>New poll</b>, 2 to 4 answers. Results move live on the projector.'],
  ['0:09', 'Pin the takeaway', 'Menu → <b>Pin an announcement</b>: the next step or the homework.'],
  ['0:10', 'End and keep the recap', 'Menu → <b>End room</b>, then <b>Copy recap</b> for your notes.'],
];
function hostGuide(inline: boolean) {
  return `<div class="guide${inline ? ' inline' : ''}">
    ${inline ? '<span class="tag q">You host this room</span>' : ''}
    <h3>Run a 10-minute session</h3>
    <ol>${GUIDE_STEPS.map(([t, h, d]) => `<li><span class="t">${t}</span><div><b>${h}</b><p>${d}</p></div></li>`).join('')}</ol>
    ${inline ? `<div class="row"><button class="btn accent" data-act="screen">Projector view</button><button class="btn ghost" data-act="share">Show QR</button></div>` : ''}
    <p class="muted small">Tap ••• on any post to hide it or remove the person. Only nicknames are shared. Rooms close after 24 hours. <a href="./guide.html" target="_blank" rel="noopener">One-page guide for teachers</a></p>
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
  sheet(`<h2>Invite the room</h2><p class="muted">Point a phone camera at the code, or type the code at ${esc(location.host)}.</p>
    <div class="share-qr">${qrSvg(url)}</div><div class="share-code">${esc(code)}</div><div class="share-url">${esc(url)}</div>
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
  sheet(`<h2>${txt(room!.info.title)}</h2><p class="muted">Room ${esc(room!.info.code)} · ${room!.state.people.size} people · ${room!.state.feed.filter(m => m.type !== 'join').length} messages</p>
    <div class="menu-list">
      <button data-m="share">Show QR and code</button>
      ${host ? '<button data-m="guide">How to run a 10-minute session</button>' : ''}
      <button data-m="screen">Open projector view</button>
      ${host && !closed ? '<button data-m="pin">Pin an announcement</button><button data-m="poll">Start a poll</button>' : ''}
      ${host ? '<button data-m="recap">Copy recap (questions and poll results)</button>' : ''}
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
        if (m === 'name') { myName = ''; await askName(); toast(`You're now ${myName}`); }
        if (m === 'lang') showLanguages();
        if (m === 'end' && confirm('End this room? Nobody will be able to post after this.')) {
          await sendAndApply('close', {}).catch(err => toast(err.message)); renderComposer(true);
          backend.moderate(room!.info.code, 'close').catch(() => { /* the room view already ignores later posts */ });
        }
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
        room!.tab = 'poll'; renderTabs(); renderPane(true);
      };
    });
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
  const people = Math.max(s.people.size, room.info.memberCount ?? 0);
  const qs = rankedQuestions(s).slice(0, 5);
  const poll = latestOpenPoll(s) ?? [...s.polls.values()].sort((a, b) => b.sentTime - a.sentTime)[0];
  let pollHtml = '';
  if (poll) {
    const { counts, total } = pollTally(poll);
    pollHtml = `<div class="spoll"><h2>${txt(poll.question)} <span class="muted">· ${total} ${total === 1 ? 'vote' : 'votes'}${poll.closed ? ', closed' : ''}</span></h2>
      ${poll.options.map((o, i) => { const pct = total ? Math.round(counts[i] * 100 / total) : 0;
        return `<div class="sopt"><div class="fill" style="width:${pct}%"></div><span><span>${txt(o)}</span><span>${pct}%</span></span></div>`; }).join('')}</div>`;
  }
  app.innerHTML = `<div class="screen">
    <aside class="join">${qrSvg(url)}<div class="lbl">Scan, or go to ${esc(location.host)} and enter</div><div class="big">${esc(room.info.code)}</div></aside>
    <section>
      <h1>${txt(room.info.title)}</h1>
      <div class="sub">${people} ${people === 1 ? 'person' : 'people'} in the room · ${s.closed ? 'ended' : 'live'} · <a href="#/r/${esc(room.info.code)}" style="color:inherit">back to room</a></div>
      ${s.pin ? `<div class="spin">${txt(s.pin)}</div>` : ''}
      ${qs.length ? qs.map(q => `<div class="sq${q.answered ? ' answered' : ''}"><span class="n">▲ ${q.voters.size}</span><span>${txt(q.text)}</span></div>`).join('')
        : '<div class="sq"><span class="n">?</span><span>Questions will appear here, ranked by votes.</span></div>'}
      ${pollHtml}
    </section></div>`;
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
setInterval(() => { if (room && $('.qmeta')) renderPane(false); }, 60_000); // refresh "x min ago"
route();
