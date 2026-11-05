import test from 'node:test';
import assert from 'node:assert/strict';
import { build, rankedQuestions, pollTally, latestOpenPoll, recap, type RoomMsg } from '../src/state.ts';

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
