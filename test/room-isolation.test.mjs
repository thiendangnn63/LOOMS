import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoomHost } from '../src/room/room-host.mjs';
import { openRoomIsolation } from '../src/room/room-isolation.mjs';
import { openRoomLog } from '../src/room/room-log.mjs';
import { ownedWorkspace, workspaceLocks } from '../src/room/room-workspace.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
  '-c', 'commit.gpgSign=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ccgpt-isolation-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('lock mode reserves overlapping paths, lets disjoint tasks work, and releases the reservation', async t => {
  const cwd = fixture(t);
  const signal = new AbortController().signal;
  const isolation = await openRoomIsolation({ cwd, job: { id: 'job_1' }, signal });
  assert.equal(isolation.mode, 'lock');
  const source = await isolation.begin({ owns: ['src/**'] }, signal);
  const other = await isolation.begin({ owns: ['docs/**'] }, signal);
  const waiting = new AbortController();
  const duplicate = workspaceLocks(cwd).claim(['src/feature.js'], waiting.signal);
  waiting.abort(new Error('The competing owner was blocked'));
  await assert.rejects(duplicate, /competing owner was blocked/);

  assert.throws(() => source.files.write('docs/readme.md', 'Outside ownership'), /outside.*owned paths/);
  source.files.write('src/feature.js', 'source');
  other.files.write('docs/readme.md', 'docs');
  const verify = await workspaceLocks(cwd).verify(signal);
  assert.throws(() => other.files.write('docs/readme.md', 'wait'), /verification command is running/);
  await verify.release();
  await source.close();
  const successor = await isolation.begin({ owns: ['src/feature.js'] }, signal);
  assert.throws(() => source.files.remove('src/feature.js'), /no longer holds/);
  successor.files.write('src/feature.js', 'successor');
  assert.equal(readFileSync(join(cwd, 'src', 'feature.js'), 'utf8'), 'successor');
  await Promise.all([other.close(), successor.close()]);
});

test('owned file tools reject paths through a link and protect room state', t => {
  const cwd = fixture(t);
  const outside = fixture(t);
  const workspace = ownedWorkspace(cwd, ['**']);
  symlinkSync(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workspace.write('linked/out.txt', 'bad'), /symbolic link/);
  assert.throws(() => workspace.write('../out.txt', 'bad'), /outside.*owned paths/);
  assert.throws(() => workspace.write('.room/log.jsonl', 'bad'), /reserved or invalid/);
  assert.throws(() => workspace.write('.git/config', 'bad'), /reserved or invalid/);
  assert.equal(existsSync(join(outside, 'out.txt')), false);
  assert.equal(existsSync(join(cwd, '.room')), false);
});

test('a live structured job needs edit permission, verifies under lock mode, and records metrics', async t => {
  const cwd = fixture(t);
  const roomID = 'shared-room';
  const room = join(cwd, '.room', roomID);
  const host = createRoomHost({ cwd, roomID, liveTasks: true, trackActivity: true, adapters: {
    supportsTools: () => true,
    async ask(_name, member, _prompt, _showReply, ctx) {
      member.turnUsage = { input: 5, output: 3, costUsd: 0.002 };
      if (ctx.phase === 'planning') return JSON.stringify({ goal: 'Write a result', contracts: [], tasks: [
        { id: 'writer', agent: 'codex', title: 'Write a text file', owns: ['result.txt'], depends_on: [], uses_contracts: [],
          verify: ['node -e "process.exit(require(\'node:fs\').existsSync(\'result.txt\') ? 0 : 1)"'] },
      ] });
      ctx.tool('workspace.write_text', { path: 'result.txt', content: 'Done.' });
      ctx.tool('task.complete', { task_id: 'writer', summary: 'Wrote the result', artifacts: ['result.txt'] });
      return 'PASS';
    },
  } });
  t.after(() => host.close());
  await host.command('/job --plan Write a result');
  await assert.rejects(host.command('/approve'), /Enable Workspace edits/);
  await host.configure(host.roster(), true);
  await host.command('/approve');
  const job = JSON.parse(readFileSync(join(room, 'job.json'), 'utf8'));
  assert.equal(job.state, 'done');
  assert.equal(job.isolation, 'lock');
  assert.equal(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'Done.');
  assert.deepEqual(readdirSync(join(cwd, '.room', 'locks')), []);
  const metrics = JSON.parse(readFileSync(join(room, 'metrics.json'), 'utf8'));
  assert.equal(metrics.success, true);
  assert.deepEqual(metrics.tokens, { summarizer: 0, codex: 16 });
  assert.equal(metrics.cost_usd, 0.004);
  const activity = host.transcript().filter(entry => entry.activity).map(entry => entry.activity);
  assert.deepEqual(activity.map(item => item.commands), [0, 1]);
  assert.match(activity[0].files[0].diff, /\+Done\./);
  assert.equal(metrics.tasks[0].runs, 1);
});

test('Git mode refuses a checkout that has no first commit', async t => {
  const cwd = fixture(t);
  git(cwd, 'init', '-b', 'main');
  mkdirSync(join(cwd, 'room-data'));
  await assert.rejects(openRoomIsolation({ cwd, directory: join(cwd, 'room-data'), roomID: 'test', job: { id: 'job_1' } }), /first Git commit/);
  assert.equal(existsSync(join(cwd, '.room', 'locks')), false);
});

test('Git worktree conflict creates an owned fix-up and feeds its merge to the dependent task', async t => {
  const cwd = fixture(t);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, 'shared.txt'), 'base\n');
  git(cwd, 'add', 'shared.txt');
  git(cwd, 'commit', '-m', 'Fixture base');
  const initialCommit = git(cwd, 'rev-parse', 'HEAD');
  const roomID = 'git-room';
  const room = join(cwd, '.room', roomID);
  const worktrees = join(room, 'worktrees', 'job_1');
  const integration = join(worktrees, 'integration');
  const failures = [];
  const starts = [];
  const check = 'node -e "process.exit(0)"';
  const host = createRoomHost({ cwd, roomID, liveTasks: true, writeEnabled: true, adapters: {
    supportsTools: () => true,
    async ask(name, _member, _prompt, _showReply, ctx) {
      if (ctx.phase === 'planning') return JSON.stringify({ goal: 'Exercise isolated checkout', contracts: [], tasks: [
        { id: 'backend', agent: 'codex', title: 'Change shared file', owns: ['shared.txt'], depends_on: [], uses_contracts: [], verify: [check] },
        { id: 'frontend', agent: 'claude', title: 'Write result', owns: ['result.txt'], depends_on: ['backend'], uses_contracts: [], verify: [check] },
      ] });
      try {
        const id = /^Execute task ([a-z_0-9]+):/.exec(ctx.originalPrompt)[1];
        starts.push([id, name]);
        const tree = join(worktrees, 'tasks', id);
        const write = (path, content) => ctx.tool('workspace.write_text', { path, content });
        if (id === 'backend') {
          assert.throws(() => write('result.txt', 'not owned'), /outside.*owned paths/);
          write('shared.txt', 'branch update\n');
          writeFileSync(join(integration, 'shared.txt'), 'integration update\n');
          git(integration, 'add', 'shared.txt');
          git(integration, 'commit', '-m', 'Planted concurrent change');
        } else if (id === 'fix_backend_1') {
          assert.match(readFileSync(join(tree, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
          write('shared.txt', 'merged update\n');
        } else {
          assert.equal(readFileSync(join(tree, 'shared.txt'), 'utf8'), 'merged update\n');
          write('result.txt', 'done\n');
        }
        ctx.tool('task.complete', { task_id: id, summary: 'Fixture work completed', artifacts: [] });
        return 'PASS';
      } catch (error) { failures.push(error); throw error; }
    },
  } });
  t.after(() => host.close());
  await host.command('/job --plan Exercise isolated checkout');
  await host.command('/approve');

  assert.deepEqual(failures, []);
  assert.deepEqual(starts, [['backend', 'codex'], ['fix_backend_1', 'codex'], ['frontend', 'claude']]);
  const job = JSON.parse(readFileSync(join(room, 'job.json'), 'utf8'));
  assert.equal(job.state, 'done');
  assert.equal(job.isolation, 'worktree');
  assert.equal(job.integration_branch, git(integration, 'branch', '--show-current'));
  assert.equal(job.tasks[0].state, 'failed');
  assert.match(job.tasks[0].reason, /merge_conflict: shared.txt/);
  assert.ok(openRoomLog(cwd, roomID).records().some(entry => entry.text === 'task.fixup_created fix_backend_1'));
  assert.equal(readFileSync(join(integration, 'result.txt'), 'utf8'), 'done\n');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), initialCommit);
  assert.equal(readFileSync(join(cwd, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(join(cwd, '.room', 'locks')), false);
});
