import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { createRoomHost } from './room-host.mjs';
import { createProviderAdapters } from './room-providers.mjs';
import { createDemoAdapters } from './room-demo.mjs';
import { createRoomSettings } from './room-settings.mjs';
import { providerLabels } from './room-providers.mjs';
import { configuredRoomSummarizer } from './room-summary.mjs';

const historyHash = text => createHash('sha256').update(text).digest('hex');

function transcript(messages) {
  return messages.filter(message => ['user', 'assistant'].includes(message.role)).map(({ role, content }) => ({
    role,
    text: typeof content === 'string' ? content : content?.filter(part => part.type === 'text')
      .map(part => part.text).join('\n') ?? '',
  })).filter(message => message.text);
}

function restore(messages) {
  return messages.flatMap(({ role, text }) => {
    if (role === 'user') return [{ speaker: 'user', text }];
    const sections = text.split(/(?:^|\n\n)### (@[a-z][a-z0-9_-]*|Room status)\n\n/);
    if (sections.length < 3) return [{ speaker: 'room', text }];
    const entries = [];
    for (let index = 1; index < sections.length; index += 2) {
      if (sections[index].startsWith('@')) {
        entries.push({ speaker: sections[index].slice(1), text: sections[index + 1] });
      }
    }
    return entries;
  });
}

export async function startRoomModel({ cwd, demo = false, writeEnabled = false, stateDirectory }) {
  const providerID = demo ? 'ccgpt-demo' : 'ccgpt';
  const agent = demo ? 'ccgpt-room-demo' : 'ccgpt-room';
  const model = { providerID, id: 'room' };
  const token = randomBytes(32).toString('base64url');
  const rooms = new Map();
  const changing = new Set();
  const settings = createRoomSettings({ cwd, demo, writeEnabled, stateDirectory });
  const server = createServer(async (request, response) => {
    const chatRequest = request.url === '/v1/chat/completions';
    if (request.method !== 'POST' || (!chatRequest && !request.url?.startsWith('/room/'))) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }

    let sessionID = request.headers['x-opencode-session-id'];
    let room;
    const json = (status, data) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    try {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4_000_000) {
          response.writeHead(413).end();
          return;
        }
      }
      const input = JSON.parse(body);
      if (!chatRequest) {
        if (request.url === '/room/providers') {
          const location = input.directory ? await realpath(input.directory) : cwd;
          const providers = await settings.available(location);
          json(200, providers.map(provider => ({ provider, label: providerLabels[provider] })));
          return;
        }
        sessionID = input.sessionID;
        const record = await settings.get(sessionID);
        if (request.url === '/room/commands') {
          if (typeof input.target !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(input.target)) throw new Error('Invalid room member.');
          json(200, await settings.commands(record, input.target));
          return;
        }
        if (request.url === '/room/settings') {
          const active = rooms.get(sessionID);
          if (active?.busy || changing.has(sessionID)) {
            json(409, { error: { message: 'Wait for the current room operation to finish.' } });
            return;
          }
          changing.add(sessionID);
          try {
            if (input.directory) {
              const next = await realpath(input.directory);
              if (next !== record.cwd) {
                active?.host.close();
                rooms.delete(sessionID);
                record.cwd = next;
                record.writeEnabled = false;
              }
            }
            await settings.update(record, input);
            await rooms.get(sessionID)?.host.configure(record.members, record.writeEnabled);
            json(200, await settings.view(record));
          } finally {
            changing.delete(sessionID);
          }
          return;
        }
        if (!['/room/state', '/room/models', '/room/usage'].includes(request.url)) {
          json(404, { error: { message: 'Unknown room operation.' } });
          return;
        }
        json(200, await settings.view(record, {
          withCatalog: request.url === '/room/models',
          withUsage: request.url === '/room/usage',
        }));
        return;
      }
      const messages = transcript(input.messages);
      const latest = messages.pop();
      if (!sessionID || input.model !== model.id || latest?.role !== 'user') {
        response.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Expected a CCGPT room session and a user message' } }));
        return;
      }

      const prior = JSON.stringify(messages);
      const record = await settings.get(sessionID);
      room = rooms.get(sessionID);
      if (room?.busy || changing.has(sessionID)) {
        response.writeHead(409).end();
        return;
      }
      if (room?.history !== prior) {
        room?.host.close();
        const state = { history: prior, busy: false, publish: () => {} };
        state.host = createRoomHost({
          cwd: record.cwd,
          roomID: sessionID,
          liveTasks: !demo,
          nativeHistoryHash: historyHash(prior),
          writeEnabled: record.writeEnabled,
          initialMembers: record.members,
          adapters: demo ? createDemoAdapters() : createProviderAdapters({ cwd: record.cwd, writeEnabled: record.writeEnabled }),
          history: restore(messages),
          summarize: demo ? undefined : configuredRoomSummarizer(record.cwd, process.env.CCGPT_ROOM_SUMMARIZER, createProviderAdapters),
          emit: event => state.publish(event),
          onTurn: turn => settings.recordTurn(record, turn),
        });
        rooms.set(sessionID, state);
        room = state;
      }

      const activeRoom = room;
      response.once('close', () => {
        if (!response.writableFinished && rooms.get(sessionID) === activeRoom) {
          activeRoom.host.close();
          rooms.delete(sessionID);
        }
      });
      room.busy = true;
      const result = [];
      const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: input.model };
      const writeChunk = (delta, finish_reason = null) => {
        if (response.destroyed) return;
        const payload = { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] };
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      if (input.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        writeChunk({ role: 'assistant' });
      }
      function append(content) {
        const separator = result.length ? '\n\n' : '';
        result.push(content);
        if (input.stream) writeChunk({ content: separator + content });
      }
      const status = text => append(`### Room status\n\n${text}`);
      room.publish = event => {
        if (event.type === 'message' && event.entry.speaker !== 'user') {
          append(`### @${event.entry.speaker}\n\n${event.entry.text}`);
        } else if (event.type === 'status') {
          status(event.text);
        }
      };
      try {
        await room.host.command(latest.text);
      } catch (error) {
        status(error.message);
      }
      if (rooms.get(sessionID) === room) {
        record.members = room.host.roster();
        await settings.save(record);
      }
      if (!result.length) status('Both agents passed.');
      const text = result.join('\n\n');
      room.history = JSON.stringify([...messages, latest, { role: 'assistant', text }]);
      if (rooms.get(sessionID) === room) room.host.checkpoint(historyHash(room.history));
      room.busy = false;
      room.publish = () => {};
      if (response.destroyed) return;
      if (input.stream) {
        writeChunk({}, 'stop');
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ...base, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        }));
      }
    } catch (error) {
      if (room && rooms.get(sessionID) === room) {
        room.host.close();
        rooms.delete(sessionID);
      }
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  return {
    agent,
    model,
    control: { url: `http://127.0.0.1:${server.address().port}/room`, token },
    config: {
      providers: {
        [providerID]: {
          name: demo ? 'CCGPT Demo' : 'CCGPT',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token, provider: providerID },
          models: {
            [model.id]: { name: 'Claude Code + Codex', capabilities: { tools: false, input: ['text'], output: ['text'] } },
          },
        },
      },
      agents: {
        [agent]: {
          mode: 'primary',
          description: 'Shared Claude Code and Codex conversation',
          model: `${providerID}/${model.id}`,
        },
      },
    },
    close() {
      for (const { host } of rooms.values()) host.close();
      settings.close();
      rooms.clear();
      server.closeAllConnections();
      server.close();
    },
  };
}
