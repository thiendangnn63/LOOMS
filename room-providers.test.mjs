import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createProviderAdapters } from './room-providers.mjs';
import { createRoomHost } from './room-host.mjs';
import { openRoomLog } from './room-log.mjs';

test('Claude reuses its process and resumes a completed session after an idle exit', async t => {
  const sessionId = '5a82f584-411c-4fd7-826c-c82cc64be420';
  const processes = [];
  const adapters = createProviderAdapters({
    cwd: process.cwd(),
    writeEnabled: false,
    spawnProcess(_command, args) {
      const child = Object.assign(new EventEmitter(), {
        args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), inputs: [],
      });
      child.kill = () => child.stdin.end();
      child.stdin.once('end', () => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      createInterface({ input: child.stdin }).on('line', line => {
        const input = JSON.parse(line);
        child.inputs.push(input);
        if (input.message.content[0].text === 'fail this turn') {
          child.stdin.end();
          return;
        }
        child.stdout.write(JSON.stringify({
          type: 'result', is_error: false, session_id: sessionId, result: `reply ${child.inputs.length}`,
          usage: { input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 2 },
        }) + '\n');
      });
      processes.push(child);
      return child;
    },
  });
  t.after(() => adapters.close());
  const member = { provider: 'claude', actualEffort: 'medium' };

  assert.equal(await adapters.ask('claude', member, 'first turn'), 'reply 1');
  assert.equal(await adapters.ask('claude', member, 'second turn'), 'reply 2');
  assert.equal(processes.length, 1);
  assert.equal(processes[0].inputs[1].session_id, sessionId);
  assert.equal(processes[0].stdin.writableEnded, false);
  assert.deepEqual(member.turnUsage, { input: 7, output: 2 });

  const closed = once(processes[0], 'close');
  processes[0].stdin.end();
  await closed;
  assert.equal(adapters.prepare(member), true);
  assert.equal(await adapters.ask('claude', member, 'resume after exit'), 'reply 1');
  assert.deepEqual(processes[1].args.slice(-2), ['--resume', sessionId]);

  await assert.rejects(adapters.ask('claude', member, 'fail this turn'), /Claude Code exited/);
  assert.equal(adapters.prepare(member), false);
  assert.equal(await adapters.ask('claude', member, 'rebuild room context'), 'reply 1');
  assert.equal(processes[2].args.includes('--resume'), false);
});

test('Codex and Claude adapter sessions register room MCP tools and share a typed exchange', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccgpt-provider-tools-'));
  const launched = [];
  const channels = new Map();
  const listed = [];
  const failures = [];
  const errors = [];

  async function rpc(config, method, params) {
    const response = await fetch(config.url, {
      method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    const { result, error } = await response.json();
    assert.equal(error, undefined);
    return result;
  }

  async function discover(provider, config) {
    channels.set(provider, config);
    const initialized = await rpc(config, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.protocolVersion, '2025-06-18');
    const list = await rpc(config, 'tools/list');
    listed.push({ provider, names: list.tools.map(tool => tool.name) });
  }

  async function call(provider, name, args) {
    const result = await rpc(channels.get(provider), 'tools/call', { name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  }

  const adapters = createProviderAdapters({ cwd, writeEnabled: false, spawnProcess(_command, args, options) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.stdin.end();
    child.stdin.once('end', () => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    const provider = args.includes('app-server') ? 'codex' : 'claude';
    const probe = args.includes('--no-session-persistence');
    if (!probe) launched.push(provider);
    const write = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    createInterface({ input: child.stdin }).on('line', line => {
      const input = JSON.parse(line);
      const respond = async () => {
        if (provider === 'codex') {
          if (input.method === 'initialize') write({ id: input.id, result: {} });
          if (input.method === 'thread/start') {
            const { url, http_headers } = input.params.config['mcp_servers.ccgpt_room'];
            await discover(provider, { url, headers: http_headers });
            write({ id: input.id, result: { thread: { id: 'codex-thread' } } });
          }
          if (input.method === 'turn/start') {
            await call(provider, 'room_ask', { to: 'claude', question: 'Can Codex receive this answer?', blocking: false });
            write({ id: input.id, result: {} });
            write({ method: 'turn/completed', params: { threadId: 'codex-thread', turn: { status: 'completed' } } });
          }
          if (input.method === 'thread/compact/start' || input.method === 'review/start') {
            assert.equal(input.params.threadId, 'codex-thread');
            write({ id: input.id, result: {} });
            if (input.method === 'review/start') {
              assert.deepEqual(input.params.target, { type: 'uncommittedChanges' });
              write({ method: 'item/completed', params: { threadId: 'codex-thread',
                item: { id: 'review-item', type: 'exitedReviewMode', review: 'Review output.' } } });
            }
            write({ method: 'turn/completed', params: { threadId: 'codex-thread', turn: { status: 'completed' } } });
          }
        } else if (probe) {
          write({ type: 'control_response', response: { request_id: input.request_id, subtype: 'success', response: {
            commands: [{ name: 'context' }, { name: 'project:check', description: 'A custom command' }],
          } } });
        } else {
          if (!channels.has(provider)) {
            assert.ok(options.env.CCGPT_ROOM_MCP_CONFIG, `No room MCP config in arguments ${args.join(' ')}`);
            const config = JSON.parse(readFileSync(options.env.CCGPT_ROOM_MCP_CONFIG, 'utf8')).mcpServers.ccgpt_room;
            assert.equal(config.type, 'http');
            assert.ok(args[args.indexOf('--allowedTools') + 1].includes('mcp__ccgpt_room__room_answer'));
            await discover(provider, config);
          }
          if (input.message.content[0].text === '/context all') {
            write({ type: 'result', is_error: false, result: 'Context usage.', session_id: '5a82f584-411c-4fd7-826c-c82cc64be420' });
            return;
          }
          const { messages } = await call(provider, 'room_read_log', { filter: { kind: 'question' } });
          await call(provider, 'room_answer', { reply_to: messages.at(-1).id, text: 'Yes. This answer used MCP.' });
          write({ type: 'result', is_error: false, session_id: '5a82f584-411c-4fd7-826c-c82cc64be420' });
        }
      };
      void respond().catch(error => {
        failures.push(error);
        child.emit('error', error);
      });
    });
    return child;
  } });
  const host = createRoomHost({ cwd, roomID: 'native-tools', adapters, emit: event => {
    if (event.error) errors.push(event.text);
  } });
  t.after(() => {
    host.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  await host.send('@codex Ask Claude about tools');
  await host.send('@codex Ask again with warm sessions');
  assert.ok((await host.providerCommands('claude')).some(item => item.name === 'project:check'));
  await host.send('@claude /context all');
  await host.send('@codex /compact');
  await host.send('@codex /review');
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(launched, ['codex', 'claude']);
  assert.equal(listed.length, 2);
  assert.ok(listed.every(({ names }) => names.includes('room_ask') && names.includes('room_answer')));
  assert.notDeepEqual(channels.get('codex').headers, channels.get('claude').headers);
  const { url } = channels.get('codex');
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const idle = await rpc(channels.get('codex'), 'tools/call', { name: 'room_post', arguments: { text: 'late' } });
  assert.equal(idle.isError, true);
  const log = openRoomLog(cwd, 'native-tools').records();
  assert.ok(log.some(message => message.from === 'claude' && message.text === 'Context usage.'));
  assert.ok(log.some(message => message.from === 'codex' && message.text === 'Codex context compacted.'));
  assert.ok(log.some(message => message.from === 'codex' && message.text === 'Review output.'));
  assert.deepEqual(log.filter(message => message.kind === 'answer').map(message => message.text),
    ['Yes. This answer used MCP.', 'Yes. This answer used MCP.']);
});
