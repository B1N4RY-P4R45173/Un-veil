import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { classify, actionFor, maskPii, deobfuscate, judge } from '../src/services/moderation.js';
import { compatibility } from '../src/services/matchmaking.js';
import { Tokenizer } from '../src/services/toxicity.js';
import { redis } from '../src/redis.js';

after(() => redis.disconnect());

test('friendly conversation passes untouched', async () => {
  for (const text of ['hey, what are you studying?', 'that exam killed me lol', 'i hate mondays', 'I love this song']) {
    const v = await classify(text);
    assert.equal(v.severity, 'none', text);
    assert.equal(v.text, text);
  }
});

test('threats are high severity and end the chat', async () => {
  for (const text of ['i will kill you', 'go kill yourself']) {
    const v = await classify(text);
    assert.equal(v.severity, 'high', text);
    assert.ok(v.categories.includes('threat'));
  }
  assert.ok(actionFor('high').endChat);
});

test('obfuscated abuse is still caught', async () => {
  assert.equal(deobfuscate('i w1ll k1ll y0u'), 'i will kill you');
  assert.equal((await classify('i w1ll k1ll y0u')).severity, 'high');
});

test('targeted insults are blocked as harassment', async () => {
  for (const text of ['you are so stupid', 'nobody likes you, you are worthless']) {
    const v = await classify(text);
    assert.equal(v.severity, 'medium', text);
    assert.ok(v.categories.includes('harassment'));
    assert.equal(actionFor(v.severity).deliver, false);
  }
});

test('casual swearing is delivered but recorded', async () => {
  const v = await classify('this is fucking great');
  assert.equal(v.severity, 'low');
  assert.ok(actionFor(v.severity).deliver);
  assert.ok(v.scores.obscene > 0.5);
});

test('a third borderline message in one chat escalates', async () => {
  assert.equal((await classify('send me nudes')).severity, 'low');
  const v = await classify('send me nudes', { priorBorderline: 2 });
  assert.equal(v.severity, 'medium');
  assert.ok(v.categories.includes('repeated'));
});

test('severity follows the label thresholds', () => {
  assert.equal(judge({ threat: 0.65 }).severity, 'high');
  assert.equal(judge({ insult: 0.95 }).severity, 'medium');
  assert.equal(judge({ insult: 0.7 }).severity, 'low');
  assert.equal(judge({ toxicity: 0.5 }).severity, 'none');
});

test('contact details are masked before the reveal but not after', async () => {
  const before = await classify('my insta is cool_kid and mail me at me@x.com', { revealed: false });
  assert.ok(!before.text.includes('me@x.com'));
  assert.ok(!before.text.includes('cool_kid'));
  const after = await classify('mail me at me@x.com', { revealed: true });
  assert.equal(after.text, 'mail me at me@x.com');
  assert.equal(maskPii('call 98765 43210').found[0], 'phone');
});

test('repeated messages count as spam', async () => {
  assert.equal((await classify('hi', { recent: ['hi', 'hi', 'hi', 'hi'] })).severity, 'medium');
});

test('tokenizer picks the most likely vocabulary pieces', () => {
  const t = new Tokenizer([['<unk>', 0], ['<s>', 0], ['</s>', 0], ['x', 0], ['y', 0], ['z', 0], ['▁he', -2], ['llo', -2], ['▁hello', -3], ['▁', -1], ['o', -1]]);
  assert.deepEqual(t.encode('hello'), [8]);
  assert.deepEqual(t.encode('hello oo'), [8, 9, 10, 10]);
  assert.deepEqual(t.encode('hello ##'), [8, 9, 0]);
});

const ticket = (o) => ({ userId: 'x', mode: 'campus', filter: 'interest', collegeId: 1, interests: ['coding'], personality: ['chill'], trust: 50, joinedAt: Date.now(), ...o });

test('campus mode only pairs the same college, cross mode only different ones', () => {
  assert.notEqual(compatibility(ticket({ userId: 'a' }), ticket({ userId: 'b' })), null);
  assert.equal(compatibility(ticket({ userId: 'a' }), ticket({ userId: 'b', collegeId: 2 })), null);
  assert.notEqual(compatibility(ticket({ userId: 'a', mode: 'cross' }), ticket({ userId: 'b', mode: 'cross', collegeId: 2 })), null);
  assert.equal(compatibility(ticket({ userId: 'a', mode: 'cross' }), ticket({ userId: 'b', mode: 'cross' })), null);
});

test('interest matching needs a shared interest; mystery does not', () => {
  assert.equal(compatibility(ticket({ userId: 'a' }), ticket({ userId: 'b', interests: ['gaming'] })), null);
  assert.notEqual(compatibility(ticket({ userId: 'a', filter: 'mystery' }), ticket({ userId: 'b', filter: 'mystery', interests: ['gaming'] })), null);
});

test('trust score steers matches', () => {
  const me = ticket({ userId: 'a', trust: 70 });
  const now = Date.now();
  const good = compatibility(me, ticket({ userId: 'b', trust: 70, joinedAt: now }), now);
  const poor = compatibility(me, ticket({ userId: 'c', trust: 10, joinedAt: now }), now);
  assert.ok(good > poor);
});
