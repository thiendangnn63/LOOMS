import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { roomServerName, startRoomMcp } from './room-mcp.mjs';
import { externalMcpActions, mcpTools } from './room-tools.mjs';
import { parseClaudeUsage } from './room-services.mjs';

const reconnect = 'Sign in through Claude Code with a Claude subscription in /accounts.';
const roomFlags = ['-p', '--restricted', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk',
  '--no-session-persistence'];
const streamFlags = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const userMessage = text => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });

async function findBinary(environment) {
  const path = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const folder of path.split(delimiter).filter(isAbsolute)) {
    const candidates = process.platform === 'win32'
      ? [join(folder, 'claude.exe'), join(folder, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
      : [join(folder, 'claude')];
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); return candidate; }
      catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
  }
  throw new Error('Install Anthropic’s Claude Code CLI and add it to PATH to connect Claude.');
}

export function createClaudeCode(directory, { spawnProcess = spawn, environment = process.env, locate = findBinary } = {}) {
  const profile = resolve(directory, 'claude-code');
  const workers = new Set();
  let generation = 0;

  async function launch(args, { interact = false, scope } = {}) {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    if (!(await lstat(profile)).isDirectory()) throw new Error('The LOOMS Claude Code profile needs a regular local directory.');
    const cwd = await realpath(profile);
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
      !/^(?:ANTHROPIC_|CLAUDE(?:_|CODE(?:_|$))|ENABLE_CLAUDEAI_MCP_SERVERS$)/i.test(key)));
    env.CLAUDE_CONFIG_DIR = cwd;
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    const binary = await locate(environment);
    scope?.throwIfAborted();
    return spawnProcess(binary, args, { cwd, env, windowsHide: true,
      stdio: interact ? 'inherit' : ['pipe', 'pipe', 'ignore'], signal: scope });
  }

  async function auth(command, signal) {
    const timeout = AbortSignal.timeout(command === 'login' ? 5 * 60_000 : 15_000);
    const child = await launch(['auth', command], {
      interact: command === 'login', scope: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const closed = once(child, 'close');
    let output = '';
    if (command !== 'login') {
      child.stdin.on('error', () => {});
      child.stdin.end();
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk.slice(0, Math.max(0, 16_384 - output.length)); });
    }
    try {
      const [code] = await closed;
      if (code !== 0) throw new Error(command === 'status' ? reconnect : `Claude Code ${command} did not complete.`);
      if (command === 'status') {
        const status = JSON.parse(output);
        if (status.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') throw new Error(reconnect);
      }
    } catch (error) {
      if (timeout.aborted) throw new Error(`Claude Code ${command} timed out.`);
      if (error instanceof SyntaxError) throw new Error('Claude Code returned an unreadable sign-in status. Update Claude Code and try again.');
      throw error;
    }
  }

  function stopWorkers() {
    generation++;
    for (const child of workers) child.kill();
  }

  return {
    async connect(signal) {
      stopWorkers();
      await auth('login', signal);
      await auth('status', signal);
    },
    async disconnect() {
      stopWorkers();
      await auth('logout');
    },
    async open(args, { server, signal } = {}) {
      const authorized = generation;
      await auth('status', signal);
      let config;
      try {
        if (server) {
          config = join(profile, `room-${randomUUID()}.json`);
          const { url, headers, tools = mcpTools } = server;
          await writeFile(config, JSON.stringify({ mcpServers: { [roomServerName]: { type: 'http', url, headers } } }),
            { flag: 'wx', mode: 0o600 });
          args = [...args, '--mcp-config', config, '--allowedTools', tools.map(tool => `mcp__${roomServerName}__${tool.name}`).join(',')];
        }
        if (generation !== authorized) throw new Error(reconnect);
        const child = await launch([...roomFlags, ...streamFlags, ...args], { scope: signal });
        child.stdin.on('error', () => {});
        workers.add(child);
        child.once('close', () => {
          workers.delete(child);
          if (config) void unlink(config).catch(() => {});
        });
        if (generation !== authorized) {
          // A simultaneous sign-out can finish while launch is resolving the executable.
          child.on('error', () => {});
          child.kill();
          throw new Error(reconnect);
        }
        return child;
      } catch (error) {
        if (config) await unlink(config).catch(() => {});
        throw error;
      }
    },
  };
}

function exchange(child) {
  let pending;
  let failed;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  function close(error = new Error('Claude Code session closed.')) {
    if (failed) return;
    failed = error;
    pending?.reject(error);
    lines.close();
    child.kill();
  }
  child.on('error', () => close(new Error('Claude Code could not start. Check your installation and reconnect Claude in /accounts.')));
  child.once('close', () => close(new Error('Claude Code exited before replying. Update Claude Code and reconnect in /accounts if this persists.')));
  lines.on('line', line => {
    if (!pending) return;
    let event;
    try { event = JSON.parse(line); }
    catch { return; }
    pending.receive(event);
  });
  return {
    get open() { return !failed && !child.killed; },
    close,
    async send(message, receive, signal) {
      signal.throwIfAborted();
      if (failed) throw failed;
      if (pending) throw new Error('Claude Code already has an active turn.');
      const stop = () => close(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          pending = { receive: event => {
            try {
              const result = receive(event);
              if (result !== undefined) resolve(result);
            } catch (error) { close(error); }
          }, reject };
          child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) close(error); });
        });
      } finally {
        pending = undefined;
        signal.removeEventListener('abort', stop);
      }
    },
  };
}

export function createClaudeRoomAdapter(accounts, stopSignal) {
  const sessions = new Map();
  let roomMcp;
  let cliInfo;
  const getClient = () => accounts.claudeCode();

  function reset(member) {
    const session = sessions.get(member);
    if (session) {
      session.channel?.close();
      session.stream.close();
      sessions.delete(member);
    }
  }

  async function discover(client) {
    const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(15_000)]);
    const stream = exchange(await client.open([], { signal }));
    try {
      return await stream.send({ type: 'control_request', request_id: 'looms-init', request: { subtype: 'initialize' } }, event => {
        if (event.type !== 'control_response' || event.response?.request_id !== 'looms-init') return;
        if (event.response.subtype !== 'success') throw new Error('Claude Code could not load its model catalog.');
        return event.response.response ?? {};
      }, signal);
    } finally { stream.close(); }
  }

  function getCLIInfo() {
    return cliInfo ??= discover(getClient()).catch(error => { cliInfo = undefined; throw error; });
  }

  return {
    async accountUsage() {
      const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(20_000)]);
      const stream = exchange(await getClient().open([], { signal }));
      try {
        return await stream.send(userMessage('/usage'), event => {
          if (event.type !== 'result') return;
          return event.local_command === 'usage' && event.num_turns === 0 && !event.is_error && typeof event.result === 'string'
            ? parseClaudeUsage(event.result) : [];
        }, signal);
      } finally { stream.close(); }
    },
    async catalog() {
      const { models = [] } = await getCLIInfo();
      return models.filter(model => typeof model.value === 'string')
        .map(model => ({ id: model.value, label: model.displayName, efforts: model.supportedEffortLevels ?? [] }));
    },
    async discoverCommands() {
      const { commands, slash_commands } = await getCLIInfo();
      return Array.isArray(commands) ? commands : Array.isArray(slash_commands) ? slash_commands : [];
    },
    prepare: member => Boolean(sessions.get(member)?.stream.open),
    reset,
    invalidate() {
      cliInfo = undefined;
      for (const member of sessions.keys()) reset(member);
    },
    close() {
      this.invalidate();
      void roomMcp?.then(mcp => mcp.close(), () => {});
    },
    async ask(member, prompt, context, signal) {
      const client = getClient();
      const scope = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
      const hasExternalTools = externalMcpActions.some(action => context?.allowed?.includes(action));
      let session = sessions.get(member);
      if (!session?.stream.open || (hasExternalTools && !session.hasExternalTools)) {
        reset(member);
        const args = ['--disable-slash-commands'];
        if (member.model) args.push('--model', member.model);
        if (member.effort) args.push('--effort', member.effort);
        let channel;
        if (context?.tool && context.allowed?.length) {
          roomMcp ??= startRoomMcp().catch(error => { roomMcp = undefined; throw error; });
          const mcp = await roomMcp;
          scope.throwIfAborted();
          const names = context.phase === 'subagent' ? context.allowed.map(action => action.replace('.', '_')) :
            hasExternalTools ? mcpTools.map(tool => tool.name) : undefined;
          channel = mcp.register(names);
        }
        try {
          const child = await client.open(args, { server: channel && { url: channel.url, headers: channel.headers, tools: channel.tools }, signal });
          session = { channel, stream: exchange(child), turns: 0, hasExternalTools };
          sessions.set(member, session);
          child.once('close', () => channel?.close());
        } catch (error) {
          channel?.close();
          throw error;
        }
      }
      const { channel, stream } = session;
      let used = false;
      if (channel) channel.call = context?.tool && (async (action, args) => {
        const result = await context.tool(action, args);
        used = true;
        return result;
      });
      member.actualEffort = member.effort;
      try {
        const reply = await stream.send(userMessage(prompt), event => {
          if (event.type === 'system' && event.subtype === 'init') member.actualModel = event.model;
          if (event.type === 'assistant' && !event.parent_tool_use_id && event.message?.model) member.actualModel = event.message.model;
          if (event.type !== 'result') return;
          if (event.usage) {
            const { input_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0, output_tokens } = event.usage;
            member.turnUsage = { input: input_tokens + cache_read_input_tokens + cache_creation_input_tokens, output: output_tokens };
          }
          if (event.is_error || (event.subtype && event.subtype !== 'success')) throw new Error('Claude Code could not complete this turn. Check your subscription limits in Claude Code.');
          if (typeof event.result === 'string' && event.result.trim()) return event.result;
          if (used) return 'PASS';
          throw new Error('Claude Code returned no reply.');
        }, scope);
        session.turns++;
        return reply;
      } catch (error) {
        reset(member);
        throw error;
      } finally {
        if (channel) channel.call = undefined;
      }
    },
    turns: member => sessions.get(member)?.turns ?? 0,
  };
}
