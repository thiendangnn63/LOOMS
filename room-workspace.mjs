import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ownsPath, pathsIntersect } from './room-plan.mjs';

const protectedName = /^(?:\.git|\.room|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const credentialName = /^(?:\.env(?:\..*)?|\.(?:aws|azure|docker|gnupg|kube|ssh|codex|claude|claude\.json|credentials\.json|git-credentials|netrc|npmrc|pypirc)|(?:credentials|service-account)\.json|id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?)$|\.(?:key|pem|p12|pfx|jks|keystore)$/i;
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const shareableDiffText = (path, text) => path.split('/').some(part => credentialName.test(part)) ||
  text.includes('\0') || privateKey.test(text) ? undefined : text;
function previousText(path, file, stat) {
  if (!stat) return null;
  if (stat.size > 65_536 || path.split('/').some(part => credentialName.test(part))) return;
  try { return shareableDiffText(path, readFileSync(file, 'utf8')); }
  catch { return undefined; }
}
const wait = (signal, ms) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  function stop() { clearTimeout(timer); reject(signal.reason); }
  signal?.addEventListener('abort', stop, { once: true });
});

export function ensureDirectory(parent, name) {
  const path = join(parent, name);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isDirectory()) throw new Error(`Expected a regular directory at ${path}.`);
  return path;
}

export function ownedWorkspace(cwd, patterns, beforeWrite = operation => operation()) {
  const root = realpathSync(cwd);
  function target(path, createParents) {
    if (!ownsPath(patterns, path)) throw new Error(`Path ${path} is outside the task's owned paths.`);
    const parts = path.split('/');
    if (parts.some(part => protectedName.test(part) || /[" .]$/.test(part) || part.includes('"'))) {
      throw new Error(`Path ${path} is reserved or invalid.`);
    }
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const child = join(parent, part);
      const stat = lstatSync(child, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`Path ${path} crosses a symbolic link or non-directory.`);
      parent = !stat && createParents ? ensureDirectory(parent, part) : child;
    }
    const file = join(parent, parts.at(-1));
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Path ${path} must be a regular file.`);
    return { file, parent, stat };
  }

  const versionOf = stat => stat ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') : null;
  function checkVersion(path, stat, expected) {
    if (expected !== undefined && versionOf(stat) !== expected) {
      throw new Error(`File ${path} changed while waiting for approval. Request the change again.`);
    }
  }

  return {
    inspect(path) {
      const { stat } = target(path, false);
      return { exists: Boolean(stat), version: versionOf(stat) };
    },
    write(path, content, expected, onChange) {
      return beforeWrite(() => {
        if (expected !== undefined) checkVersion(path, target(path, false).stat, expected);
        const { file, parent, stat } = target(path, true);
        const before = onChange && previousText(path, file, stat);
        const temporary = join(parent, `.ccgpt-${randomUUID()}.tmp`);
        writeFileSync(temporary, content, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o644, flush: true });
        try { renameSync(temporary, file); }
        catch (error) { unlinkSync(temporary); throw error; }
        onChange?.({ path, before, after: shareableDiffText(path, content) });
        return { path, written: true };
      });
    },
    remove(path, expected, onChange) {
      return beforeWrite(() => {
        const { file, stat } = target(path, false);
        checkVersion(path, stat, expected);
        if (stat) {
          const before = onChange && previousText(path, file, stat);
          unlinkSync(file);
          onChange?.({ path, before, after: null });
        }
        return { path, removed: Boolean(stat) };
      });
    },
  };
}

export function isProtectedPath(path, directories) {
  return directories.some(directory => {
    const child = relative(directory, path);
    return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
  });
}

export function readableWorkspace(cwd, directories = []) {
  const root = realpathSync(cwd);
  const concealed = name => protectedName.test(name) || credentialName.test(name) || name.toLowerCase() === 'node_modules';
  function locate(path) {
    if (path !== '.' && (!ownsPath(['**'], path) || path.split('/').some(concealed))) throw new Error('Use a relative path inside the workspace.');
    const target = resolve(root, path);
    if (isProtectedPath(target, directories)) throw new Error('LOOMS application data is outside workspace tool access.');
    const file = realpathSync(target);
    const child = relative(root, file);
    if (isAbsolute(child) || child.split(sep).some(part => part === '..' || concealed(part)) || isProtectedPath(file, directories)) {
      throw new Error('Path leaves the workspace tool access.');
    }
    return file;
  }
  return {
    list(path) {
      const directory = locate(path);
      return readdirSync(directory, { withFileTypes: true }).filter(entry => !concealed(entry.name) &&
        !isProtectedPath(join(directory, entry.name), directories)).slice(0, 250)
        .map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    },
    read(path) {
      const file = locate(path);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 65_536) throw new Error('Choose a regular text file of at most 64 KiB.');
      const content = readFileSync(file, 'utf8');
      if (content.includes('\0')) throw new Error('This is not a text file.');
      if (privateKey.test(content)) throw new Error('Workspace tools do not share files containing private keys.');
      return { path, content };
    },
  };
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid workspace lock owner.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

export function workspaceLocks(cwd) {
  const directory = ensureDirectory(ensureDirectory(realpathSync(cwd), '.room'), 'locks');
  const mutex = join(directory, 'claims.lock');

  function transaction(operation) {
    let handle;
    try { handle = openSync(mutex, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entry = lstatSync(mutex, { throwIfNoEntry: false });
      if (entry && !entry.isFile()) throw new Error(`Invalid workspace lock registry at ${mutex}.`);
      if (entry && Date.now() - entry.mtimeMs > 5_000) {
        let owner;
        try { owner = readFileSync(mutex, 'utf8'); }
        catch (readError) { if (readError.code !== 'ENOENT') throw readError; return; }
        if (!owner || !processAlive(Number(owner))) {
          throw new Error(`The workspace lock registry was abandoned. Resolve the stale registry file at ${mutex}.`);
        }
      }
      return;
    }
    try {
      writeFileSync(handle, String(process.pid));
      return operation();
    }
    finally { closeSync(handle); unlinkSync(mutex); }
  }

  function claims() {
    return readdirSync(directory).filter(name => /^[\da-f-]{36}\.json$/.test(name)).flatMap(name => {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) throw new Error('Invalid workspace lock record.');
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (processAlive(owner.pid)) return [owner];
      unlinkSync(path);
      return [];
    });
  }

  async function eventually(operation, signal) {
    while (!signal?.aborted) {
      const result = transaction(operation);
      if (result !== undefined) return result;
      await wait(signal, 35);
    }
    throw signal.reason;
  }

  async function claim(patterns, signal, verify = false) {
    const filename = join(directory, `${randomUUID()}.json`);
    await eventually(() => {
      if (claims().some(other => verify ? other.verify : !other.verify &&
          patterns.some(left => other.patterns.some(right => pathsIntersect(left, right))))) return;
      const temporary = `${filename}.tmp`;
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, patterns, verify }), { flag: 'wx', mode: 0o600, flush: true });
      try { renameSync(temporary, filename); }
      catch (error) { unlinkSync(temporary); throw error; }
      return true;
    }, signal);
    let released = false;
    return {
      beforeWrite(operation) {
        if (released) throw new Error('The task no longer holds its file locks.');
        signal?.throwIfAborted();
        const result = transaction(() => {
          if (claims().some(owner => owner.verify)) throw new Error('A verification command is running. Retry the edit after it completes.');
          return operation();
        });
        if (!result) throw new Error('The workspace lock registry is busy. Retry the edit.');
        return result;
      },
      async release() {
        if (released) return;
        released = true;
        await eventually(() => { unlinkSync(filename); return true; });
      },
    };
  }

  return { claim, verify: signal => claim([], signal, true) };
}
