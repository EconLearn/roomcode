import test from 'node:test';
import assert from 'node:assert/strict';
import { build, rankedQuestions, pollTally, latestOpenPoll, recap, summarize, lookalikes, changedMinds, type RoomMsg } from '../src/state.ts';

let t = 0;
const m = (type: RoomMsg['type'], senderId: string, body: Record<string, any>, id = `m${++t}`): RoomMsg =>
  ({ id, type, senderId, senderName: senderId.toUpperCase(), sentTime: ++t, body });

test('questions rank by votes, answered last, ties by age', () => {
  const s = build('host', [
    m('question', 'a', { text: 'first' }, 'q1'),
    m('question', 'b', { text: 'second' }, 'q2'),
    m('question', 'c', { text: 'third' }, 'q3'),
    m('vote', 'x', { qid: 'q2' }),
    m('vote', 'y', { qid: 'q2' }),
    m('vote', 'x', { qid: 'q3' }),
    m('answered', 'host', { qid: 'q2' }),
  ]);
  assert.deepEqual(rankedQuestions(s).map(q => q.id), ['q3', 'q1', 'q2']);
  assert.equal(s.questions.get('q2')!.voters.size, 3);
});

test('vote toggles and is one per person', () => {
  const s = build('host', [
    m('question', 'a', { text: 'q' }, 'q1'),
    m('vote', 'x', { qid: 'q1' }), m('vote', 'x', { qid: 'q1' }), m('vote', 'x', { qid: 'q1', up: false }),
  ]);
  assert.equal(s.questions.get('q1')!.voters.size, 1);
});

test('host-only actions from guests are ignored', () => {
  const s = build('host', [
    m('question', 'a', { text: 'q' }, 'q1'),
    m('answered', 'a', { qid: 'q1' }),
    m('pin', 'a', { text: 'fake' }),
    m('poll', 'a', { question: 'x?', options: ['1', '2'] }, 'p1'),
    m('close', 'a', {}),
  ]);
  assert.equal(s.questions.get('q1')!.answered, false);
  assert.equal(s.pin, null);
  assert.equal(s.polls.size, 0);
  assert.equal(s.closed, false);
});

test('poll: last vote wins, invalid options ignored, closing freezes', () => {
  const s = build('host', [
    m('poll', 'host', { question: 'Lunch?', options: ['Pizza', 'Tacos', ''] }, 'p1'),
    m('pollvote', 'a', { pollId: 'p1', option: 0 }),
    m('pollvote', 'a', { pollId: 'p1', option: 1 }),
    m('pollvote', 'b', { pollId: 'p1', option: 1 }),
    m('pollvote', 'c', { pollId: 'p1', option: 9 }),
    m('pin', 'host', { text: '', closePollId: 'p1' }),
    m('pollvote', 'd', { pollId: 'p1', option: 0 }),
  ]);
  const p = s.polls.get('p1')!;
  assert.deepEqual(p.options, ['Pizza', 'Tacos']);
  assert.deepEqual(pollTally(p), { counts: [0, 2], total: 2 });
  assert.equal(latestOpenPoll(s), null);
});

test('history replay is order-independent and dedupes', () => {
  const msgs = [m('question', 'a', { text: 'q' }, 'q1'), m('vote', 'b', { qid: 'q1' })];
  const s = build('host', [msgs[1], msgs[0], msgs[1]]);
  assert.equal(s.questions.get('q1')!.voters.size, 2);
  assert.equal(s.feed.length, 1);
});

test('closed room ignores new activity; recap lists results', () => {
  const s = build('host', [
    m('chat', 'a', { text: 'hi' }),
    m('question', 'a', { text: 'Why?' }, 'q1'),
    m('close', 'host', {}),
    m('chat', 'b', { text: 'late' }),
  ]);
  assert.equal(s.closed, true);
  assert.equal(s.feed.length, 2);
  assert.match(recap('Bio club', 'ABCDE', s), /Why\?/);
});

test('join: one line per person, counts people, room still "quiet"', async () => {
  const { isQuiet } = await import('../src/state.ts');
  const s = build('host', [
    m('join', 'a', {}), m('join', 'b', {}), m('join', 'a', {}),
  ]);
  assert.equal(s.feed.length, 2);
  assert.equal(s.people.size, 3); // host + a + b
  assert.equal(isQuiet(s), true);
  const s2 = build('host', [m('join', 'a', {}), m('chat', 'a', { text: 'hi' })]);
  assert.equal(isQuiet(s2), false);
  assert.match(recap('T', 'ABCDE', s2), /Messages: 1/);
});

test('host hide drops one post; guest hide is ignored', () => {
  const s = build('host', [
    m('chat', 'a', { text: 'rude' }, 'c1'),
    m('question', 'b', { text: 'ok?' }, 'q1'),
    m('hide', 'b', { id: 'c1' }),
    m('hide', 'host', { id: 'q1' }),
  ]);
  assert.deepEqual(s.feed.map(f => f.id), ['c1']);
  assert.equal(s.questions.size, 0);
});

test('remove hides everything a person posted, their votes, and anything later', () => {
  const s = build('host', [
    m('question', 'a', { text: 'good' }, 'q1'),
    m('question', 'troll', { text: 'bad' }, 'q2'),
    m('vote', 'troll', { qid: 'q1' }),
    m('poll', 'host', { question: 'x?', options: ['1', '2'] }, 'p1'),
    m('pollvote', 'troll', { pollId: 'p1', option: 0 }),
    m('remove', 'host', { userId: 'troll' }),
    m('chat', 'troll', { text: 'still here' }),
    m('remove', 'a', { userId: 'host' }),
  ]);
  assert.deepEqual([...s.questions.keys()], ['q1']);
  assert.equal(s.questions.get('q1')!.voters.size, 1);
  assert.equal(pollTally(s.polls.get('p1')!).total, 0);
  assert.equal(s.feed.some(f => f.senderId === 'troll'), false);
  assert.equal(s.people.has('troll'), false);
  assert.equal(s.removed.has('host'), false);
});

test('answering now: host only, shown first, cleared when answered', () => {
  const base = [m('question', 'a', { text: 'first one' }, 'q1'), m('question', 'b', { text: 'second one' }, 'q2'), m('vote', 'x', { qid: 'q1' })];
  let s = build('host', [...base, m('focus', 'b', { qid: 'q2' })]);
  assert.equal(s.focus, null);
  s = build('host', [...base, m('focus', 'host', { qid: 'q2' })]);
  assert.equal(s.focus, 'q2');
  assert.deepEqual(rankedQuestions(s).map(q => q.id), ['q2', 'q1']);
  s = build('host', [...base, m('focus', 'host', { qid: 'q2' }), m('answered', 'host', { qid: 'q2' })]);
  assert.equal(s.focus, null);
});

test("I'm lost: one per person, toggles, only the host clears, removed people drop out", () => {
  let s = build('host', [m('signal', 'a', { on: true }), m('signal', 'a', { on: true }), m('signal', 'b', { on: true }), m('signal', 'c', { on: true }), m('signal', 'c', { on: false })]);
  assert.equal(s.lost.size, 2);
  s = build('host', [m('signal', 'a', { on: true }), m('signal', 'b', { clear: true })]);
  assert.equal(s.lost.size, 1);
  s = build('host', [m('signal', 'a', { on: true }), m('signal', 'host', { clear: true })]);
  assert.equal(s.lost.size, 0);
  s = build('host', [m('signal', 'a', { on: true }), m('remove', 'host', { userId: 'a' })]);
  assert.equal(s.lost.size, 0);
});

test('second take: counts who changed their mind; guests cannot start it', () => {
  const votes = [m('poll', 'host', { question: 'A or B?', options: ['A', 'B'] }, 'p1'),
    m('pollvote', 'a', { pollId: 'p1', option: 0 }), m('pollvote', 'b', { pollId: 'p1', option: 0 }), m('pollvote', 'c', { pollId: 'p1', option: 1 })];
  let s = build('host', [...votes, m('poll', 'a', { retake: 'p1' }), m('pollvote', 'a', { pollId: 'p1', option: 1 })]);
  assert.equal(s.polls.get('p1')!.round1, null);
  s = build('host', [...votes, m('poll', 'host', { retake: 'p1' }), m('pollvote', 'a', { pollId: 'p1', option: 1 }), m('pollvote', 'c', { pollId: 'p1', option: 1 }), m('pollvote', 'd', { pollId: 'p1', option: 0 })]);
  const p = s.polls.get('p1')!;
  assert.equal(changedMinds(p), 1);
  assert.equal(p.round1!.size, 3);
  assert.equal(s.polls.size, 1);
  assert.match(recap('T', 'ABCDE', s), /1 of 3 changed their mind/);
});

test('similar questions: offered while typing, grouped in the recap', () => {
  const s = build('host', [
    m('question', 'a', { text: 'Will the slides be shared after the talk?' }, 'q1'),
    m('question', 'b', { text: 'Are the slides shared afterwards?' }, 'q2'),
    m('question', 'c', { text: 'How do you keep the queue fair?' }, 'q3'),
    m('vote', 'x', { qid: 'q1' }),
  ]);
  assert.deepEqual(lookalikes(s, 'can you share the slides').map(q => q.id), ['q1', 'q2']);
  assert.deepEqual(lookalikes(s, 'what time is lunch'), []);
  const r = summarize(s);
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].lead.id, 'q1');
  assert.deepEqual(r.groups[0].others.map(q => q.id), ['q2']);
  assert.equal(r.groups[0].votes, 3);
  assert.match(recap('T', 'ABCDE', s), /also asked: Are the slides shared afterwards\?/);
});

test('recap grouping keeps same-topic questions apart', () => {
  const r = summarize(build('host', [
    m('question', 'a', { text: 'Why do cells need mitochondria if they already have a nucleus?' }, 'q1'),
    m('question', 'b', { text: 'Do plant cells have mitochondria too?' }, 'q2'),
    m('question', 'c', { text: 'What happens to a cell with no mitochondria?' }, 'q3'),
    m('question', 'd', { text: 'Do plants have mitochondria as well as chloroplasts?' }, 'q4'),
  ]));
  assert.equal(r.groups.length, 3);
  assert.deepEqual(r.groups.find(g => g.lead.id === 'q2')!.others.map(q => q.id), ['q4']);
});

test('second take forgets a removed person in both rounds', () => {
  const s = build('host', [m('poll', 'host', { question: 'A or B?', options: ['A', 'B'] }, 'p1'),
    m('pollvote', 'a', { pollId: 'p1', option: 0 }), m('pollvote', 'b', { pollId: 'p1', option: 0 }),
    m('poll', 'host', { retake: 'p1' }), m('pollvote', 'b', { pollId: 'p1', option: 1 }), m('remove', 'host', { userId: 'b' })]);
  const p = s.polls.get('p1')!;
  assert.equal(p.round1!.size, 1);
  assert.equal(changedMinds(p), 0);
});
