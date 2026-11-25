import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoomHost } from './room-host.mjs';
import { openRoomLog } from './room-log.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-room-log-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const parse = path => readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));

test('parallel workers share a cutoff and a chained run sees their finished work', { timeout: 5000 }, async t => {
  const cwd = fixture(t);
  const directory = join(cwd, '.room', 'parallel');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'AGENTS.md'), 'Original shared summary');
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const started = Promise.withResolvers();
  const published = Promise.withResolvers();
  const workers = new Map();
  let chained;
  const host = createRoomHost({
    cwd, roomID: 'parallel',
    adapters: {
      async ask(name, member, prompt, _show, run) {
        member.turnUsage = { input: 8, output: 2 };
        if (run.originalPrompt.startsWith('Divide this task')) {
          return JSON.stringify({ assignments: [
            { agent: 'codex', task: 'Build the backend' },
            { agent: 'claude', task: 'Build the frontend' },
          ] });
        }
        if (run.originalPrompt.includes('Your assignment:')) {
          workers.set(name, { prompt, snapshot: run.snapshot });
          if (workers.size === 2) started.resolve();
          const text = await (name === 'codex' ? first.promise : second.promise);
          return JSON.stringify({ action: 'done', text });
        }
        chained = { prompt, snapshot: run.snapshot };
        return 'Integrated result';
      },
    },
    emit(event) {
      if (event.type === 'message' && event.entry.text === 'Backend result A') {
        assert.equal(parse(join(directory, 'log.jsonl')).at(-1).text, 'Backend result A');
        published.resolve();
      }
    },
  });
  t.after(() => host.close());
  const job = host.command('/job Build the sample');
  await started.promise;
  assert.deepEqual(workers.get('codex').snapshot, workers.get('claude').snapshot);
  assert.equal(workers.get('codex').snapshot.id, 'msg_0001');
  writeFileSync(join(directory, 'AGENTS.md'), 'Summary changed during the round');
  first.resolve('Backend result A');
  await published.promise;
  second.resolve('Frontend result B');
  await job;
  for (const worker of workers.values()) {
    assert.doesNotMatch(worker.prompt, /Backend result A|Frontend result B/);
    assert.match(worker.prompt, /AGENTS.md\nOriginal shared summary[\s\S]*Room messages through msg_0001[\s\S]*Triggering message/);
  }
  assert.match(chained.prompt, /Original shared summary[\s\S]*\[codex\] Backend result A[\s\S]*\[claude\] Frontend result B[\s\S]*Triggering message/);
  assert.equal(chained.snapshot.id, 'msg_0003');
  const entries = parse(join(directory, 'log.jsonl')).filter(message => message.kind !== 'summary');
  assert.deepEqual(entries.map(({ id, round, from, kind }) => [id, round, from, kind]), [
    ['msg_0001', 1, 'user', 'chat'],
    ['msg_0002', 1, 'codex', 'task_update'],
    ['msg_0003', 1, 'claude', 'task_update'],
    ['msg_0004', 1, 'codex', 'task_update'],
    ['msg_0005', 1, 'system', 'event'],
  ]);
  assert.deepEqual(entries[1].usage, { input_tokens: 8, output_tokens: 2 });
  assert.equal(entries.at(-1).text, 'round.complete');
});

test('room replay and native history changes preserve the existing log bytes', async t => {
  const cwd = fixture(t);
  const path = join(cwd, '.room', 'history', 'log.jsonl');
  const prompts = [];
  const adapters = { ask: async (_name, _member, prompt) => (prompts.push(prompt), 'reply') };
  const host = createRoomHost({ cwd, roomID: 'history', adapters, nativeHistoryHash: '0'.repeat(64), contextMessages: 1 });
  await host.send('@claude First prompt');
  host.checkpoint('a'.repeat(64));
  host.close();
  const initial = readFileSync(path, 'utf8');

  const reopened = createRoomHost({
    cwd, roomID: 'history', adapters, nativeHistoryHash: 'a'.repeat(64), contextMessages: 1,
    history: [{ speaker: 'user', text: 'Ignored transport projection' }],
  });
  assert.deepEqual(reopened.transcript().map(entry => entry.text), ['@claude First prompt', 'reply']);
  assert.equal(readFileSync(path, 'utf8'), initial);
  await reopened.send('@claude Follow-up');
  assert.match(prompts.at(-1), /\[claude\] reply[\s\S]*Triggering message\n\[user\] @claude Follow-up/);
  assert.doesNotMatch(prompts.at(-1), /\[user\] @claude First prompt/);
  reopened.checkpoint('b'.repeat(64));
  reopened.close();
  const beforeEdit = readFileSync(path, 'utf8');

  const edited = createRoomHost({
    cwd, roomID: 'history', adapters, nativeHistoryHash: 'c'.repeat(64),
    history: [{ speaker: 'user', text: 'Edited native prompt' }],
  });
  assert.ok(readFileSync(path, 'utf8').startsWith(beforeEdit));
  assert.deepEqual(edited.transcript().map(entry => entry.text), ['Edited native prompt']);
  await edited.command('/new');
  assert.deepEqual(edited.transcript(), []);
  assert.ok(readFileSync(path, 'utf8').startsWith(initial));
  assert.deepEqual(parse(path)[0].to, ['claude']);
  edited.close();
});

test('a stale writer and a partial line are detected without changing existing bytes', t => {
  const cwd = fixture(t);
  const writer = openRoomLog(cwd, 'race');
  const stale = openRoomLog(cwd, 'race');
  writer.append({ round: 1, from: 'user', to: [], kind: 'chat', text: 'committed' });
  assert.throws(() => stale.append({ round: 1, from: 'user', to: [], kind: 'chat', text: 'stale' }), /changed in another process/);
  appendFileSync(writer.path, '{"id":');
  const damaged = readFileSync(writer.path);
  assert.throws(() => openRoomLog(cwd, 'race'), /incomplete record/);
  assert.deepEqual(readFileSync(writer.path), damaged);
});
