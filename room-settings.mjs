import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderAdapters, defaultProviders, providerLabels } from './room-providers.mjs';
import { providerCommandCatalog } from './room-provider-commands.mjs';

const validModel = /^[a-z0-9][a-z0-9._:/-]*$/i;
const validEffort = /^[a-z][a-z0-9-]*$/;
const defaultMembers = () => defaultProviders.map(provider => ({ name: provider, provider }));
const demoModels = {
  codex: [{ id: 'demo-codex', label: 'Demo Codex', default: true, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] }],
  claude: [{ id: 'demo-claude', label: 'Demo Claude', default: true, defaultEffort: 'high', efforts: ['low', 'medium', 'high'] }],
  gemini: [{ id: 'demo-gemini', label: 'Demo Gemini', default: true, efforts: [] }],
};

export function createRoomSettings({ cwd, demo, writeEnabled, stateDirectory }) {
  const directory = stateDirectory ?? join(process.env.XDG_STATE_HOME ??
    (process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined) ??
    join(homedir(), '.local', 'state'), 'ccgpt', demo ? 'demo-rooms' : 'rooms');
  const records = new Map();
  const probes = new Map();
  const catalogs = new Map();
  const accounts = new Map();
  const commandLists = new Map();
  const signIns = new Map();

  function probe(directory) {
    if (!probes.has(directory)) probes.set(directory, createProviderAdapters({ cwd: directory, writeEnabled: false }));
    return probes.get(directory);
  }

  function cached(map, key, load, duration = 60_000) {
    const current = map.get(key);
    if (current?.expires > Date.now()) return current.value;
    const value = load();
    map.set(key, { value, expires: Date.now() + duration });
    return value;
  }

  function catalog(provider, directory) {
    if (demo) return Promise.resolve(demoModels[provider]);
    return cached(catalogs, JSON.stringify([directory, provider]), async () => {
      try { return await probe(directory).catalog(provider); }
      catch { return []; }
    });
  }

  async function available(directory) {
    const services = Object.keys(providerLabels);
    if (demo) return services;
    return cached(signIns, directory, async () => {
      const result = await Promise.all(services.map(async provider => {
        try { return await probe(directory).signedIn(provider); }
        catch { return false; }
      }));
      return services.filter((_, index) => result[index]);
    }, 10_000);
  }

  function account(provider, directory) {
    if (demo) return Promise.resolve([{ label: 'Example allowance', used: provider === 'claude' ? 35 : 20,
      reset: 'Demo data' }]);
    return cached(accounts, provider, async () => {
      try { return await probe(directory).accountUsage(provider); }
      catch { return []; }
    });
  }

  async function commands(record, target) {
    const name = target === 'chatgpt' ? 'codex' : target;
    const member = record.members.find(item => item.name === name);
    if (!member) throw new Error(`@${name} is not in this room.`);
    const { provider } = member;
    const discovered = !demo && provider === 'claude' ? await cached(commandLists, record.cwd, async () => {
      try { return await probe(record.cwd).discoverCommands(provider); }
      catch { return []; }
    }) : [];
    return { label: providerLabels[provider], commands: providerCommandCatalog(provider, discovered) };
  }

  function get(sessionID) {
    if (!/^[a-zA-Z0-9_-]{1,140}$/.test(sessionID ?? '')) throw new Error('Invalid OpenCode session ID.');
    if (!records.has(sessionID)) {
      const filename = join(directory, `${sessionID}.json`);
      const pending = readFile(filename, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return { cwd, writeEnabled, members: defaultMembers(), usage: {} };
      }).then(data => ({ ...data, filename }));
      records.set(sessionID, pending);
      pending.catch(() => records.delete(sessionID));
    }
    return records.get(sessionID);
  }

  async function save({ filename, ...data }) {
    await mkdir(directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, filename);
  }

  function recordTurn(record, { provider, actualModel, actualEffort, tokens, replied }) {
    const usage = record.usage[provider] ??= { turns: 0, replies: 0 };
    usage.turns++;
    if (replied) usage.replies++;
    if (typeof actualModel === 'string') usage.model = actualModel;
    if (typeof actualEffort === 'string') usage.effort = actualEffort;
    if (Number.isFinite(tokens?.input)) usage.input = (usage.input ?? 0) + tokens.input;
    if (Number.isFinite(tokens?.output)) usage.output = (usage.output ?? 0) + tokens.output;
  }

  async function view(record, { withCatalog = false, withUsage = false } = {}) {
    const members = await Promise.all(record.members.map(async member => {
      const models = withCatalog ? await catalog(member.provider, record.cwd) : [];
      const configured = models.find(model => model.id === member.model) ?? models.find(model => model.default);
      const activity = record.usage[member.provider] ?? { turns: 0, replies: 0 };
      return {
        ...member, label: providerLabels[member.provider] ?? member.name,
        modelLabel: activity.model ?? configured?.actual ?? configured?.label ?? member.model ?? 'CLI default',
        effortLabel: activity.effort ?? member.effort ?? configured?.defaultEffort ?? 'CLI default',
        ...(withCatalog ? { models } : {}),
        ...(withUsage ? { activity, account: await account(member.provider, record.cwd) } : {}),
      };
    }));
    return { writeEnabled: record.writeEnabled, members };
  }

  async function update(record, patch) {
    let next = record.members;
    if (patch.roster !== undefined || patch.include !== undefined) {
      const requested = patch.roster ?? [patch.include];
      if (!Array.isArray(requested) || !requested.length || requested.some(provider => !Object.hasOwn(providerLabels, provider))) {
        throw new Error('Use @codex, @claude, or @gemini to select services.');
      }
      const signedIn = await available(record.cwd);
      const additions = [...new Set(requested)].filter(provider => patch.roster || !next.some(member => member.provider === provider));
      const missing = additions.find(provider => !signedIn.includes(provider));
      if (missing) throw new Error(`Sign in to ${providerLabels[missing]} in its CLI first.`);
      const selected = additions.map(provider => ({ provider, name: provider }));
      next = patch.roster ? selected : [...next, ...selected];
    }
    if (patch.modelSettings !== undefined) {
      const { provider, model, effort } = patch.modelSettings;
      if ((model !== null && (typeof model !== 'string' || !validModel.test(model))) ||
          (effort !== null && (typeof effort !== 'string' || !validEffort.test(effort)))) throw new Error('Invalid model or effort.');
      if (!next.some(member => member.provider === provider)) throw new Error('That service is not in this room.');
      const models = await catalog(provider, record.cwd);
      const selected = models.find(option => model ? option.id === model : option.default);
      if (model && !selected) throw new Error('The provider did not report that model.');
      if (effort && !selected?.efforts.includes(effort)) throw new Error('The provider does not offer that effort for this model.');
      next = next.map(member => member.provider === provider ? { ...member, model: model ?? undefined, effort: effort ?? undefined } : member);
    }
    if (patch.writeEnabled !== undefined && typeof patch.writeEnabled !== 'boolean') throw new Error('Invalid permission mode.');

    const usage = structuredClone(record.usage);
    for (const member of next) {
      const old = record.members.find(item => item.name === member.name);
      if (!usage[member.provider] || (old?.model === member.model && old?.effort === member.effort)) continue;
      delete usage[member.provider].model;
      delete usage[member.provider].effort;
    }
    const change = { ...record, usage, members: next, writeEnabled: patch.writeEnabled ?? record.writeEnabled };
    await save(change);
    Object.assign(record, change);
  }

  return { get, save, view, update, available, commands, recordTurn, close: () => { for (const item of probes.values()) item.close(); } };
}
