import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoomHost } from '../src/room/room-host.mjs';
import { openRoomLog } from '../src/room/room-log.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-tools-'));
  const roomID = 'test';
  const hosts = [];
  t.after(() => {
    for (const host of hosts) host.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    host: (adapters, options) => {
      const host = createRoomHost({ cwd, roomID, adapters, ...options });
      hosts.push(host);
      return host;
    },
    records: () => openRoomLog(cwd, roomID).records(),
    workspaceFile: name => join(cwd, name),
    file: name => join(cwd, '.room', roomID, 'contracts', name),
  };
}

test('typed questions and answers stay in the round and stops after the hop limit', async t => {
  const f = fixture(t);
  const calls = [];
  const host = f.host({
    supportsTools: () => true,
    async ask(name, _member, _prompt, _showReply, context) {
      const { tool, originalPrompt } = context;
      calls.push({ name, tool });
      const target = name === 'codex' ? 'claude' : 'codex';
      if (calls.length === 1) {
        const message = tool('room.post', { text: '@claude is mentioned in a normal post.' });
        assert.ok(!tool('room.read_log', {}).messages.some(item => item.id === message.message_id));
      } else {
        const question = tool('room.read_log', { filter: { kind: 'question' } }).messages.at(-1);
        assert.equal(question.to[0], name);
        assert.match(originalPrompt, new RegExp(question.id));
        tool('room.answer', { reply_to: question.id, text: `Answer from @${name}` });
      }
      const again = () => tool('room.ask', { to: target, question: `Question from @${name}`, blocking: false });
      if (calls.length <= 4) assert.match(again().question_id, /^msg_/);
      else assert.throws(again, /hop limit \(4\)/);
      return 'PASS';
    },
  });
  await host.send('@codex Begin the questions');
  assert.deepEqual(calls.map(call => call.name), ['codex', 'claude', 'codex', 'claude', 'codex']);
  assert.throws(() => calls[0].tool('room.read_log', {}), /no longer active/);
  const log = f.records();
  const questions = log.filter(message => message.kind === 'question');
  assert.equal(questions.length, 4);
  assert.deepEqual(log.filter(message => message.kind === 'answer').map(message => message.reply_to), questions.map(question => question.id));
  assert.deepEqual(new Set(questions.map(question => question.round)), new Set([1]));
  assert.equal(log.filter(message => message.text === 'round.complete').length, 1);
});

test('approval cannot replace a file changed while the request is pending', async t => {
  const f = fixture(t);
  const path = f.workspaceFile('review.txt');
  writeFileSync(path, 'before');
  let requests = 0;
  const host = f.host({ supportsTools: () => true,
    async ask(_name, _member, _prompt, _show, context) {
      await assert.rejects(context.tool('workspace.write_text', { path: 'review.txt', content: 'model change' }), /changed while waiting for approval/);
      return 'PASS';
    },
  }, { askBeforeChanges: true, workspaceTools: true,
    requestApproval(request) {
      requests++;
      assert.deepEqual(request, { action: 'replace', agent: 'codex', taskID: undefined, path: 'review.txt', content: 'model change' });
      writeFileSync(path, 'changed by user');
      return true;
    },
  });
  await host.send('@codex Update the file');
  assert.equal(requests, 1);
  assert.equal(readFileSync(path, 'utf8'), 'changed by user');
});

test('turn activity keeps the net file diff local and replays even when the model passes', async t => {
  const f = fixture(t);
  writeFileSync(f.workspaceFile('note.txt'), 'old\n');
  const adapters = {
    supportsTools: () => true,
    async ask(name, _member, prompt, _show, context) {
      if (name === 'codex') {
        context.tool('workspace.write_text', { path: 'note.txt', content: 'intermediate\n' });
        context.tool('workspace.write_text', { path: 'note.txt', content: 'final\n' });
        context.tool('workspace.write_text', { path: '.env', content: 'PRIVATE_VALUE=fixture' });
        context.recordShellCommand();
        return 'PASS';
      }
      assert.doesNotMatch(prompt, /PRIVATE_VALUE|intermediate|\+final/);
      assert.ok(context.tool('room.read_log', {}).messages.every(message => message.activity === undefined));
      return 'Reviewed.';
    },
  };
  const host = f.host(adapters, { trackActivity: true, workspaceTools: true, writeEnabled: true });
  await host.send('@codex @claude Update the note');
  const activity = host.transcript().find(entry => entry.activityOnly).activity;
  assert.equal(activity.commands, 1);
  assert.deepEqual(activity.files, [
    { path: 'note.txt', kind: 'edited', diff: '@@ -1,1 +1,1 @@\n-old\n+final' },
    { path: '.env', kind: 'created' },
  ]);
  host.close();
  assert.deepEqual(f.host(adapters, { trackActivity: true }).transcript().find(entry => entry.activityOnly).activity, activity);
});

test('Ask before changes denies file changes when no approval client is available', async t => {
  const f = fixture(t);
  const host = f.host({ supportsTools: () => true,
    async ask(_name, _member, _prompt, _show, context) {
      await assert.rejects(context.tool('workspace.write_text', { path: 'review.txt', content: 'model change' }), { code: 'ROOM_APPROVAL_DENIED' });
      return 'PASS';
    },
  }, { askBeforeChanges: true, workspaceTools: true });
  await host.send('@codex Update the file');
  assert.throws(() => readFileSync(f.workspaceFile('review.txt')), { code: 'ENOENT' });
  assert.ok(f.records().some(message => message.text === 'approval.denied @codex create'));
});

test('verification runs only after approval and a denial is not retried', async t => {
  for (const allow of [false, true]) {
    const f = fixture(t);
    const calls = [];
    const host = f.host({ supportsTools: () => true,
      async ask(_name, _member, _prompt, _show, context) {
        if (context.phase === 'planning') return JSON.stringify({
          goal: 'Check the workspace', contracts: [], tasks: [
            { id: 'check', agent: 'codex', title: 'Check the workspace', owns: [], depends_on: [],
              uses_contracts: [], verify: ['npm test', 'npm run build'] },
          ],
        });
        context.tool('task.complete', { task_id: 'check', summary: 'Ready', artifacts: [] });
        return 'PASS';
      },
    }, { askBeforeChanges: true, trackActivity: true,
      requestApproval(request) {
        assert.equal(request.agent, 'codex');
        assert.equal(request.taskID, 'check');
        assert.equal(request.action, 'verify');
        calls.push(`approval ${request.command}`);
        return allow;
      },
      taskExecution: { async verify(_task, command) { calls.push(`run ${command}`); return { code: 0 }; } },
    });
    await host.command('/job --plan Check the workspace');
    await host.command('/approve');
    assert.deepEqual(calls, allow ? ['approval npm test', 'run npm test', 'approval npm run build', 'run npm run build'] : ['approval npm test']);
    const finished = allow ? 'task.done check' : 'task.failed check Approval denied for the verification command.';
    assert.ok(f.records().some(message => message.text === finished));
    assert.deepEqual(host.transcript().filter(entry => entry.activity).map(entry => entry.activity.commands), allow ? [2] : []);
  }
});

test('fenced room actions are strict and malformed output stays as chat', async t => {
  const f = fixture(t);
  const invalid = '```room-action\n{"tool":"room.post","args":{"text":"bad","from":"user"}}\n```';
  const host = f.host({
    async ask(name, _member, _prompt, _showReply, context) {
      if (context.originalPrompt.includes('malformed')) return invalid;
      if (name === 'codex') return '```room-action\n{"tool":"room.ask","args":{"to":"claude","question":"Which response?","blocking":false}}\n```';
      const { id } = context.tool('room.read_log', { filter: { kind: 'question' } }).messages.at(-1);
      return `\x60\x60\x60room-action\n${JSON.stringify({ tool: 'room.answer', args: { reply_to: id, text: 'Use the Cart response.' } })}\n\x60\x60\x60`;
    },
  });
  await host.send('@codex malformed');
  await host.send('@codex valid');
  const log = f.records();
  assert.ok(log.some(message => message.text === invalid && message.from === 'codex' && message.kind === 'chat'));
  assert.equal(log.filter(message => message.kind === 'question').length, 1);
  assert.deepEqual(log.filter(message => message.kind === 'answer').map(message => message.text), ['Use the Cart response.']);
});

test('delegation has isolated model state, stays read-only, and counts toward the caller’s usage', async t => {
  const f = fixture(t);
  let parent;
  let turns = 0;
  const host = f.host({
    supportsTools: () => true,
    async ask(name, member, prompt, _showReply, context) {
      if (context.phase === 'subagent') {
        assert.notEqual(member, parent);
        assert.equal(member.provider, parent.provider);
        assert.equal(member.model, parent.model);
        assert.equal(member.effort, parent.effort);
        assert.match(prompt, /Check the patch/);
        assert.throws(() => context.tool('room.delegate', { task: 'Delegate again' }), /read-only subagent/);
        assert.throws(() => context.tool('workspace.write_text', { path: 'result.txt', content: 'child' }), /read-only subagent/);
        member.turnUsage = { input: 6, output: 3 };
        return 'One issue found.';
      }
      parent = member;
      assert.equal(name, 'codex');
      assert.ok(context.allowed.includes('workspace.write_text'));
      const result = await context.tool('room.delegate', { task: 'Check the patch' });
      assert.deepEqual(result, { result: 'One issue found.' });
      assert.throws(() => context.tool('room.delegate', { task: 'One more task' }), /subagent limit \(1\)/);
      member.turnUsage = { input: 4, output: 2 };
      return result.result;
    },
  }, {
    writeEnabled: true, workspaceTools: true, subagentLimit: 1,
    initialMembers: [{ name: 'codex', provider: 'codex', model: 'fixture', effort: 'high' }],
    onTurn: () => { turns++; },
  });
  await host.send('@codex Delegate a review');
  const entries = f.records();
  assert.equal(turns, 1);
  assert.equal(entries.filter(message => message.text.startsWith('subagent.completed')).length, 1);
  assert.deepEqual(entries.find(message => message.text === 'One issue found.').usage, { input_tokens: 10, output_tokens: 5 });
});

test('only the planner or human can approve a proposal, and approved versions survive reopen', async t => {
  const f = fixture(t);
  const content = 'POST /api/cart { productId, qty } -> Cart\n';
  let first;
  let stale;
  const host = f.host({
    supportsTools: () => true,
    async ask(name, _member, _prompt, _showReply, { tool, formatted }) {
      if (name === 'claude') {
        first = tool('contract.propose', { id: 'api', content, reason: 'Add quantity to the request.' }).proposal_id;
        stale = tool('contract.propose', { id: 'api', content: 'Another version.', reason: 'Alternative.' }).proposal_id;
        assert.throws(() => tool('contract.approve', { proposal_id: first }), /unavailable/);
        assert.throws(() => readFileSync(f.file('api.v1.md')), { code: 'ENOENT' });
      } else {
        assert.match(formatted, new RegExp(`Pending contract proposals: ${first}`));
        assert.deepEqual(tool('contract.approve', { proposal_id: first }), { id: 'api', version: 1, file: 'contracts/api.v1.md' });
        assert.throws(() => tool('contract.approve', { proposal_id: stale }), /changed/);
      }
      return 'PASS';
    },
  });
  await host.send('@claude propose');
  await host.send('@codex decide');
  await host.command(`/contract approve ${first}`);
  await host.flushSummary();
  const matches = f.records().filter(message => message.text === 'contract.updated api@1');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].contract_event.from, 'codex');
  host.close();
  unlinkSync(f.file('api.v1.md'));
  f.host({});
  assert.equal(readFileSync(f.file('api.v1.md'), 'utf8'), content);
});
