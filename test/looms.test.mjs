import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { openAccounts } from '../src/providers/looms-accounts.mjs';
import { openLooms } from '../src/app/looms-app.mjs';
import { layoutLooms, renderLooms } from '../src/terminal/looms-view.mjs';
import { createLoomsAdapters } from '../src/providers/looms-provider-api.mjs';
import { createClaudeCode } from '../src/providers/looms-claude.mjs';
import { connectExternalMcp } from '../src/providers/looms-external-mcp.mjs';
import { runTerminal } from '../src/terminal/looms-terminal.mjs';
import { collectActivity } from '../src/room/room-activity.mjs';

function memoryVault() {
  let value;
  return { read: async () => structuredClone(value), save: async next => { value = structuredClone(next); } };
}

async function selectRoom(input, waitFor, number) {
  const ready = waitFor(new RegExp(`^ LOOMS   Room ${number}\\r?\\n[\\s\\S]* › $`));
  input.write(`Room ${number}\r`);
  return ready;
}

function fakeClaude(directory, onTurn = () => {}) {
  const calls = [];
  const prompts = [];
  let authMethod = 'claude.ai';
  const claude = createClaudeCode(directory, { environment: { PATH: 'fixture-path', ANTHROPIC_API_KEY: 'ignored-key',
    ANTHROPIC_AUTH_TOKEN: 'ignored-token', CLAUDE_CODE_OAUTH_TOKEN: 'ignored-token', CLAUDE_CONFIG_DIR: 'unrelated',
    CLAUDE_CODE_USE_BEDROCK: '1', Anthropic_Base_Url: 'https://example.invalid' },
  locate: async () => 'fixture-claude', spawnProcess(binary, args, options) {
    assert.equal(binary, 'fixture-claude');
    assert.deepEqual(Object.keys(options.env).filter(key => /^(ANTHROPIC_|CLAUDE_)/i.test(key)), ['CLAUDE_CONFIG_DIR']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, options.cwd);
    assert.match(options.cwd, /[\\/]claude-code$/);
    const command = args[0] === 'auth' ? args[1] : 'room';
    calls.push({ command, args, stdio: options.stdio });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.stdin.end();
      child.stdout.end();
      queueMicrotask(() => child.emit('close', null));
    };
    if (command !== 'room') {
      setImmediate(() => {
        child.stdout.end(command === 'status' ? JSON.stringify({ loggedIn: true, authMethod, apiProvider: 'firstParty' }) : '');
        child.emit('close', 0);
      });
      return child;
    }
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    const input = createInterface({ input: child.stdin });
    const send = event => child.stdout.write(`${JSON.stringify(event)}\n`);
    input.on('line', async line => {
      const message = JSON.parse(line);
      if (message.type === 'control_request') {
        send({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
          response: { models: [{ value: 'claude-fixture', displayName: 'Claude Fixture', supportedEffortLevels: ['high'] }],
            commands: [{ name: 'project:check', description: 'Run the project checks.' }] } } });
        return;
      }
      const prompt = message.message.content[0].text;
      if (prompt === '/usage') {
        send({ type: 'result', subtype: 'success', local_command: 'usage', num_turns: 0,
          result: 'Current session: 12% used · resets later\nCurrent week (all models): 25% used' });
        return;
      }
      prompts.push(prompt);
      try { await onTurn(args, prompt); }
      catch (error) {
        send({ type: 'result', subtype: 'error', is_error: true });
        throw error;
      }
      send({ type: 'assistant', message: { model: 'claude-fixture' } });
      send({ type: 'result', subtype: 'success', result: 'Claude replied', usage: { input_tokens: 4, output_tokens: 2 } });
    });
    return child;
  } });
  return { claude, calls, prompts, setAuthMethod: method => { authMethod = method; } };
}

test('Claude requires a subscription sign-in and stores only consent for its isolated Claude Code profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'looms-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { claude, calls, prompts, setAuthMethod } = fakeClaude(directory);
  const vault = memoryVault();
  await vault.save({ host: 'fixture', accounts: { claude: { method: 'ant' } } });
  const accounts = await openAccounts({ vault, claude });
  assert.equal(accounts.list().find(account => account.provider === 'claude').needsReconnect, true);
  assert.throws(() => accounts.claudeCode(), /Connect Claude Code/);
  setAuthMethod('api_key');
  await assert.rejects(accounts.connectClaude(), /Claude subscription/);
  assert.equal(accounts.list().find(account => account.provider === 'claude').connected, false);
  setAuthMethod('claude.ai');
  await accounts.connectClaude();
  assert.deepEqual((await vault.read()).accounts.claude, { method: 'claude-code' });
  assert.equal(accounts.list().find(account => account.provider === 'claude').connected, true);
  const reopened = await openAccounts({ vault, claude });
  const adapters = createLoomsAdapters({ accounts: reopened, fetcher: () => assert.fail('Claude should be routed through the CLI') });
  const member = { provider: 'claude' };
  try {
    await assert.rejects(reopened.credential('claude'), /Claude Code manages/);
    assert.deepEqual(await adapters.catalog('claude'), [{ id: 'claude-fixture', label: 'Claude Fixture', efforts: ['high'] }]);
    assert.equal(await adapters.ask('claude', member, 'hello'), 'Claude replied');
    assert.equal(adapters.prepare(member), true);
    assert.equal(await adapters.ask('claude', member, 'follow up'), 'Claude replied');
    assert.equal(member.actualModel, 'claude-fixture');
    assert.deepEqual(prompts, ['hello', 'follow up']);
    assert.equal(calls.filter(call => call.command === 'room').length, 2);
    await reopened.disconnect('claude');
    assert.equal(adapters.prepare(member), false);
    await assert.rejects(adapters.ask('claude', member, 'after logout'), /Connect Claude Code/);
    assert.deepEqual(calls.map(call => call.command), ['login', 'status', 'login', 'status', 'status', 'room', 'status', 'room', 'logout']);
    assert.ok(calls.filter(call => call.command === 'login').every(call => call.stdio === 'inherit'));
  } finally { adapters.close(); }
});

test('ChatGPT browser consent validates state, PKCE, signed identity, and scope before making the account available', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig' };
  const client = 'oaiapp_fixture';
  const vault = memoryVault();
  let authorization;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    assert.match(url, /auth.openai.com\/api\/accounts\/oauth\/token$/);
    assert.equal(options.body.get('client_id'), client);
    assert.equal(options.body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', kid: jwk.kid });
    const claims = encode({ iss: 'https://auth.openai.com', aud: client, sub: 'fixture-user', exp: Date.now() / 1000 + 3600,
      nonce: authorization.searchParams.get('nonce'), email: 'user@example.invalid', email_verified: true });
    const unsigned = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    return Response.json({ id_token: `${unsigned}.${signature}`, access_token: 'fake-authorized-access', expires_in: 3600,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
  };
  const accounts = await openAccounts({ vault, fetcher });
  await assert.rejects(accounts.credential('codex'), /Connect ChatGPT/);
  await accounts.connectChatGPT(async url => {
    authorization = new URL(url);
    assert.equal(authorization.searchParams.get('agent_name_hint'), 'LOOMS');
    assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
    assert.ok(authorization.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: 'invalid', client_id: client, code: 'fixture-code' });
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(calls.length, 0);
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
  });
  assert.deepEqual(accounts.list()[0], { provider: 'codex', connected: true, email: 'user@example.invalid' });
  const reopened = await openAccounts({ vault, fetcher });
  assert.equal(await reopened.credential('codex'), 'fake-authorized-access');
  await reopened.disconnect('codex');
  await assert.rejects(reopened.credential('codex'), /Connect ChatGPT/);
});

test('LOOMS rooms use explicit provider connections, share tool context, and reopen their transcripts', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-room-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'sample.txt'), 'Workspace evidence');
  await writeFile(join(cwd, '.env.local'), 'DEMO_PASSWORD=fixture');
  await writeFile(join(cwd, 'notes.txt'), '-----BEGIN PRIVATE KEY-----\nfixture');
  const directory = join(cwd, 'state');
  const vault = memoryVault();
  const { claude } = fakeClaude(directory, async (args, prompt) => {
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    const { url, headers } = config.mcpServers.ccgpt_room;
    async function rpc(method, params) {
      const result = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return (await result.json()).result;
    }
    const tool = (name, path) => rpc('tools/call', { name, arguments: { path, ...(name === 'workspace_write_text' && { content: 'overwrite' }) } });
    if (prompt.startsWith('You are a read-only subagent')) {
      assert.doesNotMatch(prompt, /AGENTS\.md/);
      const { tools } = await rpc('tools/list');
      assert.deepEqual(tools.map(item => item.name).sort(), ['workspace_list', 'workspace_read_text']);
      assert.match((await tool('workspace_read_text', 'sample.txt')).content[0].text, /Workspace evidence/);
      assert.equal((await tool('workspace_write_text', 'sample.txt')).isError, true);
      return;
    }
    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /inspect sample.txt/);
    assert.equal(prompt.includes(cwd), false);
    assert.match((await tool('workspace_read_text', 'sample.txt')).content[0].text, /Workspace evidence/);
    const listing = (await tool('workspace_list', '.')).content[0].text;
    assert.match(listing, /sample\.txt/);
    assert.doesNotMatch(listing, /\.env\.local/);
    assert.equal((await tool('workspace_read_text', '.env.local')).isError, true);
    assert.equal((await tool('workspace_read_text', 'notes.txt')).isError, true);
    const missing = await tool('workspace_read_text', 'missing.txt');
    assert.match(missing.content[0].text, /ENOENT/);
    assert.equal(missing.content[0].text.includes(cwd), false);
    assert.match((await tool('workspace_read_text', 'state/claude-code/config.json')).content[0].text, /outside workspace tool access/);
    assert.equal((await tool('workspace_write_text', 'sample.txt')).isError, true);
    const delegated = await rpc('tools/call', { name: 'room_delegate', arguments: { task: 'Read sample.txt for a second opinion.' } });
    assert.deepEqual(JSON.parse(delegated.content[0].text), { result: 'Claude replied' });
  });
  const fetcher = async (url, request) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'), `Unexpected endpoint ${url}`);
    assert.equal(request.headers['x-goog-api-key'], 'test-gemini-key');
    if (url.endsWith(':generateContent')) {
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini reply' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } });
    }
    return Response.json({ models: [{ name: 'models/gemini-fixture', supportedGenerationMethods: ['generateContent'] }] });
  };
  const accounts = await openAccounts({ vault, fetcher, claude });
  await accounts.connectClaude();
  await accounts.connectKey('gemini', 'test-gemini-key');
  const events = [];
  const app = await openLooms({ cwd, directory, accounts, fetcher, notify: event => events.push(event) });
  await assert.rejects(app.command('/include @codex'), /Connect ChatGPT/);
  await app.command('@claude @gemini inspect sample.txt');
  const entries = app.transcript();
  assert.deepEqual(entries.map(entry => entry.speaker), ['user', 'claude', 'gemini']);
  assert.match(entries[1].text, /Claude replied/);
  await app.command('/usage');
  const usage = events.findLast(event => event.type === 'usage');
  assert.match(usage.text, /Claude.*Current session 12% used.*Current week \(all models\) 25% used.*1 turns/);
  assert.match(usage.text, /Gemini.*Plan limits unavailable.*1 turns/);
  await app.command('@claude /usage');
  assert.doesNotMatch(events.at(-1).text, /Gemini/);
  const id = app.rooms()[0].id;
  assert.doesNotMatch(await readFile(join(cwd, '.room', id, 'log.jsonl'), 'utf8'), /test-(claude|gemini)-key/);
  await app.close();
  const reopened = await openLooms({ cwd, directory, accounts, fetcher });
  assert.deepEqual(reopened.transcript(), entries);
  await reopened.close();
});

test('the ChatGPT adapter streams with the authorized token and completes a room tool call', async () => {
  const accounts = { credential: async provider => {
    assert.equal(provider, 'codex');
    return 'authorized-test-token';
  } };
  let rounds = 0;
  const adapters = createLoomsAdapters({ accounts, fetcher: async (url, request) => {
    assert.equal(request.headers.authorization, 'Bearer authorized-test-token');
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-fixture', visibility: 'list' }] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(request.body);
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.equal(payload.tools[0].name, 'room_read_log');
    rounds++;
    if (rounds === 2) assert.deepEqual(payload.input.at(-1), { type: 'function_call_output', call_id: 'call_fixture', output: '{"value":"shared log"}' });
    const output = rounds === 1 ? [{ type: 'function_call', name: 'room_read_log', arguments: '{}', call_id: 'call_fixture' }] :
      [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ChatGPT reply' }] }];
    return new Response(`event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: {
      model: 'gpt-fixture', output, usage: { input_tokens: 3, output_tokens: 2 },
    } })}\r\n\r\n`);
  } });
  const member = { provider: 'codex' };
  try {
    assert.equal(await adapters.ask('codex', member, 'Read room history', false, { allowed: ['room.read_log'],
      async tool(action, args) { assert.equal(action, 'room.read_log'); assert.deepEqual(args, {}); return 'shared log'; },
    }), 'ChatGPT reply');
    assert.deepEqual(member.turnUsage, { input: 6, output: 4 });
  } finally { adapters.close(); }
});

const echoTool = { name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
function fakeExternalResult(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params.protocolVersion,
    serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
  if (request.method === 'tools/list') return { tools: [echoTool] };
  if (request.method === 'tools/call') return { content: [{ type: 'text', text: request.params.arguments.text }] };
}

test('approved stdio MCP tools work in both LOOMS providers and stop when the configuration changes', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-mcp-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, 'state');
  await mkdir(directory);
  const path = join(directory, 'mcp.json');
  const script = `const readline = require('node:readline');
    const echoTool = ${JSON.stringify(echoTool)};
    const result = ${fakeExternalResult.toString()};
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const reply = result(request);
      if (request.method === 'initialize') reply.protocolVersion = '2025-11-25';
      console.log(JSON.stringify({jsonrpc:'2.0', id:request.id, result:reply}));
    });`;
  const fixture = { command: process.execPath, args: ['-e', script] };
  const configure = (config = fixture) => writeFile(path, JSON.stringify({ mcpServers: { Echo: config } }));
  await configure();
  const events = [];
  let expectTools = false;
  const called = new Set();
  const { claude } = fakeClaude(directory, async args => {
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    const { url, headers } = config.mcpServers.ccgpt_room;
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mcp_call_tool',
        arguments: { server: 'Echo', name: 'echo', arguments_json: '{"text":"from Claude"}' } } }) });
    const { result } = await response.json();
    assert.equal(Boolean(result.isError), !expectTools);
    if (expectTools) {
      assert.match(result.content[0].text, /from Claude/);
      called.add('claude');
    }
  });
  const accounts = {
    list: () => ['codex', 'claude'].map(provider => ({ provider, connected: true })),
    credential: async () => 'fixture-token', claudeCode: () => claude,
  };
  const fetcher = async (url, request) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-fixture', visibility: 'list' }] });
    const payload = JSON.parse(request.body);
    assert.equal(payload.tools.some(tool => tool.name === 'mcp_call_tool'), expectTools);
    const toolResult = payload.input.at(-1);
    let output = [{ type: 'message', content: [{ type: 'output_text', text: 'Codex replied' }] }];
    if (expectTools && toolResult.type !== 'function_call_output') {
      output = [{ type: 'function_call', call_id: 'echo', name: 'mcp_call_tool',
        arguments: JSON.stringify({ server: 'Echo', name: 'echo', arguments_json: '{"text":"from Codex"}' }) }];
    } else if (expectTools) {
      assert.match(toolResult.output, /from Codex/);
      called.add('codex');
    }
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-fixture', output } })}\n\n`);
  };
  const options = { cwd, directory, accounts, fetcher, notify: event => events.push(event) };
  const app = await openLooms(options);
  try {
    await app.command('/mcp');
    assert.match(events.at(-1).text, /Echo.*Disabled/);
    await app.command('/mcp enable Echo');
    await assert.rejects(app.command('/mcp test Echo'), /Workspace edits/);
    await app.command('@codex @claude Check which tools are available');
    assert.equal(called.size, 0);
    await app.permissions(true);
    await app.command('/mcp test Echo');
    assert.match(events.at(-1).text, /Connected to Echo.*1 tool/);
    expectTools = true;
    await app.command('@codex @claude Echo a test message');
    assert.deepEqual([...called].sort(), ['claude', 'codex']);
    expectTools = false;
    await app.sendPreview(await app.preview('@codex @claude Check for tools with history excluded', ['history']));
    await app.permissions('ask');
    await assert.rejects(app.command('/mcp test Echo'), /Workspace edits/);
    await app.permissions(true);
    await configure({ ...fixture, env: { FIXTURE_CHANGED: '1' } });
    await app.command('@claude /mcp');
    assert.match(events.at(-1).text, /Echo.*Configuration changed/);
    await assert.rejects(app.command('/mcp test Echo'), /approval/);
    await app.command('/mcp enable Echo');
  } finally { await app.close(); }
  const reopened = await openLooms(options);
  try {
    await reopened.command('/mcp test Echo');
    await reopened.command('/mcp disable Echo');
    await assert.rejects(reopened.command('/mcp test Echo'), /approval/);
  } finally { await reopened.close(); }
});

test('external MCP connects to Streamable HTTP with configured headers', async t => {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' || request.method === 'DELETE') { response.writeHead(405).end(); return; }
    assert.equal(request.headers.authorization, 'Bearer fixture');
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: fakeExternalResult(message) }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = await connectExternalMcp({ url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer fixture' } });
  try {
    assert.deepEqual(await client.listTools(), [echoTool]);
    assert.equal((await client.callTool('echo', { text: 'hello' })).content[0].text, 'hello');
  } finally { await client.close(); }
});

test('each prompt owns its response tabs and the active box pins only its own bar', () => {
  const entries = [
    { speaker: 'user', text: 'First prompt' },
    { speaker: 'codex', text: 'First Codex answer\n'.repeat(15) },
    { speaker: 'claude', text: 'First Claude answer\n'.repeat(15) },
    { speaker: 'user', text: 'Second prompt' },
    { speaker: 'codex', text: 'Second Codex answer\n'.repeat(15) },
    { speaker: 'claude', text: 'Second Claude answer\n'.repeat(15) },
  ];
  const input = { width: 100, height: 120, title: 'Room 1', entries, members: [], canWrite: false, notices: [], styled: false, input: '' };
  const first = layoutLooms(input);
  const tabs = /ALL RESPONSES \| CLAUDE RESPONSE \| CODEX RESPONSE/g;
  assert.equal([...first.screen.matchAll(tabs)].length, 2);
  assert.doesNotMatch(first.screen.split('\n').slice(0, 3).join('\n'), /RESPONSES/);
  const selections = new Map([[first.activeGroup.id, 'claude']]);
  const selected = layoutLooms({ ...input, selections });
  assert.doesNotMatch(selected.screen, /First Codex answer/);
  assert.match(selected.screen, /First Claude answer/);
  assert.match(selected.screen, /Second Codex answer/);
  assert.match(selected.screen, /Second Claude answer/);
  const groups = selected.actions.filter(action => action.prompt).map(action => action.group);
  for (const group of groups) {
    const pinned = layoutLooms({ ...input, selections, firstRow: group.header + 3, height: 14 });
    assert.match(pinned.screen.split('\n')[3], /ALL RESPONSES \| CLAUDE RESPONSE \| CODEX RESPONSE/);
    assert.equal(pinned.activeGroup.id, group.id);
    assert.equal(pinned.actions.find(action => action.prompt).group.start, group.start);
  }
});

test('chat keeps inline Markdown and moves tool diffs to an on-demand view', () => {
  const entries = [{ speaker: 'claude', text: ['# Review', '**Ready** with `app.js`', '**First the analysis, then a conclusion**', '- checklist',
    '\x60\x60\x60js', '  const text = "**literal**";', '\x60\x60\x60', '    another code block'].join('\n'),
    activity: { commands: 4, files: [{ path: 'app.js', kind: 'edited', diff: '@@ -1,1 +1,1 @@\n-old value\n+new value' }] } }];
  const options = { width: 35, height: 32, title: 'Room 1', entries, members: [], notices: [], input: '' };
  const { screen, actions } = layoutLooms(options);
  assert.match(screen, /\x1b\[1mReady\x1b\[0m/);
  assert.match(screen, /\x1b\[96mapp\.js\x1b\[0m/);
  const plain = stripVTControlCharacters(screen).replace(/^ │/gm, '').replace(/ +│$/gm, '');
  assert.match(plain, /then a\n  conclusion/);
  assert.match(plain, /• checklist/);
  assert.doesNotMatch(plain, /literal|another code block/);
  assert.match(plain, /Code block hidden[\s\S]*Ran 4 shell commands[\s\S]*Edited app\.js.*View diff/);
  assert.doesNotMatch(plain, /old value|new value/);
  assert.doesNotMatch(plain, /# Review|\*\*Ready\*\*|`app\.js`|\x60{3}/);
  const { file } = actions.find(action => action.file);
  const diff = stripVTControlCharacters(renderLooms({ ...options, mode: { type: 'diff', file }, firstRow: 0 }));
  assert.match(diff, /Edited app\.js[\s\S]*-old value[\s\S]*\+new value/);
});

test('large safe file changes keep a bounded diff preview', () => {
  const activity = collectActivity();
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(90)}`).join('\n');
  activity.file({ path: 'large.js', before: lines, after: lines.replaceAll('x', 'y') });
  const { diff } = activity.summary().files[0];
  assert.match(diff, /@@[\s\S]*line 0[\s\S]*Diff preview truncated/);
  assert.ok(diff.length <= 8000);
});

test('imported skills are assigned per room and agent, and only named invocations receive the instructions', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-skills-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, 'state');
  const folder = join(cwd, 'Test Skill');
  await mkdir(folder);
  const source = join(folder, 'SKILL.md');
  const instruction = 'Report a checkpoint marker before replying.';
  await writeFile(source, `---\nname: checkpoint-review\ndescription: Review checkpoints\n---\n${instruction}`);
  const { claude, prompts } = fakeClaude(directory, (_args, prompt) => {
    assert.doesNotMatch(prompt, /workspace_write_text/);
  });
  const accounts = { list: () => ['claude', 'codex'].map(provider => ({ provider, connected: true })),
    claudeCode: () => claude, credential: async () => 'fixture' };
  const requests = [];
  const options = { cwd, directory, accounts, async fetcher(url, request) {
    assert.match(url, /\/responses$/);
    requests.push(JSON.parse(request.body));
    const reply = { type: 'response.completed', response: { model: 'fixture', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Checkpoint reviewed.' }] },
    ] } };
    return new Response(`data: ${JSON.stringify(reply)}\n\n`);
  } };
  const app = await openLooms(options);
  try {
    const originalRoom = app.rooms()[0].id;
    await app.command('@claude /skills add "Test Skill"');
    assert.deepEqual(await app.skills('claude'), [{ name: 'checkpoint-review', description: 'Review checkpoints', enabled: true }]);
    assert.equal((await app.skills('codex'))[0].enabled, false);
    assert.equal((await app.providerCommands('claude')).find(command => command.name === 'checkpoint-review')?.available, true);
    assert.equal((await app.providerCommands('codex')).some(command => command.name === 'checkpoint-review'), false);

    await app.command('@claude Normal prompt');
    assert.doesNotMatch(prompts.at(-1), /checkpoint marker/);
    await writeFile(source, 'Altered the original after importing');
    await app.command('@claude /checkpoint-review Inspect the start pad');
    assert.match(prompts.at(-1), /Report a checkpoint marker/);
    assert.match(prompts.at(-1), /Inspect the start pad/);
    assert.doesNotMatch(prompts.at(-1), /Altered the original/);
    assert.ok(app.transcript().every(entry => !entry.text.includes(instruction)));
    await assert.rejects(app.command('@codex /checkpoint-review'), /Unknown command/);
    assert.equal(requests.length, 0);
    await app.setModel('codex', 'fixture');
    await app.command('@codex /skills enable checkpoint-review');
    await app.command('@codex /checkpoint-review Review the respawn');
    assert.equal(requests.length, 1);
    assert.match(requests[0].input.at(-1).content, /Report a checkpoint marker.*Review the respawn/s);
    assert.ok(requests[0].tools.every(tool => tool.name !== 'workspace_write_text'));

    await app.newRoom(['claude']);
    assert.equal((await app.skills('claude'))[0].enabled, false);
    await app.activate(originalRoom);
    assert.equal((await app.skills('claude'))[0].enabled, true);
  } finally { await app.close(); }

  const reopened = await openLooms(options);
  try {
    assert.equal((await reopened.skills('claude'))[0].enabled, true);
    await reopened.command('@claude /skills remove checkpoint-review');
    assert.equal((await reopened.skills('claude'))[0].enabled, false);
    await assert.rejects(reopened.command('@claude /checkpoint-review'), /Unknown command/);
  } finally { await reopened.close(); }
});

function fakeSkillMarketplace() {
  const revision = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const files = new Map([
    ['.claude-plugin/marketplace.json', JSON.stringify({
      name: 'studio-tools',
      plugins: [
        { name: 'studio', source: './plugins/studio', skills: ['./checks/playtest', './checks/broken', './checks/linked'] },
        { name: 'remote', source: { source: 'github', repo: 'other/toolkit' } },
      ],
    })],
    ['plugins/studio/checks/playtest/SKILL.md', '---\nname: studio-playtest\ndescription: Playtest the current place\n---\nCheck respawns.\n'],
    ['plugins/studio/checks/broken/SKILL.md', 'Expected content'],
    ['plugins/studio/checks/linked/SKILL.md', '../playtest/SKILL.md'],
    ['skills/unlisted/SKILL.md', 'Do not show unlisted skills.'],
  ]);
  const calls = [];
  const blob = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
  return { calls, revision, fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.github.com') {
      if (parsed.pathname.endsWith('/commits')) {
        assert.equal(parsed.searchParams.get('sha'), 'v1');
        return Response.json([{ sha: revision, commit: { tree: { sha: tree } } }]);
      }
      assert.equal(parsed.pathname, `/repos/team/skills/git/trees/${tree}`);
      return Response.json({ truncated: false, tree: [...files].map(([path, content]) => ({
        path, sha: blob(content), type: 'blob', mode: path.includes('/linked/') ? '120000' : '100644',
      })) });
    }
    assert.equal(parsed.hostname, 'raw.githubusercontent.com');
    const [, , , pin, ...segments] = parsed.pathname.split('/');
    assert.equal(pin, revision);
    const path = segments.join('/');
    if (path.includes('/broken/')) return new Response('Different content');
    assert.ok(files.has(path), `Unexpected file request ${path}`);
    return new Response(files.get(path));
  } };
}

test('a pinned marketplace installs a verified skill once and assigns it independently', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-market-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { calls, fetcher, revision } = fakeSkillMarketplace();
  const events = [];
  const options = { cwd, directory: join(cwd, 'state'), demo: true, marketplaceFetcher: fetcher, notify: event => events.push(event) };
  const app = await openLooms(options);
  try {
    await assert.rejects(app.command('/skills marketplace add https://example.invalid/team/skills'), /public GitHub/);
    await app.command('/skills marketplace add team/skills#v1');
    const [market] = await app.skillMarketplaces();
    assert.equal(market.name, 'studio-tools');
    assert.equal(market.revision, revision);
    assert.deepEqual(market.skills.map(skill => skill.id), ['broken', 'playtest']);
    await app.command('/skills marketplace add https://github.com/team/skills.git#v1');
    assert.equal(calls.length, 3);
    await assert.rejects(app.command('@claude /skills install broken@studio-tools'), /changed since/);
    assert.deepEqual(await app.skills('claude'), []);
    await app.command('@claude /skills install playtest@studio-tools');
    assert.match(events.at(-1).text, /\/studio-playtest installed for @claude/);
    assert.equal((await app.skills('claude'))[0].enabled, true);
    assert.equal((await app.skills('codex'))[0].enabled, false);
    assert.ok((await app.providerCommands('claude')).some(command => command.name === 'studio-playtest' && command.available));
  } finally { await app.close(); }
  const reopened = await openLooms(options);
  try {
    const previousRequests = calls.length;
    await reopened.command('@codex /skills install playtest@studio-tools');
    assert.equal(calls.length, previousRequests);
    assert.equal((await reopened.skills('codex'))[0].enabled, true);
    assert.equal((await reopened.skills('claude'))[0].enabled, true);
    await reopened.newRoom(['codex', 'claude']);
    assert.equal((await reopened.skills('claude'))[0].enabled, false);
  } finally { await reopened.close(); }
});

test('room and provider slash suggestions keep editing in the composer', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-slash-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, 'state');
  const { claude, calls } = fakeClaude(directory);
  await mkdir(join(cwd, 'smoke-check'));
  await writeFile(join(cwd, 'smoke-check', 'SKILL.md'), 'Check the result before replying.');
  const options = { cwd, directory, marketplaceFetcher: fakeSkillMarketplace().fetcher,
    accounts: { list: () => [{ provider: 'claude', connected: true }], claudeCode: () => claude } };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 20, columns: 80 });
  let screen;
  const frames = new EventEmitter();
  output.on('data', chunk => {
    if (chunk.toString().startsWith('\x1b[?25l\x1b[H')) {
      screen = stripVTControlCharacters(chunk.toString());
      frames.emit('frame', screen);
    }
  });
  const waitFor = pattern => new Promise(resolve => {
    const inspect = frame => {
      if (!pattern.test(frame)) return;
      frames.off('frame', inspect);
      resolve(frame);
    };
    frames.on('frame', inspect);
  });
  const chooser = waitFor(/Choose a room/);
  const terminal = runTerminal(options, input, output);
  try {
    await Promise.race([chooser, terminal]);
    const room = waitFor(/^ LOOMS   Room 1\r?\n[\s\S]*^ › $/m);
    input.write('\r');
    await room;
    input.write('/mc');
    assert.match(screen, /Room commands[\s\S]*\/mcp.*\r?\n[\s\S]*^ › \/mc$/m);
    input.write('\x7f'.repeat(3));
    assert.doesNotMatch(screen, /Room commands/);
    assert.match(screen, /^ › $/m);
    input.write('/room\r');
    assert.match(screen, /^ › \/room $/m);
    input.write('\x15');
    const skillPicker = waitFor(/@claude skills[\s\S]*Import local skill/);
    input.write('@claude /skills\r');
    await skillPicker;
    const importDraft = waitFor(/^ › @claude \/skills add $/m);
    input.write('\r');
    await importDraft;
    const assigned = waitFor(/Remove \/smoke-check/);
    input.write('smoke-check\r');
    await assigned;
    const noMarket = waitFor(/Install skills for @claude[\s\S]*Add marketplace/);
    input.write('\x1b[B\r');
    await noMarket;
    const marketDraft = waitFor(/^ › \/skills marketplace add $/m);
    input.write('\r');
    await marketDraft;
    const marketAdded = waitFor(/Added studio-tools[\s\S]*^ › $/m);
    input.write('team/skills#v1\r');
    await marketAdded;
    const allSkills = waitFor(/@claude skills[\s\S]*Install from marketplace/);
    input.write('@claude /skills\r');
    await allSkills;
    const sources = waitFor(/Install skills for @claude[\s\S]*studio-tools · team\/skills/);
    input.write('\x1b[B\r');
    await sources;
    const marketSkills = waitFor(/Filter: [\s\S]*playtest · studio/);
    input.write('\r');
    await marketSkills;
    const installed = waitFor(/Remove \/studio-playtest/);
    input.write('\x1b[B\r');
    await installed;
    const pickerClosed = waitFor(/^ › $/m);
    input.write('\x1b');
    await pickerClosed;
    const enabledCommand = waitFor(/\/smoke-check   Run this room skill/);
    input.write('@claude /smoke-check');
    await enabledCommand;
    input.write('\x15');
    const projectCommand = waitFor(/\/project:check   Native CLI[\s\S]*^ › @claude \/project$/m);
    input.write('@claude /project');
    assert.match(await projectCommand, /^ › @claude \/project$/m);
    input.write('\x7f'.repeat('/project'.length));
    assert.doesNotMatch(screen, /@claude commands/);
    assert.match(screen, /^ › @claude $/m);
    input.write('/mcp');
    assert.match(screen, /@claude commands[\s\S]*\/mcp/);
    const status = waitFor(/Built-in room tools · local MCP/);
    input.write('\r');
    await status;
    assert.equal(calls.filter(call => call.command === 'room').length, 1);
  } finally {
    input.write('\x03');
    await terminal;
  }
});

test('the terminal scrolls saved history by wheel and keyboard without inserting mouse input', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-scroll-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, directory: join(cwd, 'state'), demo: true };
  const app = await openLooms(options);
  try {
    for (let i = 0; i < 10; i++) await app.command(`@codex${i === 0 || i === 9 ? ' @claude' : ''} Entry ${i}`);
  } finally { await app.close(); }
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 15, columns: 80 });
  let screen;
  const ready = new Promise(resolve => output.on('data', chunk => {
    if (chunk.toString().startsWith('\x1b[?25l\x1b[H')) {
      screen = stripVTControlCharacters(chunk.toString());
      resolve();
    }
  }));
  const terminal = runTerminal(options, input, output);
  try {
    await Promise.race([ready, terminal]);
    assert.match(screen, /Entry 9/);
    input.write('\x1b[<64;');
    input.write('12;4M' + '\x1b[<64;12;4M'.repeat(40));
    assert.match(screen, /Entry 0/);
    assert.doesNotMatch(screen, /Entry 9|12;4M/);
    const click = label => {
      const lines = screen.split('\r\n');
      const row = lines.findIndex(line => line.includes(label));
      assert.ok(row >= 0, `Visible tab: ${label}`);
      input.write(`\x1b[<0;${lines[row].indexOf(label) + 1};${row + 1}M`);
    };
    click('CODEX RESPONSE');
    assert.match(screen, /@CODEX/);
    assert.doesNotMatch(screen, /@CLAUDE/);
    click('↑ Prompt');
    assert.match(screen, /Entry 0/);
    input.write('\x1b[6~');
    assert.match(screen, /Entry 1|Entry 2/);
    input.write('\x1b[1;5F');
    assert.match(screen, /Entry 9/);
  } finally {
    input.write('\x03');
    await terminal;
  }
});

test('the terminal waits for each file approval and defaults to Deny', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-approval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'review.txt');
  const proposed = 'Reviewed content\n';
  const options = {
    cwd, directory: join(cwd, 'state'),
    accounts: { list: () => [{ provider: 'gemini', connected: true }], credential: async () => 'fixture' },
    async fetcher(url, request) {
      if (url.endsWith('/models')) return Response.json({ models: [
        { name: 'models/review', supportedGenerationMethods: ['generateContent'] },
      ] });
      const { contents } = JSON.parse(request.body);
      const last = contents.at(-1).parts[0];
      if (last.functionResponse) {
        const { name, response } = last.functionResponse;
        if (name === 'workspace_write_text') assert.equal(response.value.written, true);
        else assert.match(response.error, /Approval denied/);
        return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Tool call finished.' }] } }] });
      }
      const call = last.text.includes('delete the file') ? { name: 'workspace_delete_file', args: { path: 'review.txt' } } :
        { name: 'workspace_write_text', args: { path: 'review.txt', content: proposed } };
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: call }] } }] });
    },
  };
  const app = await openLooms(options);
  try { await app.permissions('ask'); }
  finally { await app.close(); }

  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 17, columns: 84 });
  const frames = new EventEmitter();
  output.on('data', chunk => {
    if (chunk.toString().startsWith('\x1b[?25l\x1b[H')) frames.emit('frame', stripVTControlCharacters(chunk.toString()));
  });
  const waitFor = pattern => new Promise(resolve => {
    const inspect = frame => {
      if (!pattern.test(frame)) return;
      frames.off('frame', inspect);
      resolve(frame);
    };
    frames.on('frame', inspect);
  });
  const started = waitFor(/Choose a room/);
  const terminal = runTerminal(options, input, output);
  try {
    await Promise.race([started, terminal]);
    assert.match(await selectRoom(input, waitFor, 1), /Ask before changes/);
    const create = waitFor(/Create file[\s\S]*review\.txt/);
    input.write('@gemini write the file\r');
    const screen = await create;
    assert.match(screen, /Approval requested by @gemini/);
    assert.match(screen, /Proposed file contents[\s\S]*Reviewed content/);
    assert.match(screen, /› Deny[\s\S]*Allow once/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    const wrote = waitFor(/Tool call finished\.[\s\S]*›\s*\r?\n?$/);
    input.write('\x1b[C\r');
    assert.match(await wrote, /Created review\.txt/);
    assert.equal(await readFile(path, 'utf8'), proposed);

    const remove = waitFor(/Delete file[\s\S]*review\.txt/);
    input.write('@gemini delete the file\r');
    await remove;
    assert.equal(await readFile(path, 'utf8'), proposed);
    const denied = waitFor(/Tool call finished\.[\s\S]*›\s*\r?\n?$/);
    input.write('\r');
    assert.doesNotMatch(await denied, /Deleted review\.txt/);
    assert.equal(await readFile(path, 'utf8'), proposed);
  } finally {
    input.write('\x03');
    await terminal;
  }
});

test('preview stays local until Send and the terminal sends the trimmed prompt', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-preview-ui-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [];
  const options = {
    cwd, directory: join(cwd, 'state'),
    accounts: { list: () => [{ provider: 'codex', connected: true }], credential: async () => 'fixture' },
    async fetcher(url, request) {
      assert.match(url, /\/responses$/);
      requests.push(JSON.parse(request.body));
      const event = { type: 'response.completed', response: { model: 'fixture', output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Preview send completed.' }] },
      ] } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
  const app = await openLooms(options);
  try {
    await app.setModel('codex', 'fixture');
    await app.command('@codex Earlier room context');
  } finally { await app.close(); }
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 80, columns: 90 });
  const frames = new EventEmitter();
  output.on('data', chunk => {
    if (chunk.toString().startsWith('\x1b[?25l\x1b[H')) frames.emit('frame', stripVTControlCharacters(chunk.toString()));
  });
  const waitFor = pattern => new Promise(resolve => {
    const inspect = frame => {
      if (!pattern.test(frame)) return;
      frames.off('frame', inspect);
      resolve(frame);
    };
    frames.on('frame', inspect);
  });
  const started = waitFor(/Choose a room/);
  const terminal = runTerminal(options, input, output);
  try {
    await Promise.race([started, terminal]);
    await selectRoom(input, waitFor, 1);
    const commandReady = waitFor(/› \/preview $/);
    input.write('/preview\r');
    await commandReady;
    const opened = waitFor(/Preview · @codex Review this change/);
    input.write('@codex Review this change\r');
    const original = await opened;
    assert.match(original, /@codex\s+·\s+~\d+ tokens/);
    assert.match(original, /Recent room history/);
    assert.equal(requests.length, 1);
    const summaryTrimmed = waitFor(/Room summary\s+·\s+excluded/);
    input.write('\r');
    await summaryTrimmed;
    const historyTrimmed = waitFor(/Recent room history\s+·\s+excluded/);
    input.write('\t\r');
    const revised = await historyTrimmed;
    assert.doesNotMatch(revised, /Earlier room context/);
    assert.equal(requests.length, 1);
    const sent = waitFor(/Review this change[\s\S]*Preview send completed\./);
    input.write('\t\r');
    await sent;
    assert.equal(requests.length, 2);
    assert.match(requests[1].input[0].content, /Review this change/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /Earlier room context|AGENTS\.md|room_read_log/);
  } finally {
    input.write('\x03');
    await terminal;
  }
});

test('an interactive launch shows the LOOMS logo and waits for a room choice', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'looms-chooser-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, directory: join(cwd, 'state'), accounts: { list: () => [] } };
  const seeded = await openLooms({ ...options, startBlank: true });
  try {
    assert.equal(seeded.hasRoom, false);
    assert.deepEqual(seeded.rooms(), []);
    await assert.rejects(seeded.command('Start working'), /Choose a room/);
    await seeded.newRoom();
    await seeded.command('/decide Older room transcript');
    await seeded.newRoom();
    await seeded.command('/decide Newest room transcript');
  } finally { await seeded.close(); }

  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 24, columns: 86 });
  const frames = new EventEmitter();
  output.on('data', chunk => {
    if (chunk.toString().startsWith('\x1b[?25l\x1b[H')) frames.emit('frame', stripVTControlCharacters(chunk.toString()));
  });
  const waitFor = pattern => new Promise(resolve => {
    const inspect = frame => {
      if (!pattern.test(frame)) return;
      frames.off('frame', inspect);
      resolve(frame);
    };
    frames.on('frame', inspect);
  });
  const chooser = waitFor(/Choose a room/);
  const terminal = runTerminal(options, input, output);
  try {
    const home = await Promise.race([chooser, terminal]);
    const logo = /^[ ]+[▀▄█]+(?: +[▀▄█]+){4} *$/m;
    assert.match(home, logo);
    assert.match(home, /New room[\s\S]*Room 2[\s\S]*Room 1/);
    assert.doesNotMatch(home, /room transcript|^ LOOMS   Room/m);
    const opened = await selectRoom(input, waitFor, 1);
    assert.match(opened, /Older room transcript/);
    assert.doesNotMatch(opened, /Newest room transcript/);

    const picker = waitFor(/Choose a room/);
    input.write('/rooms\r');
    await picker;
    const created = waitFor(/^ LOOMS   Room 3\r?\n[\s\S]* › $/);
    input.write('New room\r');
    assert.match(await created, logo);
  } finally {
    input.write('\x03');
    await terminal;
  }
});
