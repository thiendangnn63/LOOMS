import assert from 'node:assert/strict';
import test from 'node:test';
import { runRoomJob } from './room-job.mjs';

const done = text => ({ action: 'done', text });
const ask = (to, text) => ({ action: 'ask', to, text, progress: 'Checkpoint' });
const delivery = (status, text) => ({ status, text });

function fixture(names, handler) {
  const job = {
    id: 1, task: 'Prepare the result.', lead: names[0],
    members: new Map(names.map(name => [name, { provider: name }])),
    requests: new Set(),
  };
  const messages = [];
  const active = new Set();
  const io = {
    async turn(name, prompt) {
      assert.ok(!active.has(name), `Overlapping turns for ${name}`);
      active.add(name);
      try {
        if (prompt.startsWith('Divide this task')) {
          return JSON.stringify({ assignments: names.map(agent => ({ agent, task: `Work for ${agent}` })) });
        }
        if (prompt.startsWith('Answer the original')) return 'Final answer';
        return JSON.stringify(await handler(name, prompt));
      } finally {
        active.delete(name);
      }
    },
    report: text => messages.push(text),
    publish: (name, text) => messages.push(`@${name}: ${text}`),
    shouldStop: () => false,
  };
  return { job, messages, run: () => runRoomJob(job, io) };
}

test('a model asks a busy peer and follows up on an inadequate handoff', async () => {
  let checks = 0;
  const prepared = Promise.withResolvers();
  const { job, messages, run } = fixture(['codex', 'claude'], async (name, prompt) => {
    if (name === 'claude') {
      if (prompt.includes('Dependency delivered?')) {
        checks++;
        return delivery('YES', checks === 1 ? 'An incomplete draft' : 'A corrected result');
      }
      await prepared.promise;
      return done('Draft ready');
    }
    if (prompt.includes('A corrected result')) return done('Accepted the corrected result');
    if (prompt.includes('An incomplete draft')) return ask('claude', 'Please add the missing detail.');
    prepared.resolve();
    return ask('claude', 'Can you send the draft?');
  });

  await run();
  assert.equal(job.state, 'complete', messages.join('\n'));
  assert.equal(checks, 2);
  assert.equal(messages.filter(text => text.includes('Waking @codex')).length, 2);
  assert.ok(messages.indexOf('@claude: Draft ready') < messages.indexOf('@claude: @codex — YES: An incomplete draft'));
});

test('NO leaves the requester idle and later peer progress rechecks the monitor', async () => {
  const checked = Promise.withResolvers();
  let claudeReady = false;
  const { job, messages, run } = fixture(['codex', 'claude', 'reviewer'], async (name, prompt) => {
    if (name === 'codex') {
      return prompt.includes('YES.') ? done('Received the result') : ask('claude', 'Is it ready?');
    }
    if (name === 'reviewer') {
      await checked.promise;
      return prompt.includes('Dependency delivered?') ? delivery('YES', 'Source result') : done('Source result');
    }
    if (prompt.includes('Dependency delivered?')) {
      if (claudeReady) return delivery('YES', 'Result ready');
      checked.resolve();
      return delivery('NO', 'Waiting for reviewer');
    }
    if (!prompt.includes('YES.')) return ask('reviewer', 'Send the source result.');
    claudeReady = true;
    return done('Result ready');
  });

  await run();
  assert.equal(job.state, 'complete', messages.join('\n'));
  const no = messages.indexOf('@claude: @codex — NO: Waiting for reviewer');
  const yes = messages.indexOf('@claude: @codex — YES: Result ready');
  const resumed = messages.indexOf('@codex: Received the result');
  assert.ok(no >= 0 && no < yes && yes < resumed);
});

test('a blocked monitor stops checking until retry and leaves completed work intact', async () => {
  let checks = 0;
  let producerTurns = 0;
  const { job, run } = fixture(['codex', 'claude'], async (name, prompt) => {
    if (name === 'codex') {
      return prompt.includes('YES.') ? done('Finished') : ask('claude', 'Send the missing output.');
    }
    if (prompt.includes('Dependency delivered?')) {
      return ++checks === 1 ? delivery('NO', 'Need clarification') : delivery('YES', 'Delivered');
    }
    producerTurns++;
    return done('Finished my assignment');
  });

  await run();
  assert.equal(job.state, 'blocked');
  assert.equal(checks, 1);
  await run();
  assert.equal(job.state, 'complete');
  assert.equal(checks, 2);
  assert.equal(producerTurns, 1);
});
