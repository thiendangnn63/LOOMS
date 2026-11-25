import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const skillName = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const marketName = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const repoName = /^[a-z0-9][a-z0-9-]{0,38}\/(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/i;
const gitSha = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder('utf8', { fatal: true });
const blobSHA = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const skillLimit = 128 * 1024;

function parseSource(input) {
  const [source, ref = '', ...extra] = input.trim().split('#');
  const repo = source.replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
  if (!repoName.test(repo) || extra.length || (ref && !/^[a-z0-9_./-]{1,128}$/i.test(ref))) {
    throw new Error('Use a public GitHub repository as owner/repo or owner/repo#ref.');
  }
  return { repo, ref };
}

function relativePath(value) {
  if (typeof value !== 'string') return;
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (path.length > 1024 || /[\\:\p{Cc}]/u.test(path) || path.split('/').some(part =>
    part === '..' || part === '.' || (!part && path))) return;
  return path;
}

function parseJSON(bytes, label) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error(`${label} contains invalid JSON.`); }
}

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeNew(directory, name, data) {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, join(directory, name));
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally { await unlink(temporary); }
}

async function readBytes(response, limit, label) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} returned an empty response.`);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error(`${label} exceeds the supported size.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function buildCatalog(files, manifest, repo) {
  const candidatesByPath = new Map();
  const skillPaths = [...files.keys()].filter(path => path.endsWith('/SKILL.md'));
  const insert = (path, group, fallback) => {
    if (!files.has(path) || candidatesByPath.has(path)) return;
    const parts = path.split('/');
    const name = (parts.at(-2) ?? fallback)?.toLowerCase();
    if (skillName.test(name ?? '')) candidatesByPath.set(path, { name, group, path, sha: files.get(path) });
  };
  const children = (directory, group) => {
    const prefix = directory ? `${directory}/` : '';
    for (const path of skillPaths) {
      if (path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(path.slice(prefix.length))) insert(path, group);
    }
  };
  if (manifest) {
    for (const plugin of manifest.plugins) {
      const root = relativePath(plugin?.source);
      if (root === undefined || !skillName.test(plugin?.name ?? '')) continue;
      const prefix = root ? `${root}/` : '';
      const group = plugin.name.toLowerCase();
      if (plugin.skills === undefined) {
        children(`${prefix}skills`, group);
        continue;
      }
      const locations = Array.isArray(plugin.skills) ? plugin.skills : [plugin.skills];
      for (const location of locations) {
        const path = relativePath(location);
        if (!path) continue;
        if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) insert(prefix + path, group, group);
        else {
          insert(`${prefix}${path}/SKILL.md`, group);
          children(prefix + path, group);
        }
      }
    }
  } else {
    for (const root of ['skills', '.agents/skills', '.claude/skills']) children(root);
    insert('SKILL.md', undefined, repo.split('/').at(-1));
  }

  const candidates = [...candidatesByPath.values()];
  const counts = new Map();
  for (const { name } of candidates) counts.set(name, (counts.get(name) ?? 0) + 1);
  return candidates.map(({ name, group, path, sha }) => ({
    id: counts.get(name) > 1 ? path.replace(/\/SKILL\.md$/, '') : name,
    name, path, sha, ...(group && { group }),
  })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function createSkillMarketplaces({ directory, fetcher = fetch, signal }) {
  const storage = join(directory, 'skill-marketplaces');
  const fileName = name => `market-${name}.json`;

  async function ensureStorage() {
    try { await mkdir(storage, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(storage)).isDirectory()) throw new Error('LOOMS requires a regular marketplace directory.');
  }

  async function list() {
    await ensureStorage();
    const files = (await readdir(storage)).filter(name => /^market-[a-z0-9][a-z0-9._-]{0,99}\.json$/.test(name));
    const markets = await Promise.all(files.map(file => readJSON(join(storage, file))));
    return markets.filter(Boolean);
  }

  async function request(url, limit, label) {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetcher(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub’s public request limit was reached. Try again after it resets.');
      throw new Error(`${label} could not be fetched from GitHub (HTTP ${response.status}).`);
    }
    return readBytes(response, limit, label);
  }

  async function rawFile(repo, revision, path, sha, limit, label) {
    if (!repoName.test(repo) || !gitSha.test(revision) || relativePath(path) !== path || !gitSha.test(sha)) {
      throw new Error('The saved marketplace file reference is invalid.');
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const bytes = await request(`https://raw.githubusercontent.com/${repo}/${revision}/${encoded}`, limit, label);
    if (blobSHA(bytes) !== sha) throw new Error(`${label} changed since the marketplace revision was registered.`);
    return bytes;
  }

  async function add(input) {
    const { repo, ref } = parseSource(input);
    const existing = (await list()).find(entry => entry.repo === repo && entry.ref === ref);
    if (existing) return existing;
    const commits = `https://api.github.com/repos/${repo}/commits?per_page=1${ref ? `&sha=${encodeURIComponent(ref)}` : ''}`;
    const revisions = parseJSON(await request(commits, 1024 * 1024, 'Marketplace revision'), 'Marketplace revision');
    const commit = Array.isArray(revisions) ? revisions[0] : undefined;
    const revision = commit?.sha;
    const tree = commit?.commit?.tree?.sha;
    if (!gitSha.test(revision ?? '') || !gitSha.test(tree ?? '')) throw new Error('GitHub did not return a marketplace revision.');
    const result = parseJSON(await request(`https://api.github.com/repos/${repo}/git/trees/${tree}?recursive=1`,
      8 * 1024 * 1024, 'Marketplace tree'), 'Marketplace tree');
    if (!Array.isArray(result?.tree) || result.truncated) throw new Error('GitHub did not return a complete marketplace tree.');
    const files = new Map(result.tree.filter(entry => entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode) &&
      entry.path && relativePath(entry.path) === entry.path && gitSha.test(entry.sha)).map(({ path, sha }) => [path, sha]));
    const manifestPath = '.claude-plugin/marketplace.json';
    const manifest = files.has(manifestPath) ? parseJSON(await rawFile(repo, revision, manifestPath, files.get(manifestPath),
      1024 * 1024, 'Claude marketplace manifest'), 'Claude marketplace manifest') : undefined;
    if (manifest !== undefined && (!marketName.test(manifest?.name ?? '') || !Array.isArray(manifest.plugins))) {
      throw new Error('The Claude marketplace manifest needs a valid name and a plugins array.');
    }
    const name = (manifest?.name ?? repo.split('/').at(-1)).toLowerCase();
    if (!marketName.test(name)) throw new Error('The repository needs a valid marketplace name.');
    const skills = buildCatalog(files, manifest, repo);
    if (!skills.length) throw new Error('This repository has no supported SKILL.md entries.');
    const snapshot = { name, repo, ref, revision, skills };
    if (await writeNew(storage, fileName(name), snapshot)) return snapshot;
    const saved = await readJSON(join(storage, fileName(name)));
    if (saved?.repo === repo && saved?.ref === ref) return saved;
    throw new Error(`A different source is already registered as ${name}.`);
  }

  async function install(spec, library, validateName) {
    const match = /^([^@]+)@([a-z0-9][a-z0-9._-]{0,99})$/i.exec(spec.trim());
    if (!match) throw new Error('Use skill@marketplace to install a skill.');
    const [, id, name] = match;
    await ensureStorage();
    const market = await readJSON(join(storage, fileName(name.toLowerCase())));
    if (!market) throw new Error(`Add the ${name} marketplace first.`);
    const entry = market.skills.find(skill => skill.id === id);
    if (!entry) throw new Error(`Skill ${id} is unavailable in ${name}. Open the marketplace picker to see its skills.`);
    const cacheKey = createHash('sha256').update(JSON.stringify([market.repo, market.revision, entry.path, entry.sha])).digest('hex');
    const cache = `install-${cacheKey}.json`;
    const memo = await readJSON(join(storage, cache));
    const saved = memo && await library.read(memo.name).catch(() => undefined);
    if (saved && blobSHA(Buffer.from(saved.content, 'utf8')) === entry.sha) {
      await validateName?.(saved.name);
      return { name: saved.name, description: saved.description };
    }
    const markdown = await rawFile(market.repo, market.revision, entry.path, entry.sha, skillLimit, 'SKILL.md');
    const skill = await library.importMarkdown(markdown, entry.name, validateName);
    await writeNew(storage, cache, { name: skill.name });
    return skill;
  }

  return { list, add, install };
}
