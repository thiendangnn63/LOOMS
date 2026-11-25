import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountDirectory, accountLabels, openAccounts } from '../providers/looms-accounts.mjs';
import { createLoomsAdapters } from '../providers/looms-provider-api.mjs';
import { connectExternalMcp } from '../providers/looms-external-mcp.mjs';
import { createRoomMcpConnections } from '../providers/looms-mcp-config.mjs';
import { stalePreview } from './looms-preview.mjs';
import { createSkillMarketplaces } from '../skills/looms-skill-marketplaces.mjs';
import { openSkillLibrary } from '../skills/looms-skills.mjs';
import { createRoomHost } from '../room/room-host.mjs';
import { createDemoAdapters } from '../room/room-demo.mjs';
import { configuredRoomSummarizer } from '../room/room-summary.mjs';
import { openRoomLog } from '../room/room-log.mjs';
import { parseProviderCommand, providerCommandCatalog } from '../providers/room-provider-commands.mjs';
import { defaultProviders, resolveProvider, roomServices } from '../providers/room-services.mjs';

function names(text) {
  const requested = text.trim().split(/[\s,]+/).filter(Boolean).map(value => resolveProvider(value.replace(/^@/, '').toLowerCase()));
  if (!requested.every(provider => Object.hasOwn(roomServices, provider))) throw new Error('Choose a provider from /accounts.');
  return [...new Set(requested)];
}

async function existingRooms(cwd) {
  const logRoot = join(cwd, '.room');
  let entries;
  try {
    if (!(await lstat(logRoot)).isDirectory()) return [];
    entries = await readdir(logRoot, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rooms = [];
  for (const { name: id } of entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,140}$/.test(entry.name))) {
    const path = join(logRoot, id, 'log.jsonl');
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      const seen = new Set(openRoomLog(cwd, id).activeMessages().map(message => message.from));
      rooms.push({ id, title: `Room ${rooms.length + 1}`, visited: stat.mtimeMs, writeEnabled: false, usage: {},
        members: [...seen].filter(name => Object.hasOwn(accountLabels, name)).map(name => ({ name, provider: name })) });
    } catch { /* A missing or incomplete log remains available in the prior workspace. */ }
  }
  return rooms;
}

export async function openLooms({ cwd, demo = false, startBlank = false, directory = accountDirectory(), accounts, fetcher, marketplaceFetcher,
  notify = () => {}, requestApproval }) {
  cwd = realpathSync(cwd);
  accounts ??= demo ? { list: () => Object.keys(accountLabels).map(provider => ({ provider, connected: true })) } : await openAccounts({ directory, fetcher });
  const store = join(directory, demo ? 'demo-rooms' : 'rooms');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const index = join(store, `${createHash('sha256').update(cwd).digest('hex')}.json`);
  let records;
  try { records = JSON.parse(await readFile(index, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; records = demo ? [] : await existingRooms(cwd); }
  let record;
  let host;
  let adapters;
  let externalMcp;
  let skillLibrary;
  let previewEpoch = 0;
  const previewEpochs = new WeakMap();
  const authorization = new AbortController();
  const marketplaces = createSkillMarketplaces({ directory, fetcher: marketplaceFetcher, signal: authorization.signal });
  const catalogs = new Map();
  const factory = () => demo ? createDemoAdapters() : createLoomsAdapters({ accounts, fetcher, catalogs });
  const connected = () => accounts.list().filter(account => account.connected).map(account => account.provider);
  const getSkillLibrary = () => skillLibrary ??= openSkillLibrary(directory).catch(error => { skillLibrary = undefined; throw error; });

  function requireRoom() {
    if (!host) throw new Error('Choose a room with /rooms or start one with /room.');
    return host;
  }

  function requireCurrentPreview(preview) {
    if (previewEpochs.get(preview) !== previewEpoch) throw stalePreview();
  }

  function requireMember(name) {
    const member = requireRoom().roster().find(member => member.name === name);
    if (!member) throw new Error(`@${name} is not in this room.`);
    return member;
  }

  const assignedSkills = (room, name) => Object.hasOwn(room.skills ?? {}, name) ? room.skills[name] : [];

  async function skills(name) {
    requireMember(name);
    const enabled = new Set(assignedSkills(record, name));
    const library = await getSkillLibrary();
    return (await library.list()).map(skill => ({ ...skill, enabled: enabled.has(skill.name) }));
  }

  async function setSkill(target, name, enabled, load) {
    requireMember(target);
    const room = record;
    const current = requireRoom();
    if (enabled) {
      const library = await getSkillLibrary();
      const validate = async skill => {
        if (record !== room || host !== current) throw new Error('The active room changed.');
        const catalog = await current.providerCommands(target);
        if (catalog.some(command => command.name === skill)) throw new Error(`/${skill} is already a command for @${target}.`);
      };
      if (load) ({ name } = await load(library, validate));
      else {
        await library.read(name);
        await validate(name);
      }
    }
    if (record !== room || host !== current) throw new Error('The active room changed.');
    const next = new Set(assignedSkills(room, target));
    if (enabled) next.add(name);
    else next.delete(name);
    (room.skills ??= {})[target] = [...next];
    previewEpoch++;
    await save();
    notify({ type: 'skills' });
    return name;
  }

  function skillCommands(commands, enabled) {
    const skills = new Set(enabled.map(skill => skill.name));
    return [
      { name: 'skills', description: 'Manage this agent’s room skills.', available: true },
      ...enabled.map(({ name, description }) => ({ name, description: description || 'Run this room skill.', argumentHint: '[task]', available: true })),
      ...commands.filter(command => command.name !== 'skills' && !skills.has(command.name)),
    ];
  }

  async function save() {
    if (host) record.members = host.roster();
    const temporary = `${index}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
    try { await rename(temporary, index); }
    catch (error) { await unlink(temporary); throw error; }
  }

  async function open(recordToOpen) {
    previewEpoch++;
    await host?.flushSummary();
    host?.close();
    await externalMcp?.close();
    record = recordToOpen;
    adapters = factory();
    externalMcp = demo ? undefined : createRoomMcpConnections({ directory, approvals: record.mcp ??= {}, connect: connectExternalMcp,
      hasWriteAccess: () => recordToOpen.writeEnabled === true && recordToOpen.askBeforeChanges !== true });
    await externalMcp?.refresh();
    host = createRoomHost({ cwd, roomID: record.id, writeEnabled: record.writeEnabled, askBeforeChanges: record.askBeforeChanges === true,
      initialMembers: record.members, requestApproval, externalMcp,
      async resolveSkill(name, skill) {
        if (assignedSkills(recordToOpen, name).includes(skill)) return (await getSkillLibrary()).read(skill);
      },
      describeMember(name, member) {
        const usage = recordToOpen.usage[member.provider];
        const selected = usage?.selection;
        const matches = selected && selected.model === (member.model ?? null) && selected.effort === (member.effort ?? null);
        return { skills: assignedSkills(recordToOpen, name), ...(matches && { model: usage.model, effort: usage.effort }) };
      },
      liveTasks: !demo, workspaceTools: true, trackActivity: true, protectedPaths: [realpathSync(directory)], adapters, subagentLimit: 2,
      summarize: demo ? undefined : configuredRoomSummarizer(cwd, process.env.LOOMS_SUMMARIZER, factory),
      emit: notify,
      onTurn({ provider, model, effort, actualModel, actualEffort, replied, tokens }) {
        const stats = record.usage[provider] ??= { turns: 0, replies: 0, input: 0, output: 0 };
        stats.turns++;
        if (replied) stats.replies++;
        const selected = stats.selection;
        if (selected?.model !== (model ?? null) || selected?.effort !== (effort ?? null)) {
          delete stats.model;
          delete stats.effort;
        }
        stats.selection = { model: model ?? null, effort: effort ?? null };
        if (actualModel) stats.model = actualModel;
        if (actualEffort) stats.effort = actualEffort;
        if (Number.isFinite(tokens?.input)) stats.input += tokens.input;
        if (Number.isFinite(tokens?.output)) stats.output += tokens.output;
      },
    });
    record.visited = Date.now();
    await save();
    notify({ type: 'room' });
  }

  async function newRoom(requested = []) {
    const available = connected();
    const selection = requested.length ? requested : available.filter(provider => !demo || defaultProviders.includes(provider));
    const missing = selection.find(provider => !available.includes(provider));
    if (missing) throw new Error(`Connect ${accountLabels[missing]} in /accounts first.`);
    const next = { id: randomUUID(), title: `Room ${records.length + 1}`, writeEnabled: false, usage: {},
      members: selection.map(provider => ({ name: provider, provider })) };
    records.push(next);
    await open(next);
  }

  async function include(requested) {
    const current = requireRoom();
    const available = connected();
    const missing = requested.find(provider => !available.includes(provider));
    if (missing) throw new Error(`Connect ${accountLabels[missing]} in /accounts first.`);
    const next = current.roster();
    for (const provider of requested) if (!next.some(member => member.provider === provider)) next.push({ name: provider, provider });
    await current.configure(next, record.writeEnabled);
    await save();
  }

  if (!startBlank) {
    const recent = records.toSorted((a, b) => b.visited - a.visited)[0];
    if (recent) await open(recent);
    else await newRoom();
  }

  const report = text => notify({ type: 'status', text });

  async function installMarketplaceSkill(target, spec) {
    const name = await setSkill(target, spec, true, (library, validate) => marketplaces.install(spec, library, validate));
    report(`/${name} installed for @${target} in this room.`);
  }

  return {
    cwd, demo,
    get hasRoom() { return Boolean(host); },
    get title() { return record?.title; },
    get writeEnabled() { return record?.writeEnabled === true; },
    get askBeforeChanges() { return record?.askBeforeChanges === true; },
    roster: () => host?.roster().map(member => ({ ...member, ...(record.usage[member.provider] ? { actual: record.usage[member.provider] } : {}) })) ?? [],
    transcript: () => host?.transcript() ?? [],
    accounts: accounts.list,
    rooms: () => records.toSorted((a, b) => b.visited - a.visited).map(({ id, title, members }) => ({ id, title, members })),
    catalog: async provider => demo ? [{ id: `demo-${provider}`, label: `Demo ${accountLabels[provider]}`, efforts: [],
      ...roomServices[provider]?.demoModel }] : adapters.catalog(provider),
    localProviderCommands(name) {
      return skillCommands(providerCommandCatalog(requireMember(name).provider), []);
    },
    async providerCommands(name) {
      const current = requireRoom();
      const [commands, available] = await Promise.all([current.providerCommands(name), assignedSkills(record, name).length ? skills(name) : []]);
      return skillCommands(commands, available.filter(skill => skill.enabled));
    },
    skills, setSkill, installMarketplaceSkill, skillMarketplaces: marketplaces.list,
    async preview(text, excluded = [], previous) {
      if (previous !== undefined) requireCurrentPreview(previous);
      const current = requireRoom();
      const epoch = previewEpoch;
      const approval = await current.preview(text, excluded, previous);
      if (current !== host || epoch !== previewEpoch) throw stalePreview();
      previewEpochs.set(approval, epoch);
      return approval;
    },
    async sendPreview(preview) {
      const current = requireRoom();
      await current.sendPreview(preview, () => requireCurrentPreview(preview));
      if (current === host) await save();
    },
    async activate(id) {
      const match = records.find(item => item.id === id);
      if (match) await open(match);
    },
    newRoom, include,
    async permissions(access) {
      if (![true, false, 'ask'].includes(access)) throw new Error('Invalid room access mode.');
      const writeEnabled = access === true;
      const askBeforeChanges = access === 'ask';
      const current = requireRoom();
      await current.configure(current.roster(), writeEnabled, askBeforeChanges);
      record.writeEnabled = writeEnabled;
      record.askBeforeChanges = askBeforeChanges;
      if (!writeEnabled) await externalMcp?.pause();
      await save();
    },
    async setModel(name, model, effort) {
      const current = requireRoom();
      const roster = current.roster().map(member => member.name === name ? { ...member, model, effort } : member);
      const selected = roster.find(member => member.name === name);
      if (selected && record.usage[selected.provider]) {
        delete record.usage[selected.provider].model;
        delete record.usage[selected.provider].effort;
      }
      await current.configure(roster, record.writeEnabled);
      await save();
    },
    async connect(provider, value) {
      if (demo) return;
      if (!Object.hasOwn(roomServices, provider)) throw new Error('Choose a provider from /accounts.');
      const service = roomServices[provider];
      previewEpoch++;
      if (service.auth === 'key') await accounts.connectKey(provider, value, authorization.signal);
      else if (service.auth === 'browser') await accounts[service.connect](value, authorization.signal);
      else await accounts[service.connect](authorization.signal);
      adapters?.invalidate?.(provider);
      previewEpoch++;
      catalogs.delete(provider);
      if (host) {
        if (record.usage[provider]) {
          delete record.usage[provider].model;
          delete record.usage[provider].effort;
        }
        await host.configure(host.roster().map(member => member.provider === provider ? { ...member, model: undefined, effort: undefined } : member), record.writeEnabled);
        if (!host.roster().length) await include([provider]);
        else await save();
      }
      report(service.connected ?? `${service.accountLabel} connected.`);
    },
    async disconnect(provider) {
      if (demo) return;
      previewEpoch++;
      adapters?.invalidate?.(provider);
      await accounts.disconnect(provider);
      previewEpoch++;
      catalogs.delete(provider);
      report(`${accountLabels[provider]} disconnected from LOOMS.`);
    },
    async command(text) {
      const [command] = text.split(/\s+/, 1);
      const args = text.slice(command.length).trim();
      if (command === '/room' || command === '/room-new') return newRoom(names(args));
      const current = requireRoom();
      if (command === '/include') return include(names(args));
      const addressed = parseProviderCommand(text);
      if (command === '/skills' && args) {
        const add = /^marketplace add\s+(\S+)$/.exec(args);
        if (add) {
          const market = await marketplaces.add(add[1]);
          report(`Added ${market.name} · ${market.skills.length} portable ${market.skills.length === 1 ? 'skill' : 'skills'}.`);
          return;
        }
        if (args !== 'marketplace') throw new Error('Use /skills marketplace [add <owner/repo>].');
        const sources = await marketplaces.list();
        notify({ type: 'usage', title: 'Skill marketplaces', text: sources.map(market =>
          `${market.name}  ·  ${market.repo}  ·  ${market.skills.length} skills`).join('\n') || 'Add a source with /skills marketplace add <owner/repo>.' });
        return;
      }
      if (command === '/skills' && !args) {
        const rows = current.roster().map(({ name }) => {
          const enabled = assignedSkills(record, name).map(skill => `/${skill}`);
          return `@${name}  ·  ${enabled.join(', ') || 'No enabled skills'}`;
        });
        notify({ type: 'usage', title: 'Room skills', text: rows.join('\n') || 'Add a provider to assign skills.' });
        return;
      }
      if (addressed?.command === 'skills') {
        const { target, args } = addressed;
        requireMember(target);
        if (args) {
          const match = /^(add|enable|remove|install)\s+([\s\S]+)$/.exec(args);
          if (!match) throw new Error(`Use @${target} /skills [install <skill@marketplace>|add <path>|enable <name>|remove <name>].`);
          const [, action, value] = match;
          if (action === 'install') return installMarketplaceSkill(target, value);
          const path = /^(["'])([\s\S]+)\1$/.exec(value)?.[2] ?? value;
          const load = action === 'add' ? (library, validate) => library.importSkill(resolve(cwd, path), validate) : undefined;
          const name = await setSkill(target, value.replace(/^\//, ''), action !== 'remove', load);
          report(`/${name} ${action === 'remove' ? 'removed from' : 'enabled for'} @${target} in this room.`);
          return;
        }
        const available = await skills(target);
        const rows = available.map(skill => `/${skill.name}  ·  ${skill.enabled ? 'Enabled' : 'Available'}${skill.description ? `  ·  ${skill.description}` : ''}`);
        notify({ type: 'usage', title: `@${target} skills`, text: [...rows,
          `Install with @${target} /skills install <skill@marketplace>`,
          `Import with @${target} /skills add <folder or SKILL.md>`].join('\n') });
        return;
      }
      const mcpTarget = /^@([a-z][\w-]*)\s+\/mcp$/i.exec(text);
      const mcpMember = mcpTarget && current.roster().find(member =>
        member.name === mcpTarget[1].toLowerCase() || member.provider === resolveProvider(mcpTarget[1].toLowerCase()));
      if (externalMcp && (command === '/mcp' || mcpMember)) {
        await externalMcp.refresh();
        const [action, name, ...extra] = args.split(/\s+/);
        if (!mcpMember && args) {
          if (!name || extra.length || !['enable', 'disable', 'test'].includes(action)) throw new Error('Usage: /mcp [enable|disable|test <server>]');
          if (action === 'test') {
            const tools = await externalMcp.listTools(name);
            report(`Connected to ${name} · ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`);
            return;
          }
          await externalMcp.setEnabled(name, action === 'enable');
          previewEpoch++;
          await save();
          report(action === 'enable' ? `${name} enabled for room members in Workspace edits.` : `${name} disabled for this room.`);
          return;
        }
        const builtIn = mcpMember?.provider === 'claude' ? 'Built-in room tools · local MCP' :
          mcpMember ? 'Built-in room tools · provider tools' : 'External MCP servers for this room';
        const status = externalMcp.status();
        notify({ type: 'usage', title: 'MCP', text: [builtIn, externalMcp.configError,
          ...(status.length ? status : ['No external MCP servers configured.']),
          '', `Config file · ${externalMcp.path}`, 'Enable · /mcp enable <server>',
          'Test · /mcp test <server>', 'Disable · /mcp disable <server>'].filter(line => line !== undefined).join('\n') });
        return;
      }
      const usageMatch = /^@([a-z][\w-]*)\s+\/(?:usage|cost|stats)$/i.exec(text);
      const usageTarget = usageMatch && resolveProvider(usageMatch[1].toLowerCase());
      const roster = current.roster();
      if (command === '/usage' || usageTarget && (Object.hasOwn(roomServices, usageTarget) || roster.some(member => member.name === usageTarget))) {
        const scoped = usageTarget ? roster.filter(member => member.name === usageTarget || member.provider === usageTarget) : roster;
        const active = new Set(connected());
        const rows = await Promise.all([...new Set(scoped.map(member => member.provider))].map(async provider => {
          const usage = record.usage[provider] ?? { turns: 0, input: 0, output: 0 };
          const limits = active.has(provider) ? await adapters.accountUsage(provider).catch(() => []) : [];
          const limitText = limits.length ? limits.map(({ label, used }) => `${label} ${used}% used`).join('  ·  ') :
            !active.has(provider) ? 'Connect in /accounts for usage' :
            roomServices[provider]?.usage ? `Plan limits in ${roomServices[provider].usage.label}` : 'Plan limits unavailable';
          return `${accountLabels[provider]}  ·  ${limitText}  ·  ${usage.turns} turns  ·  ${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out`;
        }));
        const usageLink = scoped.filter(member => active.has(member.provider)).map(member => roomServices[member.provider]?.usage).find(Boolean);
        const link = usageLink?.url;
        notify({ type: 'usage', text: rows.join('\n\n') || 'Room usage will appear after a provider replies.', link, linkLabel: usageLink?.label });
        return;
      }
      try { return await current.command(text); }
      finally { await save(); }
    },
    abort() { authorization.abort(); host?.close(); void externalMcp?.close(); },
    async close() { await host?.flushSummary(); host?.close(); authorization.abort(); await externalMcp?.close(); },
  };
}
