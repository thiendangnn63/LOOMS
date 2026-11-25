import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoomHost } from './room-host.mjs';
import { openRoomLog } from './room-log.mjs';
import { patchRoomPlan } from './room-plan-patch.mjs';
import { validateRoomPlan } from './room-plan.mjs';
import { runRoomSchedule } from './room-scheduler.mjs';

function shoppingPlan() {
  return {
    goal: 'Shopping website with a cart',
    contracts: [{ id: 'api', version: 1, owner: 'codex', content: 'POST /api/cart -> Cart' }],
    tasks: [
      { id: 'backend', agent: 'codex', title: 'Implement the cart API', owns: ['server/**'], depends_on: [],
        uses_contracts: ['api@1'], verify: ['npm run -w server test'] },
      { id: 'frontend', agent: 'claude', title: 'Build a cart UI', owns: ['web/**'], depends_on: [],
        uses_contracts: ['api@1'], verify: ['npm run -w web build'] },
      { id: 'integration', agent: 'codex', title: 'Integrate the cart UI and API', owns: ['web/src/api/**', 'e2e/**'],
        depends_on: ['backend', 'frontend'], uses_contracts: ['api@1'], verify: ['npm run e2e'] },
      { id: 'review', agent: 'claude', title: 'Review the integrated cart', owns: [],
        depends_on: ['integration'], uses_contracts: ['api@1'], verify: [], kind: 'review' },
    ],
  };
}

test('scheduler exhausts verification retries and reports stalled dependents', async () => {
  const job = shoppingPlan();
  job.tasks.forEach(task => { task.state = 'pending'; });
  const events = [];
  await runRoomSchedule(job, {
    currentRound: () => 7,
    change(type, task) { events.push([type, task?.id]); },
    async run(task, control) { control.finish({ summary: 'Ready', artifacts: [] }); },
    async verify(task) {
      if (task.id === 'backend') return { code: 7, output: Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n') };
      return { code: 0, output: 'Pass' };
    },
  });
  const [backend, frontend, integration, review] = job.tasks;
  assert.equal(backend.state, 'failed');
  assert.equal(backend.runs, 3);
  assert.equal(backend.verification[0].exit_code, 7);
  assert.equal(backend.verification[0].output.split('\n').length, 200);
  assert.equal(frontend.state, 'done');
  assert.equal(integration.state, 'pending');
  assert.equal(review.state, 'pending');
  assert.equal(job.state, 'stalled');
  assert.deepEqual(events.at(-1), ['job.stalled', undefined]);
});

test('scheduler warns and pauses at the budget before starting another task', async () => {
  const job = shoppingPlan();
  job.token_budget = 10;
  job.tasks[1].depends_on.push('backend');
  job.tasks.forEach(task => { task.state = 'pending'; });
  const events = [];
  const starts = [];
  await runRoomSchedule(job, {
    currentRound: () => 7,
    change(type) { events.push(type); },
    async run(task, control) {
      starts.push(task.id);
      control.finish({ summary: 'Ready', artifacts: [] });
      return { input_tokens: 8, output_tokens: 2 };
    },
    async verify() { return { code: 0 }; },
  });
  assert.deepEqual(starts, ['backend']);
  assert.deepEqual(events.slice(-2), ['job.budget_warning', 'job.paused']);
  assert.equal(job.state, 'paused');
});

test('accepts dependent shared ownership and rejects invalid cycles, overlaps, agents, and verification', () => {
  const check = plan => validateRoomPlan(plan, ['codex', 'claude']);
  assert.deepEqual(check(shoppingPlan()), []);

  const cycle = shoppingPlan();
  cycle.tasks[0].depends_on.push('review');
  assert.match(check(cycle).join('\n'), /Dependency cycle: backend → review → integration → backend/);

  const overlap = shoppingPlan();
  overlap.tasks[0].owns = ['src/**/cart?.ts'];
  overlap.tasks[1].owns = ['src/components/*t1.ts'];
  assert.match(check(overlap).join('\n'), /Overlapping owns for backend and frontend/);
  overlap.tasks[1].owns = ['src/components/cart12.ts'];
  assert.deepEqual(check(overlap), []);
  overlap.tasks[1].owns = ['src/cart1.ts'];
  assert.match(check(overlap).join('\n'), /Overlapping owns/);

  const fields = shoppingPlan();
  fields.tasks[1].agent = 'gemini';
  fields.tasks[1].verify = [];
  fields.tasks[1].uses_contracts = ['api@2'];
  fields.tasks[1].depends_on = ['missing'];
  assert.deepEqual(check(fields), [
    'Task frontend agent gemini is not in the room.',
    'Task frontend is missing a verify command.',
    'Task frontend refers to unknown contract api@2.',
    'Task frontend depends on unknown task missing.',
  ]);
});

test('structured shopping job runs independent work together and wakes tasks after verification and answers', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-scheduler-'));
  const roomID = 'schedule';
  const storage = () => openRoomLog(cwd, roomID).records();
  const starts = [];
  const verifyCalls = [];
  const errors = [];
  const host = createRoomHost({ cwd, roomID,
    emit(event) { if (event.error) errors.push(event.text); },
    adapters: {
      supportsTools: () => true,
      async ask(name, member, _prompt, _showReply, context) {
        if (context.phase === 'planning') return JSON.stringify(shoppingPlan());
        if (context.phase !== 'task') {
          const question = context.tool('room.read_log', { filter: { kind: 'question' } }).messages.at(-1);
          assert.equal(name, 'codex');
          context.tool('room.answer', { reply_to: question.id, text: 'Use the agreed Cart response.' });
          return 'PASS';
        }
        const id = /^Execute task ([a-z]+):/.exec(context.originalPrompt)[1];
        starts.push({ id, cutoff: context.snapshot.id, prompt: context.originalPrompt });
        const count = starts.filter(start => start.id === id).length;
        if (id === 'frontend' && count === 1) {
          context.tool('room.ask', { to: 'codex', question: 'Which response was agreed?', blocking: true });
        } else {
          context.tool('task.complete', { task_id: id, summary: `${id} implementation`, artifacts: [] });
        }
        member.turnUsage = { input: 5, output: 2 };
        return 'PASS';
      },
    },
    taskExecution: {
      async verify(task, command) {
        verifyCalls.push({ task: task.id, command });
        if (task.id === 'backend' && verifyCalls.length === 1) return { code: 1, output: 'Missing Cart shape' };
        return { code: 0, output: 'Pass' };
      },
    },
  });
  t.after(() => {
    host.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  await host.command('/job --plan Build a shop');
  await host.command('/approve');
  const job = JSON.parse(readFileSync(join(cwd, '.room', roomID, 'job.json'), 'utf8'));
  assert.deepEqual(errors, []);
  assert.equal(job.state, 'done');
  assert.deepEqual(starts.map(start => start.id), ['backend', 'frontend', 'backend', 'frontend', 'integration', 'review']);
  assert.equal(starts[0].cutoff, starts[1].cutoff);
  assert.match(starts[2].prompt, /Missing Cart shape/);
  assert.match(starts[3].prompt, /room has answered msg_/);
  assert.deepEqual(verifyCalls.map(attempt => attempt.task), ['backend', 'backend', 'frontend', 'integration']);
  assert.ok(job.tasks.every(task => task.state === 'done'));
  assert.equal(job.usage.input_tokens, 30);
  const log = storage();
  const indexOf = text => log.findIndex(entry => entry.text === text);
  assert.ok(indexOf('task.running frontend') < indexOf('task.done backend'));
  assert.ok(Math.max(indexOf('task.done backend'), indexOf('task.done frontend')) < indexOf('task.running integration'));
  assert.ok(log.some(entry => entry.text.startsWith('task.blocked frontend')));
  assert.ok(log.some(entry => entry.text.startsWith('task.ready backend Verification exited 1')));
});

test('JSON Patch applies to a copy and rejects unsafe and failed edits', () => {
  const original = shoppingPlan();
  const edited = patchRoomPlan(original, [
    { op: 'test', path: '/tasks/0/agent', value: 'codex' },
    { op: 'replace', path: '/tasks/0/title', value: 'Add a cart endpoint' },
    { op: 'copy', from: '/tasks/0/verify/0', path: '/tasks/0/verify/-' },
    { op: 'move', from: '/tasks/0/verify/1', path: '/tasks/2/verify/0' },
  ]);
  assert.equal(original.tasks[0].title, 'Implement the cart API');
  assert.equal(edited.tasks[0].title, 'Add a cart endpoint');
  assert.equal(edited.tasks[2].verify[0], original.tasks[0].verify[0]);
  assert.throws(() => patchRoomPlan(original, [{ op: 'add', path: '/__proto__/polluted', value: 1 }]), /pointer key/i);
  assert.throws(() => patchRoomPlan(original, [{ op: 'test', path: '/tasks/0/agent', value: 'claude' }]), /patch test failed/);
});

test('room asks the selected planner to fix validation errors and persists approval and editing', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-planning-'));
  const roomID = 'planning';
  const status = [];
  const calls = [];
  const stored = () => JSON.parse(readFileSync(join(cwd, '.room', roomID, 'job.json'), 'utf8'));
  const adapters = {
    async ask(name, _member, _prompt, _showReply, context) {
      calls.push({ name, phase: context.phase, tool: context.tool, prompt: context.originalPrompt });
      const plan = shoppingPlan();
      if (calls.length === 1) return 'not JSON';
      if (calls.length === 2) plan.tasks[1].verify = [];
      return JSON.stringify(plan);
    },
  };
  const open = () => createRoomHost({ cwd, roomID, adapters, emit(event) {
    if (event.type === 'status') status.push(event.text);
  } });
  let host = open();
  t.after(() => {
    host.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  await host.command('/job --planner @claude Build a shop');
  assert.deepEqual(calls.map(call => call.name), ['claude', 'claude', 'claude']);
  assert.ok(calls.every(call => call.phase === 'planning' && !call.tool));
  assert.match(calls[1].prompt, /Return only the plan as a JSON object/);
  assert.match(calls[2].prompt, /frontend is missing a verify command/);
  assert.equal(stored().state, 'awaiting_approval');
  assert.ok(status.some(message => message.includes('| backend | @codex |') && message.includes('/approve')));

  await assert.rejects(host.command('/edit [{"op":"replace","path":"/tasks/0/verify","value":[]}]'), /missing a verify command/);
  assert.equal(stored().tasks[0].verify.length, 1);
  await host.command('/edit [{"op":"replace","path":"/tasks/0/title","value":"Ship cart API"}]');
  await host.flushSummary();
  host.close();
  host = open();
  await host.command('/approve');
  assert.equal(stored().planner, 'claude');
  assert.equal(stored().state, 'approved');
  assert.equal(stored().tasks[0].title, 'Ship cart API');
  assert.deepEqual(stored().tasks.map(task => task.state), ['pending', 'pending', 'pending', 'pending']);

  await host.command('/cancel');
  assert.equal(stored().state, 'cancelled');
  await host.command('/auto-approve on');
  await host.flushSummary();
  host.close();
  host = open();
  await host.command('/job --plan Build a shop');
  assert.equal(stored().state, 'approved');
  assert.equal(stored().planner, 'codex');
});

test('structured plans use read-only project research, saved preferences, and verified outcomes across jobs', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'looms-assignment-'));
  const roomID = 'assignment';
  writeFileSync(join(cwd, 'README.md'), 'The project check is npm test.');
  const events = [];
  const contexts = [];
  const started = [];
  let verifyPasses = false;
  const initialMembers = [
    { name: 'gemini', provider: 'gemini' },
    { name: 'codex', provider: 'codex', model: 'builder-fixture', effort: 'high' },
    { name: 'claude', provider: 'claude', model: 'review-fixture', effort: 'medium' },
  ];
  const plan = {
    goal: 'Fix the regression',
    contracts: [],
    tasks: [
      { id: 'fix', agent: 'codex', title: 'Fix the regression', task_type: 'debugging', skill: 'repo-debug',
        assignment_reason: 'Use the project debugging skill and regression suite.', owns: ['src/**'], depends_on: [],
        uses_contracts: [], verify: ['npm test'] },
      { id: 'audit', agent: 'claude', title: 'Review the patch', kind: 'review', task_type: 'review',
        assignment_reason: 'Use the room preference for review.', owns: [], depends_on: ['fix'], uses_contracts: [], verify: [] },
    ],
  };
  const open = () => createRoomHost({
    cwd, roomID, initialMembers, workspaceTools: true,
    describeMember: name => ({ skills: name === 'codex' ? ['repo-debug'] : [] }),
    resolveSkill: () => ({ name: 'repo-debug', content: 'Check the failing fixture first.' }),
    emit: event => events.push(event),
    adapters: {
      connected: provider => provider !== 'gemini',
      supportsTools: () => true,
      async ask(name, member, prompt, _show, context) {
        if (context.phase === 'planning') {
          assert.equal(name, 'codex');
          assert.match(context.tool('workspace.read_text', { path: 'README.md' }).content, /npm test/);
          assert.throws(() => context.tool('workspace.write_text', { path: 'README.md', content: 'bad' }), /unavailable/);
          assert.match(prompt, /workspace_read_text/);
          const [, data] = /verified task evidence \(JSON\):\n([^\n]+)/.exec(context.originalPrompt);
          contexts.push(JSON.parse(data));
          return JSON.stringify(plan);
        }
        const task = plan.tasks.find(task => task.agent === name);
        started.push(task.id);
        if (task.skill) assert.match(prompt, /Check the failing fixture first/);
        else assert.doesNotMatch(prompt, /Check the failing fixture first/);
        member.turnUsage = { input: 8, output: 4 };
        context.tool('task.complete', { task_id: task.id, summary: 'Done', artifacts: [] });
        return 'PASS';
      },
    },
    taskExecution: { async verify() { return { code: verifyPasses ? 0 : 1, output: 'Regression check' }; } },
  });
  let host = open();
  t.after(() => {
    host.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  await host.command('/job --prefer review @claude');
  await host.command('/auto-approve on');
  await host.command('/auto-approve off');
  await host.command('/job --plan Fix the regression');
  assert.deepEqual(started, []);
  assert.equal(contexts[0].preferences.review, 'claude');
  assert.deepEqual(contexts[0].profiles.map(profile => profile.name), ['codex', 'claude']);
  assert.deepEqual(contexts[0].profiles[0].skills, ['repo-debug']);
  assert.equal(contexts[0].profiles[0].model, 'builder-fixture');
  const firstPanel = events.findLast(event => event.planText).planText;
  assert.match(firstPanel, /Use the project debugging skill[\s\S]*Room preference · No comparable verified results yet/);
  await assert.rejects(host.command('/edit [{"op":"replace","path":"/tasks/0/agent","value":"claude"}]'), /\/repo-debug.*unavailable for @claude/);
  await host.command('/approve');
  assert.deepEqual(started, ['fix', 'fix', 'fix']);
  verifyPasses = true;
  await host.command('/retry fix');
  assert.deepEqual(started, ['fix', 'fix', 'fix', 'fix', 'audit']);
  const outcomes = openRoomLog(cwd, roomID).records().filter(record => record.job_outcomes).map(record => record.job_outcomes.tasks);
  assert.deepEqual(outcomes.map(tasks => tasks.map(task => task.result)), [['failed'], ['passed', 'unscored']]);
  await host.flushSummary();
  host.close();

  host = open();
  await host.command('/job --plan Fix a similar regression');
  const scorecard = contexts.at(-1).scorecard;
  assert.equal(scorecard.codex.debugging.passed, 1);
  assert.equal(scorecard.codex.debugging.failed, 0);
  assert.equal(scorecard.codex.debugging.verified_tokens, 48);
  assert.equal(scorecard.claude.review.unscored, 1);
  assert.match(events.findLast(event => event.planText).planText, /1\/1 verified in this room[\s\S]*completed without scored checks/);
});
