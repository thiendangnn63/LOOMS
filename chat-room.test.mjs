import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatRoom } from './chat-room.mjs';

test('models see the user and each other, and the round stops when everyone passes', async () => {
  const prompts = [];
  const replies = { a: ['hi from a', 'PASS'], b: ['b agrees with @a', 'PASS'] };
  const room = createChatRoom({ ask: async (name, prompt) => (prompts.push([name, prompt]), replies[name].shift()) });
  const events = [];
  await room.send(['a', 'b'], 'hello', entry => events.push(entry));
  assert.deepEqual(events.map(e => e.speaker), ['user', 'a', 'b']);
  assert.deepEqual(events.map(e => e.id), [1, 2, 3]);
  assert.ok(events.every(e => new Date(e.ts).toISOString() === e.ts));
  assert.match(prompts[1][1], /\[user\] hello[\s\S]*\[a\] hi from a/);
  assert.match(prompts[2][1], /\[b\] b agrees/);
  assert.doesNotMatch(prompts[2][1], /\[user\] hello/); // a already saw it
  assert.equal(prompts.length, 3); // b's last turn had nothing new, so it was skipped
});

test('failed turns retain unread context and forgotten sessions see their own old replies', async () => {
  const prompts = [];
  const room = createChatRoom({ ask: async (_name, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) throw new Error('temporary failure');
    return 'reply';
  } });
  await room.send(['a'], 'first');
  await room.send(['a'], 'second');
  assert.match(prompts[1], /\[user\] first[\s\S]*\[user\] second/);
  room.forget('a');
  await room.send(['a'], 'third');
  assert.match(prompts[2], /join or rejoin:[\s\S]*\[a\] reply[\s\S]*\[user\] third/);
});

test('turns are bounded and failures do not end the round', async () => {
  let calls = 0;
  const room = createChatRoom({ maxTurns: 4, ask: async name => {
    calls++;
    if (name === 'b') throw new Error('boom');
    return `${name} still talking`;
  } });
  const events = [];
  await room.send(['a', 'b', 'c'], 'go', entry => events.push(entry));
  assert.equal(calls, 4);
  assert.deepEqual(events.map(e => e.speaker), ['user', 'a', 'system', 'c', 'a']);
  assert.equal(room.transcript.length, 4); // system notices are not part of the shared transcript
});

test('user mentions take priority over peer mentions and ignore partial handles', async () => {
  const order = [];
  const room = createChatRoom({ ask: async name => {
    order.push(name);
    return order.length === 1 ? '@a What do you think?' : 'PASS';
  } });
  await room.send(['a', 'b', 'c'], 'Ignore user@a and @unknown. @C first, then @b.');
  assert.deepEqual(order.slice(0, 3), ['c', 'b', 'a']);
  assert.ok(order.every((name, index) => index === 0 || name !== order[index - 1]));
});

test('a peer mention moves an eligible member ahead of the next roster member', async () => {
  const order = [];
  const room = createChatRoom({ ask: async name => {
    order.push(name);
    return order.length === 1 ? '@c Can you follow up?' : 'PASS';
  } });
  await room.send(['a', 'b', 'c'], 'hello @all');
  assert.deepEqual(order.slice(0, 3), ['a', 'c', 'b']);
});
