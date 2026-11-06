import test from 'node:test';
import assert from 'node:assert/strict';
import { clean } from '../src/filter.ts';

test('masks listed words, leaves ordinary words alone', () => {
  assert.equal(clean('this is SHIT'), 'this is ••••');
  assert.equal(clean('class assignment, Scunthorpe aside'), 'class assignment, Scunthorpe aside');
  assert.equal(clean('kys'), '•••');
  assert.equal(clean('skys the limit'), 'skys the limit');
});
