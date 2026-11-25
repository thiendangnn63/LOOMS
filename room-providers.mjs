import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { roomServerName, startRoomMcp } from './room-mcp.mjs';
import { mcpTools } from './room-tools.mjs';

import { defaultProviders, parseClaudeUsage } from './room-services.mjs';
export { defaultProviders, providers, providerLabels } from './room-services.mjs';
const geminiPolicy = fileURLToPath(new URL('./gemini-room-policy.toml', import.meta.url));
const optionValues = option => option?.options?.flatMap(item => item.options ?? [item]) ?? [];
const supportsTools = provider => defaultProviders.includes(provider);

export function createProviderAdapters({ cwd, writeEnabled, display = () => {}, spawnProcess = spawn, scopedWorker = false }) {
  const children = new Set();
  let stopping = false;
  let roomMcp;

  function launch(agent, args, interactive = false, extraEnv = {}) {
    let command = agent;
    let options = { cwd, windowsHide: true, env: { ...process.env, ...extraEnv } };
    if (process.platform === 'win32') {
      const npmFolder = process.env.APPDATA && join(process.env.APPDATA, 'npm');
      const env = options.env;
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
      let launcher = agent;
      if (npmFolder && existsSync(join(npmFolder, `${agent}.cmd`))) {
        env[pathKey] = `${npmFolder};${env[pathKey] ?? ''}`;
        launcher += '.cmd';
      }
      env.NoDefaultCurrentDirectoryInExePath = '1';
      // Room prompts use stdin. The room MCP config path is a quoted environment expansion.
      command = process.env.ComSpec ?? 'cmd.exe';
      args = ['/d', '/s', '/c', launcher, ...args];
      options = { ...options, windowsVerbatimArguments: true };
    }
    if (interactive) return spawnProcess(command, args, { ...options, stdio: 'inherit' });
    const child = spawnProcess(command, args, options);
    children.add(child);
    child.once('close', () => children.delete(child));
    child.stdin.on('error', () => {}); // Process exit reports broken pipes.
    child.stderr.setEncoding('utf8').on('data', chunk => display(`${agent} status`, chunk));
    return child;
  }

  function readEvents(child, receive) {
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        display('launcher', `${line}\n`);
        return;
      }
      receive(message);
    });
  }

  function withDeadline(promise, child, milliseconds = 15_000) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error('Provider CLI did not respond in time.'));
        }, milliseconds);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function execute(provider, args, input) {
    const child = launch(provider, args);
    child.stdin.end(input, 'utf8');
    return withDeadline(new Promise((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    }), child);
  }

  class CodexSession {
    child = launch('codex', ['app-server']);
    pending = new Map();
    nextId = 0;
    current = null;
    failure = null;

    constructor(name, member, channel) {
      this.name = name;
      this.member = member;
      this.channel = channel;
      readEvents(this.child, message => this.receive(message));
      this.child.on('error', error => this.fail(error));
      this.child.on('close', code => this.fail(new Error(`Codex App Server exited (${code}).`)));
    }

    fail(error) {
      this.failure = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.current?.reject(error);
    }

    send(message) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    request(method, params) {
      if (this.failure) return Promise.reject(this.failure);
      return new Promise((resolve, reject) => {
        const id = ++this.nextId;
        this.pending.set(id, { resolve, reject });
        this.send({ id, method, params });
      });
    }

    receive({ id, method, params, result, error }) {
      if (method && id !== undefined) {
        this.send({ id, error: { code: -32601, message: 'Interactive tool requests are unavailable.' } });
        return;
      }
      const request = this.pending.get(id);
      if (request) {
        this.pending.delete(id);
        if (error) request.reject(new Error(error.message));
        else request.resolve(result);
        return;
      }
      const turn = this.current;
      if (!turn || params?.threadId !== this.threadId) return;
      if (method === 'thread/tokenUsage/updated') {
        const totals = params.tokenUsage?.total;
        if (totals) this.total = totals;
      }
      if (method === 'item/agentMessage/delta' && turn.showReply) {
        turn.streamed.add(params.itemId);
        display(this.name, params.delta);
      }
      if (method === 'item/completed' && (params.item.type === 'agentMessage' || params.item.type === 'exitedReviewMode')) {
        turn.text = params.item.type === 'exitedReviewMode' ? params.item.review : params.item.text;
        if (turn.showReply) {
          if (!turn.streamed.has(params.item.id)) display(this.name, turn.text);
          display(this.name, '\n');
        }
      }
      if (method === 'turn/completed') {
        const reply = turn.text.trim() ? turn.text : turn.fallback ?? (this.channel?.used ? 'PASS' : '');
        if (params.turn.status === 'completed' && reply) turn.resolve(reply);
        else turn.reject(new Error(params.turn.error?.message ?? `Codex finished with status ${params.turn.status} and no usable reply.`));
      }
    }

    async initialize() {
      await this.request('initialize', {
        clientInfo: { name: 'ccgpt', title: 'CCGPT', version: '0.1.3' },
      });
      this.send({ method: 'initialized' });
    }

    async start() {
      await this.initialize();
      const config = {};
      if (scopedWorker) {
        const effective = await this.request('config/read', { cwd });
        for (const id of Object.keys(effective.config?.mcp_servers ?? {})) {
          if (id !== roomServerName || !this.channel) config[`mcp_servers.${id}.enabled`] = false;
        }
        for (const feature of ['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'skill_mcp_dependency_install']) {
          config[`features.${feature}`] = false;
        }
      }
      if (this.channel) config[`mcp_servers.${roomServerName}`] = {
        url: this.channel.url, http_headers: this.channel.headers, required: true, enabled: true,
      };
      const { thread, model, reasoningEffort } = await this.request('thread/start', {
        cwd, sandbox: writeEnabled ? 'workspace-write' : 'read-only', approvalPolicy: 'never', model: this.member.model,
        config: Object.keys(config).length ? config : undefined,
      });
      this.threadId = thread.id;
      this.member.actualModel = model;
      this.member.actualEffort = this.member.effort ?? reasoningEffort;
    }

    async run(text, showReply, command) {
      const previous = this.total;
      try {
        if (!this.threadId) await this.start();
        const threadId = this.threadId;
        if (command?.name === 'mcp') {
          const names = [];
          let cursor;
          do {
            const page = await withDeadline(this.request('mcpServerStatus/list', { threadId, cursor }), this.child);
            for (const server of page.data) names.push(`${server.name} · ${Object.keys(server.tools ?? {}).length} tools`);
            cursor = page.nextCursor;
          } while (cursor);
          return names.join('\n') || 'No MCP servers are connected.';
        }
        const turns = new Promise((resolve, reject) => {
          this.current = { resolve, reject, showReply, streamed: new Set(), text: '',
            fallback: command?.name === 'compact' ? 'Codex context compacted.' : undefined };
          let method = 'turn/start';
          let params = { threadId, effort: this.member.effort, input: [{ type: 'text', text }] };
          if (command?.name === 'compact') {
            method = 'thread/compact/start';
            params = { threadId };
          } else if (command?.name === 'review') {
            method = 'review/start';
            params = { threadId, delivery: 'inline', target: command.args ? { type: 'custom', instructions: command.args } : { type: 'uncommittedChanges' } };
          }
          this.request(method, params).catch(reject);
        });
        return await (command ? withDeadline(turns, this.child, 5 * 60_000) : turns);
      } finally {
        if (this.total && this.total !== previous) {
          this.member.turnUsage = {
            input: Math.max(0, this.total.inputTokens - (previous?.inputTokens ?? 0)),
            output: Math.max(0, this.total.outputTokens - (previous?.outputTokens ?? 0)),
          };
        }
        this.current = null;
      }
    }
  }

  class ClaudeSession {
    current = null;
    failure = null;

    constructor(name, member, channel) {
      this.name = name;
      this.member = member;
      this.channel = channel;
      const tools = writeEnabled ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob';
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--tools', tools, '--strict-mcp-config',
        '--permission-mode', writeEnabled ? 'acceptEdits' : 'plan'];
      if (scopedWorker) args.push('--restricted', '--disable-slash-commands');
      if (member.model) args.push('--model', member.model);
      if (member.effort) args.push('--effort', member.effort);
      if (channel) {
        this.configDirectory = mkdtempSync(join(tmpdir(), 'ccgpt-mcp-'));
        const config = join(this.configDirectory, 'room.json');
        const removeConfig = () => {
          try { unlinkSync(config); }
          finally { rmdirSync(this.configDirectory); }
        };
        try {
          writeFileSync(config, JSON.stringify({ mcpServers: { [roomServerName]: {
            type: 'http', url: channel.url, headers: channel.headers,
          } } }), { flag: 'wx', mode: 0o600 });
          const allowed = mcpTools.map(tool => `mcp__${roomServerName}__${tool.name}`).join(',');
          args.push('--mcp-config', process.platform === 'win32' ? '"%CCGPT_ROOM_MCP_CONFIG%"' : config, '--allowedTools', allowed);
          if (member.sessionId) args.push('--resume', member.sessionId);
          this.child = launch('claude', args, false, { CCGPT_ROOM_MCP_CONFIG: config });
        } catch (error) {
          try { removeConfig(); } catch {}
          throw error;
        }
        this.child.once('close', () => {
          try { removeConfig(); } catch (error) { display('claude status', `${error.message}\n`); }
        });
      } else {
        if (member.sessionId) args.push('--resume', member.sessionId);
        this.child = launch('claude', args);
      }
      readEvents(this.child, message => this.receive(message));
      this.child.once('error', error => this.fail(error));
      this.child.once('close', code => this.fail(new Error(`Claude Code exited (${code}).`)));

      if (!scopedWorker && member.actualEffort === undefined) {
        // The status probe is independent of the conversation and can finish after the first reply.
        void claudeEffort(member).catch(() => member.effort).then(effort => {
          if (member.session === this) member.actualEffort = effort;
        });
      }
    }

    fail(error) {
      if (this.failure) return;
      this.failure = error;
      const turn = this.current;
      if (!turn) return;
      this.current = null;
      delete this.member.sessionId;
      turn.reject(error);
    }

    send(message) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error) this.fail(error);
      });
    }

    run(prompt, showReply, command) {
      if (this.failure) return Promise.reject(this.failure);
      if (this.current) return Promise.reject(new Error('Claude Code already has an active turn.'));
      return new Promise((resolve, reject) => {
        this.current = { resolve, reject, showReply, streamed: false, command };
        this.send({
          type: 'user',
          session_id: this.member.sessionId,
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          parent_tool_use_id: null,
        });
      });
    }

    receive(message) {
      if (message.type === 'control_request') {
        this.send({ type: 'control_response', response: {
          subtype: 'error', request_id: message.request_id, error: 'Interactive tool requests are unavailable.',
        } });
        return;
      }
      const turn = this.current;
      if (!turn) return;
      if (message.type === 'system' && message.subtype === 'init') this.member.actualModel = message.model;
      if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.model) {
        this.member.actualModel = message.message.model;
      }
      if (turn.showReply && message.type === 'stream_event' && !message.parent_tool_use_id &&
          message.event?.delta?.type === 'text_delta') {
        turn.streamed = true;
        display(this.name, message.event.delta.text);
      }
      if (message.type !== 'result') return;

      if (message.usage) {
        const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = message.usage;
        this.member.turnUsage = {
          input: (input_tokens ?? 0) + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0),
          output: output_tokens ?? 0,
          ...(Number.isFinite(message.total_cost_usd) ? { costUsd: message.total_cost_usd } : {}),
        };
      }
      if (turn.command && message.is_error) {
        this.current = null;
        turn.reject(new Error(message.errors?.join(' ') || message.result || `Claude /${turn.command.name} failed.`));
        return;
      }
      if (message.is_error || (!message.result?.trim() && !this.channel?.used && !turn.command)) {
        this.fail(new Error(message.errors?.join(' ') || message.result || 'Claude Code returned no reply.'));
        this.child.stdin.end();
        return;
      }
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.session_id)) {
        this.member.sessionId = message.session_id;
      }
      this.current = null;
      if (turn.showReply) {
        if (!turn.streamed) display(this.name, message.result);
        display(this.name, '\n');
      }
      turn.resolve(message.result?.trim() ? message.result : turn.command ? `Claude /${turn.command.name} completed.` : 'PASS');
    }
  }

  class GeminiSession {
    child = launch('gemini', ['--acp', '--approval-mode', 'default', '--admin-policy',
      process.platform === 'win32' ? '"%CCGPT_GEMINI_POLICY_FILE%"' : geminiPolicy], false,
    { CCGPT_GEMINI_POLICY_FILE: geminiPolicy });
    pending = new Map();
    id = 0;
    text = '';

    constructor(member) {
      this.member = member;
      readEvents(this.child, message => void this.receive(message));
      this.child.on('error', error => this.fail(error));
      this.child.on('close', code => this.fail(new Error(`Gemini CLI exited (${code}).`)));
    }

    fail(error) {
      this.failure = error;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    }

    send(message) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }

    request(method, params) {
      if (this.failure) return Promise.reject(this.failure);
      return new Promise((resolve, reject) => {
        const id = ++this.id;
        this.pending.set(id, { resolve, reject });
        this.send({ id, method, params });
      });
    }

    async receive({ id, method, params, result, error }) {
      if (method && id !== undefined) {
        try {
          if (method === 'session/request_permission') {
            const write = params.toolCall?.kind === 'edit';
            const option = writeEnabled && write && params.options.find(item => item.kind === 'allow_once');
            result = { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
          } else if (method === 'fs/read_text_file') {
            const path = await workspacePath(params.path);
            const text = await readFile(path, 'utf8');
            const lines = text.split('\n');
            const start = (params.line ?? 1) - 1;
            result = { content: lines.slice(start, params.limit === undefined ? undefined : start + params.limit).join('\n') };
          } else if (method === 'fs/write_text_file' && writeEnabled) {
            await writeFile(await workspacePath(params.path, true), params.content, 'utf8');
            result = {};
          } else {
            throw new Error('Tool is unavailable at the current room permission level.');
          }
          this.send({ id, result });
        } catch (failure) {
          this.send({ id, error: { code: -32000, message: failure.message } });
        }
        return;
      }
      if (method === 'session/update' && params.sessionId === this.sessionID) {
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') this.text += update.content.text;
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (error) entry.reject(new Error(error.message));
      else entry.resolve(result);
    }

    async start() {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'ccgpt', version: '0.1.3' },
      });
      const session = await this.request('session/new', { cwd, mcpServers: [] });
      this.sessionID = session.sessionId;
      let config = session.configOptions;
      const modelOption = config?.find(option => option.category === 'model' || option.id === 'model');
      this.member.actualModel = modelOption?.currentValue ?? session.models?.currentModelId;
      if (this.member.model) {
        if (modelOption) {
          const updated = await this.request('session/set_config_option', {
            sessionId: this.sessionID, configId: modelOption.id, value: this.member.model,
          });
          config = updated.configOptions ?? config;
        } else await this.request('session/set_model', { sessionId: this.sessionID, modelId: this.member.model });
        this.member.actualModel = this.member.model;
      }
      const effort = config?.find(option => option.category === 'thought_level');
      this.member.actualEffort = effort?.currentValue;
      if (this.member.effort) {
        if (!optionValues(effort).some(option => option.value === this.member.effort)) {
          throw new Error('Gemini CLI did not report that reasoning effort.');
        }
        const updated = await this.request('session/set_config_option', {
          sessionId: this.sessionID, configId: effort.id, value: this.member.effort,
        });
        this.member.actualEffort = updated.configOptions?.find(option => option.id === effort.id)?.currentValue ?? this.member.effort;
      }
      return session;
    }

    async run(text) {
      if (!this.sessionID) await withDeadline(this.start(), this.child);
      this.text = '';
      const result = await this.request('session/prompt', { sessionId: this.sessionID, prompt: [{ type: 'text', text }] });
      if (result.usage) this.member.turnUsage = { input: result.usage.inputTokens, output: result.usage.outputTokens };
      if (!this.text.trim()) throw new Error(`Gemini CLI stopped (${result.stopReason}) without a reply.`);
      return this.text;
    }
  }

  async function workspacePath(path, allowMissing = false) {
    const root = await realpath(cwd);
    const requested = resolve(root, path);
    let current = requested;
    const suffix = [];
    while (true) {
      try {
        current = await realpath(current);
        break;
      } catch (error) {
        if (!allowMissing || error.code !== 'ENOENT') throw error;
        const parent = resolve(current, '..');
        if (parent === current) throw error;
        suffix.unshift(relative(parent, current));
        current = parent;
      }
    }
    const target = resolve(current, ...suffix);
    const inside = relative(root, target);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error('Path is outside the room workspace.');
    }
    return target;
  }

  let claudeInfo;
  function getClaudeInfo() {
    return claudeInfo ??= readClaudeInfo().catch(error => {
      claudeInfo = undefined;
      throw error;
    });
  }
  async function readClaudeInfo() {
    const child = launch('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--strict-mcp-config']);
    try {
      return await withDeadline(new Promise((resolve, reject) => {
        const requestID = 'ccgpt-init';
        readEvents(child, event => {
          if (event.type !== 'control_response' || event.response?.request_id !== requestID) return;
          if (event.response.subtype === 'success') {
            const { models, commands } = event.response.response;
            resolve({ models, commands });
          }
          else reject(new Error(event.response.error ?? 'Claude CLI could not load models.'));
        });
        child.once('error', reject);
        child.once('close', code => reject(new Error(`Claude CLI exited (${code}).`)));
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestID, request: { subtype: 'initialize' } })}\n`);
      }), child);
    } finally {
      child.stdin.end();
    }
  }

  async function claudeCommand(name, input, options = []) {
    const result = await execute('claude', ['-p', '--output-format', 'json', '--no-session-persistence', ...options], input);
    const data = JSON.parse(result.output);
    return data.local_command === name && !data.is_error && data.num_turns === 0 ? data.result : undefined;
  }

  async function claudeEffort(member = {}) {
    const info = await getClaudeInfo();
    if (!info.commands?.some(item => item.name?.replace(/^\//, '') === 'effort')) return;
    const options = [];
    if (member.model) options.push('--model', member.model);
    if (member.effort) options.push('--effort', member.effort);
    const result = await claudeCommand('effort', '/effort status', options);
    return result?.match(/\(currently ([a-z]+)\)/i)?.[1] ?? result?.match(/^(?:Current )?effort level: ([a-z]+)\b/im)?.[1];
  }

  async function withCodex(operation) {
    const session = new CodexSession('codex', {});
    try {
      await withDeadline(session.initialize(), session.child);
      return await withDeadline(operation(session), session.child);
    } finally {
      session.child.stdin.end();
    }
  }

  async function catalog(provider) {
    if (provider === 'codex') {
      return withCodex(async session => {
        const models = [];
        let cursor;
        do {
          const page = await session.request('model/list', { cursor, limit: 100 });
          models.push(...page.data.filter(item => !item.hidden).map(item => ({
            id: item.model, label: item.displayName ?? item.model, default: item.isDefault,
            defaultEffort: item.defaultReasoningEffort,
            efforts: item.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [],
          })));
          cursor = page.nextCursor;
        } while (cursor);
        const config = (await session.request('config/read', { cwd }).catch(() => null))?.config;
        if (config?.model) for (const model of models) model.default = model.id === config.model;
        const selected = models.find(model => model.default);
        if (selected && config?.model_reasoning_effort) selected.defaultEffort = config.model_reasoning_effort;
        return models;
      });
    }
    if (provider === 'claude') {
      const [info, effort] = await Promise.all([getClaudeInfo(), claudeEffort().catch(() => undefined)]);
      return (info.models ?? []).map(item => ({
        id: item.value, label: item.displayName, actual: item.resolvedModel, default: item.value === 'default',
        defaultEffort: item.value === 'default' ? effort : undefined,
        efforts: item.supportedEffortLevels ?? [],
      }));
    }
    const session = new GeminiSession({});
    try {
      const result = await withDeadline(session.start(), session.child);
      const config = result.configOptions?.find(item => item.category === 'model' || item.id === 'model');
      const effort = result.configOptions?.find(item => item.category === 'thought_level');
      const models = config ? optionValues(config) : result.models?.availableModels ?? [];
      return models.map(item => {
        const id = item.modelId ?? item.value;
        const isDefault = id === (config?.currentValue ?? result.models?.currentModelId);
        return {
          id, label: item.name, default: isDefault,
          defaultEffort: isDefault ? effort?.currentValue : undefined,
          efforts: isDefault ? optionValues(effort).map(option => option.value) : [],
        };
      });
    } finally {
      session.child.stdin.end();
    }
  }

  async function signedIn(provider) {
    if (provider === 'codex') return (await execute(provider, ['login', 'status'])).code === 0;
    if (provider === 'claude') {
      const result = await execute(provider, ['auth', 'status']);
      return result.code === 0 && JSON.parse(result.output).loggedIn === true;
    }
    return (await catalog(provider)).length > 0;
  }

  async function accountUsage(provider) {
    if (provider === 'codex') {
      const result = await withCodex(session => session.request('account/rateLimits/read'));
      const buckets = result.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result.rateLimits];
      return buckets.filter(Boolean).flatMap(bucket => [bucket.primary, bucket.secondary].filter(Boolean)
        .filter(window => Number.isFinite(window.usedPercent)).map(window => ({
          label: [bucket.limitName ?? bucket.limitId, window.windowDurationMins ? `${window.windowDurationMins} min` : ''].filter(Boolean).join(' · '),
          used: window.usedPercent, reset: Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null,
        })));
    }
    if (provider === 'claude') {
      const info = await getClaudeInfo();
      if (!info.commands?.some(item => item.name?.replace(/^\//, '') === 'usage')) return [];
      const result = await claudeCommand('usage', '/usage');
      return parseClaudeUsage(result);
    }
    return [];
  }

  function prepare(member) {
    return (!!member.session && !member.session.failure) || (member.provider === 'claude' && !!member.sessionId);
  }

  async function discoverCommands(provider) {
    if (provider !== 'claude') return [];
    const { commands } = await getClaudeInfo();
    return Array.isArray(commands) ? commands : [];
  }

  async function ask(name, member, prompt, showReply = false, context) {
    if (stopping) throw new Error('Session is closing.');
    const signal = context?.signal;
    signal?.throwIfAborted();
    const command = context?.providerCommand;
    if (command?.name === 'compact' && !prepare(member)) throw new Error(`Send a message to @${name} before compacting its context.`);
    if (command && member.provider === 'claude') {
      const commands = await discoverCommands('claude');
      if (!commands.some(item => item.name?.replace(/^\//, '') === command.name)) {
        throw new Error(`This Claude Code CLI does not advertise /${command.name} in its room transport.`);
      }
    }
    if (showReply) display(name, 'Working…\n');
    if (!member.session || member.session.failure) {
      member.session?.child.stdin.end();
      let channel;
      if (context?.tool && supportsTools(member.provider)) {
        roomMcp ??= startRoomMcp().catch(error => { roomMcp = undefined; throw error; });
        const mcp = await roomMcp;
        signal?.throwIfAborted();
        if (stopping) throw new Error('Session is closing.');
        channel = mcp.register();
      }
      try {
        if (member.provider === 'claude') member.session = new ClaudeSession(name, member, channel);
        else if (member.provider === 'gemini') member.session = new GeminiSession(member);
        else member.session = new CodexSession(name, member, channel);
        if (channel) member.session.child.once('close', channel.close);
      } catch (error) {
        channel?.close();
        throw error;
      }
    }
    const { session } = member;
    const { channel } = session;
    if (channel) {
      channel.used = false;
      channel.call = context?.tool && ((...args) => {
        const result = context.tool(...args);
        channel.used = true;
        return result;
      });
    }
    function cancel() {
      channel?.close();
      session.child.stdin.end();
      session.child.kill();
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const reply = session.run(prompt, showReply, command);
      return await (command && member.provider === 'claude' ? withDeadline(reply, session.child, 5 * 60_000) : reply);
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (channel) channel.call = undefined;
    }
  }

  function reset(member) {
    member.session?.child.stdin.end();
    delete member.session;
    delete member.sessionId;
  }

  function stopChildren() {
    stopping = true;
    roomMcp?.then(mcp => mcp.close(), () => {});
    for (const child of children) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1500);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  }

  return { prepare, ask, reset, launch, catalog, signedIn, accountUsage, supportsTools, discoverCommands,
    forPlanning: () => createProviderAdapters({ cwd, writeEnabled: false, display, spawnProcess, scopedWorker: true }),
    forTask: directory => createProviderAdapters({ cwd: directory, writeEnabled: false, display, spawnProcess, scopedWorker: true }),
    setWriteEnabled: value => { writeEnabled = value; }, close: stopChildren };
}
