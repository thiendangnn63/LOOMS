import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const maxPathBytes = 4096;
const maxSkillBytes = 128 * 1024;
const maxFrontmatterBytes = 8 * 1024;
const maxDescriptionBytes = 512;
const windows = process.platform === 'win32';
const uid = process.getuid?.();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const privateKey = /-{2,}[ \t]*BEGIN[ \t]+[^\r\n-]{0,80}\bPRIVATE[ \t]+KEY\b|PuTTY-User-Key-File-\d+:/i;

function validName(name) {
  return typeof name === 'string' && name.length <= 64 && /^[a-z0-9][a-z0-9_-]*$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u.test(name);
}

function localPath(value, absolute) {
  if (typeof value !== 'string' || !value || value.length > maxPathBytes || Buffer.byteLength(value) > maxPathBytes ||
      /[\p{Cc}]/u.test(value) || (absolute && !isAbsolute(value))) {
    throw new Error(absolute ? 'Enter an absolute path to a local skill folder or SKILL.md.' : 'Invalid LOOMS profile path.');
  }
  const parts = value.split(windows ? /[\\/]/u : '/');
  if (parts.includes('..')) throw new Error('Use a path without parent-directory (..) segments.');
  const path = resolve(value);
  if (path.length > maxPathBytes || Buffer.byteLength(path) > maxPathBytes || (windows &&
      (!/^[a-z]:\\/iu.test(path) || (absolute && !/^[a-z]:[\\/]/iu.test(value)) ||
        parts.slice(/^[a-z]:/iu.test(value) ? 1 : 0).some(part => part !== '.' && /[:]|[. ]$/u.test(part))))) {
    throw new Error('Use a standard local filesystem path for skills.');
  }
  return path;
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function directories(path, { create = false, storage = false, expected } = {}) {
  const root = parse(path).root;
  let current = root;
  const chain = [];
  for (const part of ['', ...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory()) throw new Error('Skill paths must use real directories, not symlinks.');
    if (storage && !windows && ((info.uid !== uid && info.uid !== 0) || ((info.mode & 0o022) && !(info.mode & 0o1000)))) {
      throw new Error('The LOOMS skill library requires a protected profile path.');
    }
    if (expected && !sameFile(info, expected[chain.length])) throw new Error('A skill directory changed during access.');
    chain.push(info);
  }
  return chain;
}

function scalar(text) {
  if (!text || text.startsWith('#')) return '';
  if (text[0] === '"' || text[0] === "'") {
    const quoted = text[0] === '"' ? /^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/u.exec(text) :
      /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/u.exec(text);
    if (!quoted) throw new Error('Invalid quoted skill frontmatter.');
    if (text[0] === "'") return quoted[1].replace(/''/gu, "'");
    try { return JSON.parse(quoted[1]); }
    catch { throw new Error('Invalid quoted skill frontmatter.'); }
  }
  if (/^[\[\]{}&*!|>]/u.test(text)) throw new Error('Skill frontmatter name and description must be text.');
  return text.replace(/[ \t]+#.*$/u, '').trimEnd();
}

function metadata(content, folderName) {
  const fields = new Map();
  const opening = /^\uFEFF?---[ \t]*\r?\n/u.exec(content);
  if (opening) {
    const rest = content.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[ \t]*\r?$/mu.exec(rest);
    if (!closing || Buffer.byteLength(rest.slice(0, closing.index)) > maxFrontmatterBytes) {
      throw new Error('Skill frontmatter must close within 8 KiB.');
    }
    const lines = rest.slice(0, closing.index).split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      const field = /^(name|description):[ \t]*(.*)$/u.exec(lines[i]);
      if (!field) continue;
      const [, key, value] = field;
      if (fields.has(key)) throw new Error('Duplicate name or description in skill frontmatter.');
      // Only parse the portable fields we use; leave the Markdown itself unchanged.
      if (key === 'description' && /^[>|][+-]?[ \t]*(?:#.*)?$/u.test(value)) {
        const block = [];
        while (i + 1 < lines.length && /^(?:[ \t]|$)/u.test(lines[i + 1])) block.push(lines[++i].trim());
        fields.set(key, block.join(' '));
      } else {
        fields.set(key, scalar(value));
      }
    }
  }
  const suppliedName = fields.get('name')?.trim() || folderName;
  if (!/^[A-Za-z0-9_-]+$/u.test(suppliedName)) throw new Error('Use a skill name with ASCII letters, digits, hyphens or underscores.');
  const name = suppliedName.toLowerCase();
  if (!validName(name)) throw new Error('Use a valid skill command name of up to 64 characters.');
  const description = (fields.get('description') ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (Buffer.byteLength(description) > maxDescriptionBytes) throw new Error('The skill description is limited to 512 bytes.');
  return { name, description };
}

function decodeMarkdown(bytes) {
  if (bytes.length > maxSkillBytes) throw new Error('SKILL.md is limited to 128 KiB.');
  let content;
  try { content = decoder.decode(bytes); }
  catch { throw new Error('SKILL.md must be UTF-8 Markdown.'); }
  if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(content)) {
    throw new Error('SKILL.md must contain nonempty text without binary control characters.');
  }
  if (privateKey.test(content)) throw new Error('Skill instructions must not contain private keys.');
  return content;
}

async function readMarkdown(file, checkParent, stored = false) {
  const requireFile = info => {
    if (!info.isFile() || (stored && !windows && (info.uid !== uid || (info.mode & 0o777) !== 0o400))) {
      throw new Error('Skill instructions must be a regular file, not a symlink or an insecure profile file.');
    }
    if (info.size > maxSkillBytes) throw new Error('SKILL.md is limited to 128 KiB.');
  };
  await checkParent();
  const before = await lstat(file);
  requireFile(before);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    requireFile(opened);
    await checkParent();
    if (!sameFile(before, opened) || !sameFile(opened, await lstat(file))) throw new Error('The skill file changed during access.');
    const bytes = Buffer.alloc(maxSkillBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxSkillBytes) throw new Error('SKILL.md is limited to 128 KiB.');
    const after = await handle.stat();
    requireFile(after);
    await checkParent();
    // Removing the staging hard link may change a stored file's ctime, but not its contents.
    if (size !== opened.size || size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        (!stored && opened.ctimeMs !== after.ctimeMs) || !sameFile(after, await lstat(file))) {
      throw new Error('The skill file changed during access.');
    }
    const data = bytes.subarray(0, size);
    return { bytes: data, content: decodeMarkdown(data) };
  } finally {
    await handle.close();
  }
}

export async function openSkillLibrary(directory) {
  const profile = localPath(directory, false);
  const storage = join(profile, 'skills');
  const requireProfile = info => {
    if (!windows && (info.uid !== uid || (info.mode & 0o022))) throw new Error('The LOOMS skill library requires a protected profile directory.');
  };
  const profileChain = await directories(profile, { create: true, storage: true });
  requireProfile(profileChain.at(-1));
  try { await mkdir(storage, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const chain = [...profileChain, await lstat(storage)];
  const checkStorage = async () => {
    const current = await directories(storage, { storage: true, expected: chain });
    requireProfile(current.at(-2));
    if (!windows && (current.at(-1).uid !== uid || (current.at(-1).mode & 0o077))) {
      throw new Error('The LOOMS skill library requires a private skills directory.');
    }
  };
  await checkStorage();

  async function read(name) {
    if (!validName(name)) throw new Error('Invalid skill command name.');
    let content;
    try { ({ content } = await readMarkdown(join(storage, `${name}.md`), checkStorage, true)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Skill /${name} is not in the local library.`);
      throw error;
    }
    const info = metadata(content, name);
    if (info.name !== name) throw new Error('The stored skill name does not match its instructions.');
    return { ...info, content };
  }

  async function store(bytes, content, folderName, validateName) {
    const info = metadata(content, folderName);
    if (['help', 'skills'].includes(info.name)) throw new Error(`/${info.name} is a built-in command. Choose another skill name.`);
    await validateName?.(info.name);
    const destination = join(storage, `${info.name}.md`);
    const temporary = join(storage, `.${randomUUID()}.tmp`);
    await checkStorage();
    const handle = await open(temporary, 'wx', windows ? 0o600 : 0o400);
    try {
      try {
        await handle.writeFile(bytes);
        if (!windows) await handle.chmod(0o400);
        await handle.sync();
      } finally { await handle.close(); }
      await checkStorage();
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if ((await read(info.name)).content !== content) throw new Error(`A different skill named /${info.name} is already imported.`);
      }
    } finally {
      await checkStorage().then(() => unlink(temporary)).catch(() => {});
    }
    return info;
  }

  return {
    async list() {
      await checkStorage();
      const skills = [];
      for await (const entry of await opendir(storage)) {
        if (!entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3);
        if (!validName(name)) continue;
        const skill = await read(name).catch(() => undefined);
        if (skill) skills.push({ name, description: skill.description });
      }
      return skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    },
    read,
    importMarkdown: (bytes, name, validateName) => store(bytes, decodeMarkdown(bytes), name, validateName),
    async importSkill(path, validateName) {
      const source = localPath(path, true);
      const parent = dirname(source);
      let sourceChain = await directories(parent);
      const sourceInfo = await lstat(source);
      let folder = parent;
      let file = source;
      if (sourceInfo.isDirectory()) {
        folder = source;
        file = join(source, 'SKILL.md');
        if (folder !== parent) sourceChain = [...sourceChain, sourceInfo];
      } else if (!sourceInfo.isFile() || basename(source) !== 'SKILL.md') {
        throw new Error('Choose a real skill folder or a regular SKILL.md file, not a symlink.');
      }
      const { bytes, content } = await readMarkdown(file, () => directories(folder, { expected: sourceChain }));
      return store(bytes, content, basename(folder), validateName);
    },
  };
}
