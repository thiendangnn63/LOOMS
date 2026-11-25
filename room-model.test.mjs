import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoomModel } from './room-model.mjs';

test('the room model authenticates requests and streams both room speakers in order', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'ccgpt-room-test-'));
  const room = await startRoomModel({ cwd: stateDirectory, demo: true, stateDirectory });
  t.after(() => room.close());
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const { baseURL, apiKey } = room.config.providers[room.model.providerID].settings;
  const endpoint = `${baseURL}/chat/completions`;
  const messages = [{ role: 'user', content: 'hello' }];
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-opencode-session-id': 'demo-session' },
    body: JSON.stringify({ model: room.model.id, messages, stream: true }),
  };
  const denied = await fetch(endpoint, options);
  assert.equal(denied.status, 401);

  options.headers.Authorization = `Bearer ${apiKey}`;
  const result = await fetch(endpoint, options);
  assert.equal(result.status, 200);
  const chunks = await result.text();
  assert.match(chunks, /### @codex[\s\S]*### @claude[\s\S]*I saw Codex’s reply/);
  assert.match(chunks, /data: \[DONE\]/);
});

test('room controls persist service selection, models, permissions, and room activity', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'ccgpt-room-test-'));
  let room = await startRoomModel({ cwd: stateDirectory, demo: true, stateDirectory });
  t.after(() => room.close());
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const sessionID = 'configured-room';
  const request = async (path, body) => {
    const response = await fetch(`${room.control.url}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${room.control.token}` },
      body: JSON.stringify({ sessionID, ...body }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await request('settings', { roster: ['claude'] });
  await request('settings', { include: 'gemini' });
  await request('settings', { modelSettings: { provider: 'claude', model: 'demo-claude', effort: 'medium' }, writeEnabled: true });
  const { baseURL, apiKey } = room.config.providers[room.model.providerID].settings;
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'x-opencode-session-id': sessionID },
    body: JSON.stringify({ model: room.model.id, messages: [{ role: 'user', content: '@claude hello' }] }),
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).choices[0].message.content, /^### @claude\n\n[^#]+$/);
  room.close();
  room = await startRoomModel({ cwd: stateDirectory, demo: true, stateDirectory });
  const usage = await request('usage');
  assert.equal(usage.writeEnabled, true);
  assert.deepEqual(usage.members.map(member => [member.provider, member.activity.turns, member.account.length]),
    [['claude', 1, 1], ['gemini', 0, 1]]);
  assert.equal(usage.members[0].model, 'demo-claude');
  assert.equal(usage.members[0].effort, 'medium');
});

test('the room exposes separate provider command lists and routes commands to one room member', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'ccgpt-command-test-'));
  const room = await startRoomModel({ cwd: stateDirectory, demo: true, stateDirectory });
  t.after(() => room.close());
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const sessionID = 'command-room';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${room.control.token}` };
  const request = (operation, args) => fetch(`${room.control.url}/${operation}`, {
    method: 'POST', headers, body: JSON.stringify({ sessionID, ...args }),
  });
  const claude = await (await request('commands', { target: 'claude' })).json();
  const codex = await (await request('commands', { target: 'chatgpt' })).json();
  assert.ok(claude.commands.find(item => item.name === 'context')?.available);
  assert.ok(codex.commands.find(item => item.name === 'review')?.available);
  assert.equal(codex.commands.find(item => item.name === 'fork')?.available, false);
  assert.equal(codex.commands.find(item => item.name === 'context'), undefined);

  const endpoint = `${room.config.providers[room.model.providerID].settings.baseURL}/chat/completions`;
  const send = async content => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { ...headers, 'x-opencode-session-id': sessionID },
      body: JSON.stringify({ model: room.model.id, messages: [{ role: 'user', content }] }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).choices[0].message.content;
  };
  assert.equal(await send('@claude /context all'), '### @claude\n\nDemo claude /context all');
  assert.equal(await send('@chatgpt /review'), '### @codex\n\nDemo codex /review');
  assert.match(await send('@claude /login'), /^### Room status\n\nUse \/login in the Claude Code terminal/);
  assert.match(await send('@claude /usage'), /35% used/);

  await request('settings', { roster: ['codex'] });
  const excluded = await request('commands', { target: 'claude' });
  assert.equal(excluded.status, 400);
});
