import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ownsPath } from './room-plan.mjs';
import { ensureDirectory, ownedWorkspace, workspaceLocks } from './room-workspace.mjs';

function command(file, args, { cwd, signal, shell = false, env, tail = false, onStart }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'] });
    if (onStart) child.once('spawn', onStart);
    let output = '';
    let errors = '';
    let failure;
    function terminate() {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/t', '/f', '/pid', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
        killer.once('close', code => { if (code) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    }
    signal?.addEventListener('abort', terminate, { once: true });
    const append = (current, chunk) => {
      const text = current + chunk;
      if (tail) return text.slice(-100_000);
      if (text.length > 8_000_000) {
        failure = new Error('Workspace command output exceeded 8 MB.');
        terminate();
      }
      return text.slice(0, 8_000_000);
    };
    child.stdout.setEncoding('utf8').on('data', chunk => { output = append(output, chunk); });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (!tail) errors = append(errors, chunk); else output = append(output, chunk); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      signal?.removeEventListener('abort', terminate);
      if (signal?.aborted || failure) reject(signal?.reason ?? failure);
      else resolve({ code, output, errors });
    });
  });
}

const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^GIT_/i.test(key))), GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' });
const entries = text => text.split('\0').filter(Boolean);
const runVerification = (cwd, text, signal, onStart) => command(text, [], { cwd, signal, onStart, shell: true, tail: true });

async function repoRoot(cwd, signal) {
  let probe;
  try { probe = await command('git', ['rev-parse', '--show-toplevel'], { cwd, signal, env: gitEnvironment() }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let directory = cwd;
    for (;;) {
      if (lstatSync(join(directory, '.git'), { throwIfNoEntry: false })) throw new Error('Git is required to create task worktrees in this repository.');
      const parent = dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }
  if (probe.code === 0) return realpathSync(probe.output.trim());
  if (!probe.errors.includes('not a git repository')) throw new Error(probe.errors.trim() || 'Could not inspect the Git repository.');
}

function lockIsolation(cwd) {
  const locks = workspaceLocks(cwd);
  return {
    mode: 'lock',
    async begin(task, signal) {
      const lease = await locks.claim(task.owns, signal);
      return {
        cwd, files: ownedWorkspace(cwd, task.owns, lease.beforeWrite), close: lease.release,
        async verify(text, verifySignal, onStart) {
          const exclusive = await locks.verify(verifySignal);
          try { return await runVerification(cwd, text, verifySignal, onStart); }
          finally { await exclusive.release(); }
        },
      };
    },
  };
}

async function worktreeIsolation(root, cwd, directory, roomID, jobID, signal) {
  if (!/^[a-z0-9_-]+$/i.test(roomID) || !/^job_[1-9]\d*$/.test(jobID)) throw new Error('Invalid room or job ID for worktrees.');
  const base = ensureDirectory(ensureDirectory(directory, 'worktrees'), jobID);
  const subfolder = relative(root, cwd);
  const prefix = `room/${roomID}/${jobID}`;
  const branches = `${prefix}/tasks`;
  const integration = join(base, 'integration');
  const integrationBranch = `${prefix}/integration`;
  const taskRoot = ensureDirectory(base, 'tasks');
  const env = gitEnvironment();
  const settings = ['-c', `core.hooksPath=${join(base, 'no-hooks')}`, '-c', 'commit.gpgSign=false',
    '-c', 'user.name=CCGPT', '-c', 'user.email=ccgpt@localhost', '-c', 'core.longpaths=true'];
  const git = (cwd, args, scope = signal) => command('git', [...settings, ...args], { cwd, signal: scope, env });

  async function checked(cwd, args, scope) {
    const result = await git(cwd, args, scope);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.errors || result.output).trim()}`);
    return result.output;
  }

  async function ensureTree(path, branch, from, scope) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isDirectory() || realpathSync((await checked(path, ['rev-parse', '--show-toplevel'], scope)).trim()) !== realpathSync(path) ||
          (await checked(path, ['symbolic-ref', '--short', 'HEAD'], scope)).trim() !== branch) {
        throw new Error(`The room worktree ${path} does not match ${branch}.`);
      }
      return false;
    }
    await checked(root, ['worktree', 'add', '-b', branch, path, from], scope);
    return true;
  }

  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) throw new Error('Create the first Git commit before starting a structured job in this repository.');
  await ensureTree(integration, integrationBranch, head.output.trim(), signal);
  const unfinished = await git(integration, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
  if (unfinished.code === 0) await checked(integration, ['merge', '--abort'], signal);
  let merging = Promise.resolve();

  async function merge(taskPath, branch, scope) {
    const operation = merging.then(async () => {
      scope.throwIfAborted();
      const result = await git(integration, ['merge', '--no-edit', branch], scope);
      if (result.code === 0) return;
      const conflicts = entries(await checked(integration, ['diff', '--name-only', '--diff-filter=U', '-z'], scope));
      if (!conflicts.length) throw new Error(`Git integration failed: ${(result.errors || result.output).trim()}`);
      await checked(integration, ['merge', '--abort'], scope);
      const source = (await checked(taskPath, ['rev-parse', 'HEAD'], scope)).trim();
      const paths = conflicts.map(path => relative(subfolder || '.', path).split(sep).join('/'));
      const error = new Error(`merge_conflict: ${paths.join(', ')}`);
      error.mergeConflict = { paths, source };
      throw error;
    });
    merging = operation.catch(() => {});
    return operation;
  }

  return {
    mode: 'worktree', integrationBranch,
    async begin(task, scope) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(task.id)) throw new Error('Invalid worktree task ID.');
      const tree = join(taskRoot, task.id);
      const branch = `${branches}/${task.id}`;
      const created = await ensureTree(tree, branch, integrationBranch, scope);
      if (created && task.merge_source) {
        if (!/^[a-f0-9]{40,64}$/.test(task.merge_source)) throw new Error('Invalid fix-up source commit.');
        const result = await git(tree, ['merge', '--no-ff', '--no-commit', task.merge_source], scope);
        if (result.code !== 0 && !entries(await checked(tree, ['diff', '--name-only', '--diff-filter=U', '-z'], scope)).length) {
          throw new Error(`Could not prepare the merge fix-up: ${(result.errors || result.output).trim()}`);
        }
      }
      const workdir = subfolder ? join(tree, subfolder) : tree;
      return {
        cwd: workdir, files: ownedWorkspace(workdir, task.owns),
        verify: (text, verifySignal, onStart) => runVerification(workdir, text, verifySignal, onStart),
        async finish(finishSignal) {
          const changed = new Set([
            ...entries(await checked(tree, ['diff', 'HEAD', '--name-only', '-z', '--no-renames'], finishSignal)),
            ...entries(await checked(tree, ['ls-files', '--others', '--exclude-standard', '-z'], finishSignal)),
          ]);
          for (const file of changed) {
            const path = relative(workdir, join(tree, file)).split(sep).join('/');
            if (!ownsPath(task.owns, path)) throw new Error(`Worktree contains a change outside the task's owned paths: ${file}`);
          }
          if (changed.size) {
            await checked(tree, ['add', '-A', '--', ...changed], finishSignal);
            await checked(tree, ['commit', '-m', `Complete room task ${task.id}`], finishSignal);
          }
          await merge(tree, branch, finishSignal);
        },
      };
    },
  };
}

export async function openRoomIsolation({ cwd, directory, roomID, job, signal }) {
  cwd = realpathSync(cwd);
  const root = await repoRoot(cwd, signal);
  const mode = root ? 'worktree' : 'lock';
  if (job.isolation && job.isolation !== mode) throw new Error(`This job was started in ${job.isolation} mode. Start a new job to use ${mode}.`);
  return root ? worktreeIsolation(root, cwd, directory, roomID, job.id, signal) : lockIsolation(cwd);
}
