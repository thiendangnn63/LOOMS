import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDemoAdapters } from './room-demo.mjs';
import { createRoomHost } from './room-host.mjs';
import { openRoomLog } from './room-log.mjs';

test('chat, a directed turn, an explicit job, and subsequent chat share an ordered transcript', async () => {
  const events = [];
  const prompts = [];
  const demo = createDemoAdapters();
  const host = createRoomHost({
    cwd: process.cwd(),
    adapters: { ask: (...args) => (prompts.push(args[2]), demo.ask(...args)) },
    emit: event => events.push(event),
  });
  await Promise.all([
    host.command('/chat hello'),
    host.command('@Claude start here'),
    host.command('/job write the sample'),
    host.send('what did we just do?'),
  ]);
  const entries = host.transcript();
  assert.deepEqual(entries, events.filter(event => event.type === 'message').map(event => event.entry));
  assert.deepEqual(entries.filter(entry => entry.speaker === 'user').map(entry => entry.text), [
    'hello', '@Claude start here', 'write the sample', 'what did we just do?',
  ]);
  assert.deepEqual(entries.map(entry => entry.id), entries.map((_, index) => index + 1));
  const directed = entries.findIndex(entry => entry.text === '@Claude start here');
  assert.equal(entries[directed + 1].speaker, 'claude');
  assert.equal(entries[directed + 2].speaker, 'user');
  assert.ok(entries.some(entry => entry.text === 'Demo job result: write the sample'));
  assert.ok(prompts.some(prompt => /Demo job result: write the sample[\s\S]*what did we just do\?/.test(prompt)));
  host.close();
});

test('ordered assignments hand output to the reviewer and share one prompt and round', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-chain-'));
  const calls = [];
  let finishWork;
  let startWork;
  const started = new Promise(resolve => { startWork = resolve; });
  const work = new Promise(resolve => { finishWork = resolve; });
  const host = createRoomHost({ cwd, roomID: 'chain', adapters: {
    supportsTools: () => true,
    async ask(name, _member, prompt, _show, context) {
      calls.push({ name, prompt, allowed: context.allowed });
      if (calls.length === 1) {
        startWork();
        return work;
      }
      return name === 'codex' ? 'Revised frontend' : 'Critique delivered';
    },
  } });
  t.after(async () => { host.close(); await rm(cwd, { recursive: true, force: true }); });
  const first = host.send('@codex work on the frontend and then let (@)claude critique it');
  try {
    await Promise.race([started, first]);
    assert.deepEqual(calls.map(call => call.name), ['codex']);
    assert.match(calls[0].prompt, /Ordered step 1 of 2: work on the frontend/);
    assert.ok(!calls[0].allowed.includes('room.ask'));
  } finally { finishWork('Implemented the responsive layout'); }
  await first;
  assert.deepEqual(calls.map(call => call.name), ['codex', 'claude']);
  assert.match(calls[1].prompt, /Ordered step 2 of 2: critique it/);
  assert.match(calls[1].prompt, /Output from the previous step \(@codex\):\nImplemented the responsive layout/);
  assert.deepEqual(host.transcript().map(entry => [entry.speaker, entry.round]), [['user', 1], ['codex', 1], ['claude', 1]]);

  await host.send('Claude critique the website that Codex will make following the below criteria:\n- Accessible navigation');
  assert.deepEqual(calls.slice(2).map(call => call.name), ['codex', 'claude']);
  assert.match(calls[2].prompt, /Ordered step 1 of 2: make the website following the below criteria/);
  assert.match(calls[3].prompt, /Ordered step 2 of 2: critique the website from the preceding step/);
  assert.match(calls[3].prompt, /Revised frontend/);
});

test('a failed ordered step stops the dependent run', async t => {
  const calls = [];
  const host = createRoomHost({ cwd: process.cwd(), adapters: {
    async ask(name) {
      calls.push(name);
      throw new Error('Frontend work failed');
    },
  } });
  t.after(() => host.close());
  await host.send('@codex build the website, then ask Claude to critique it');
  assert.deepEqual(calls, ['codex']);
});

test('preview inspects locally, pins the reviewed prompt, and withholds trimmed history in fresh sessions', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-preview-'));
  const roomID = 'preview';
  const calls = [];
  const resets = [];
  let summaryCalls = 0;
  const host = createRoomHost({ cwd, roomID,
    summarize: () => { summaryCalls++; return {}; },
    adapters: {
      supportsTools: () => true,
      prepare: member => Boolean(member.session),
      reset: member => { resets.push(member); delete member.session; },
      async ask(name, member, prompt, _show, context) {
        const call = { name, member, warm: Boolean(member.session), prompt, snapshot: context.snapshot, allowed: context.allowed };
        calls.push(call);
        member.session = ['provider history'];
        if (prompt.includes('Ordered step')) {
          try { context.tool('room.read_log', {}); }
          catch (error) { call.logError = error.message; }
          if (name === 'codex') call.post = context.tool('room.post', { text: 'Tool post', to: [] });
          return name === 'codex' ? 'Actual predecessor reply' : 'Actual review';
        }
        if (prompt.includes('Broadcast task')) call.read = context.tool('room.read_log', {});
        if (prompt.includes('Restricted task')) {
          assert.throws(() => context.tool('room.ask', { to: 'claude', question: 'Check this', blocking: false }),
            /included in the approved preview/);
        }
        return 'Ordinary reply';
      },
    },
  });
  t.after(async () => { host.close(); await rm(cwd, { recursive: true, force: true }); });
  await host.send('@codex Earlier private message');
  await host.send('@claude Earlier private message');
  await host.flushSummary();
  const before = host.transcript();
  const snapshot = openRoomLog(cwd, roomID).snapshot();
  const summaries = summaryCalls;
  const text = '@chatgpt write the page, then let @claude review it';
  const full = await host.preview(text);
  assert.match(full.targets[0].sections.find(section => section.id === 'history').text, /Earlier private message/);
  assert.ok(full.targets[0].sections.find(section => section.id === 'summary').optional);
  const approval = await host.preview(text, ['summary', 'history'], full);
  assert.deepEqual(approval.targets.map(target => target.name), ['codex', 'claude']);
  assert.equal(approval.targets[0].pending, undefined);
  assert.match(approval.targets[1].pending, /previous step \(@codex\)/);
  assert.ok(approval.targets.every(target => target.tokens > 0 && target.sections.every(section => !section.optional)));
  assert.deepEqual(host.transcript(), before);
  assert.deepEqual(openRoomLog(cwd, roomID).snapshot(), snapshot);
  assert.equal(calls.length, 2);
  assert.equal(summaryCalls, summaries);

  await host.sendPreview(approval);
  const reviewedText = target => target.sections.map(section => section.text).join('\n\n');
  const turns = calls.slice(2);
  assert.deepEqual(turns.map(call => [call.name, call.warm]), [['codex', false], ['claude', false]]);
  assert.notEqual(turns[0].member, calls[0].member);
  assert.notEqual(turns[1].member, calls[1].member);
  assert.ok(calls[0].member.session && calls[1].member.session);
  assert.deepEqual(resets, turns.map(call => call.member));
  assert.equal(turns[0].prompt, reviewedText(approval.targets[0]));
  assert.equal(turns[1].prompt, `${reviewedText(approval.targets[1])}\n\nOutput from the previous step (@codex):\nActual predecessor reply`);
  for (const turn of turns) {
    assert.deepEqual(turn.snapshot, snapshot);
    assert.ok(!turn.allowed.includes('room.read_log'));
    assert.match(turn.logError, /room.read_log is unavailable/);
    assert.doesNotMatch(turn.prompt, /Earlier private message|AGENTS\.md|Tool post/);
  }
  assert.ok(turns[0].post.message_id);
  await host.flushSummary();
  assert.equal(summaryCalls, summaries);
  await assert.rejects(host.sendPreview(approval), { code: 'STALE_PREVIEW' });
  await assert.rejects(host.preview(text, [], full), { code: 'STALE_PREVIEW' });

  const broadcast = await host.preview('Broadcast task');
  await host.sendPreview(broadcast);
  assert.deepEqual(calls.slice(4).map(call => call.prompt), broadcast.targets.map(reviewedText));
  assert.deepEqual(calls.slice(4).map(call => call.read.messages.some(message => message.text === 'Broadcast task')), [false, false]);
  const stale = await host.preview('@codex Another task');
  await host.command('/model codex a-different-model');
  const after = host.transcript();
  await assert.rejects(host.sendPreview(stale), { code: 'STALE_PREVIEW' });
  assert.deepEqual(host.transcript(), after);
  assert.equal(calls.length, 6);
  await host.configure(host.roster(), true);
  const staleAccess = await host.preview('@codex Change the page');
  await host.configure(host.roster(), false);
  await assert.rejects(host.sendPreview(staleAccess), { code: 'STALE_PREVIEW' });
  await host.sendPreview(await host.preview('@codex Restricted task'));
  assert.deepEqual(calls.slice(6).map(call => call.name), ['codex']);
});
