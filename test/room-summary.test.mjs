import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createRoomHost } from '../src/room/room-host.mjs';
import { openRoomLog } from '../src/room/room-log.mjs';
import { createRoomSummary } from '../src/room/room-summary.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-room-summary-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('five fake summary cycles preserve the decision while a concurrent reader sees complete files', { timeout: 10_000 }, async t => {
  const cwd = fixture(t);
  const roomID = 'summary';
  const decisions = 'Keep quantity as a whole number. Prices use integer cents.';
  const observed = [];
  let calls = 0;
  const host = createRoomHost({
    cwd, roomID,
    adapters: { ask: async (_name, _member, prompt) => (observed.push(prompt), `Progress update ${observed.length}`) },
    summarize: async ({ messages, previous }) => {
      calls++;
      assert.ok(calls === 1 || previous.includes(decisions));
      return { goal: 'Build a checkout.', decisions: ['Paraphrased decision that must be ignored'],
        recent_progress: messages.filter(message => message.from === 'claude').map(message =>
          ({ message_id: message.id, text: message.text })) };
    },
  });
  t.after(() => host.close());
  await host.command(`/decide ${decisions}`);
  await host.flushSummary();

  const directory = join(cwd, '.room', roomID);
  const latest = join(directory, 'AGENTS.md');
  const worker = new Worker(String.raw`
    const assert = require('node:assert/strict');
    const { readFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    let reads = 0;
    let timer;
    function read() {
      const text = readFileSync(workerData.path, 'utf8');
      assert.ok(text.startsWith('# Room summary:'));
      assert.ok(text.endsWith('\n'));
      assert.ok(text.includes('- D1: ' + workerData.decision));
      assert.equal((text.match(/^## /gm) || []).length, 7);
      if (++reads === 1) parentPort.postMessage('ready');
      timer = setImmediate(read);
    }
    parentPort.once('message', () => {
      clearImmediate(timer);
      parentPort.postMessage(reads);
      parentPort.close();
    });
    read();
  `, { eval: true, workerData: { path: latest, decision: decisions } });
  t.after(() => worker.terminate());
  const [ready] = await once(worker, 'message');
  assert.equal(ready, 'ready');
  const decisionLog = readFileSync(join(directory, 'decisions.jsonl'), 'utf8');
  const originalSnapshot = readFileSync(join(directory, 'snapshots', 'AGENTS.r0001.md'), 'utf8');
  for (let cycle = 2; cycle <= 5; cycle++) {
    await host.send(`@claude Cycle ${cycle}`);
    await host.flushSummary();
    assert.match(readFileSync(latest, 'utf8'), /- D1: Keep quantity as a whole number\. Prices use integer cents\./);
  }
  const stopped = once(worker, 'message');
  worker.postMessage('stop');
  assert.ok((await stopped)[0] > 1);
  assert.equal(calls, 5);
  assert.equal(readFileSync(join(directory, 'decisions.jsonl'), 'utf8'), decisionLog);
  assert.equal(readFileSync(join(directory, 'snapshots', 'AGENTS.r0001.md'), 'utf8'), originalSnapshot);
  assert.match(observed[0], /AGENTS.md[\s\S]*Build a checkout\.[\s\S]*- D1: Keep quantity/);
  assert.doesNotMatch(readFileSync(latest, 'utf8'), /Paraphrased decision/);
});

test('room summary bounds progress, prunes completed work and answered questions, and keeps code-owned sections', async t => {
  const cwd = fixture(t);
  const log = openRoomLog(cwd, 'budget');
  const add = (from, kind, text, rest = {}) => log.append({ round: 5, from, to: [], kind, text, ...rest });
  const old = add('claude', 'task_update', 'Old completed task', { task_id: 't_old' });
  const answered = add('claude', 'question', 'This question has an answer', { to: ['codex'] });
  add('codex', 'answer', 'Resolved.', { reply_to: answered.id });
  const pending = add('claude', 'question', 'Still open?', { to: ['codex'] });
  const recent = Array.from({ length: 10 }, (_, index) => add('codex', 'task_update', `current work ${index}`, { task_id: 't_current' }));
  writeFileSync(join(log.directory, 'job.json'), JSON.stringify({ tasks: [
    { id: 't_old', agent: 'claude', owns: ['old/**'], state: 'done', done_round: 2 },
    { id: 't_current', agent: 'codex', owns: ['src/**'], state: 'running' },
  ] }));
  mkdirSync(join(log.directory, 'contracts'));
  writeFileSync(join(log.directory, 'contracts', 'api.v1.md'), '# Cart endpoints');
  let shortening = 0;
  const summary = createRoomSummary({
    roomID: 'budget', log,
    summarize: async input => {
      if (input.shorten) {
        shortening++;
        return { goal: 'Never replace the goal when shortening.', recent_progress: input.recent_progress.map(entry =>
          ({ ...entry, text: 'Short progress note.' })) };
      }
      return {
        goal: 'Build the cart.',
        open_questions: [{ message_id: pending.id, text: 'Confirm the cart format.' }],
        recent_progress: [old, ...recent].map(message => ({ message_id: message.id, text: message.text + ' x'.repeat(170) })),
      };
    },
  });
  summary.request(5, true);
  await summary.flush();
  const text = summary.current();
  assert.equal(shortening, 1);
  assert.ok(Buffer.byteLength(text) <= 2000);
  assert.match(text, /## Goal\nBuild the cart\./);
  assert.match(text, /api v1:[^\n]+Cart endpoints/);
  assert.match(text, /\| codex \| t_current \| src\/\*\* \|/);
  assert.match(text, /Confirm the cart format\./);
  assert.doesNotMatch(text, /Old completed task|This question has an answer|Never replace/);
});
