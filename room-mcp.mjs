import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { externalMcpActions, mcpTools, runMcpTool } from './room-tools.mjs';

export const roomServerName = 'ccgpt_room';
const protocols = ['2025-11-25', '2025-06-18'];
const externalToolNames = new Set(externalMcpActions.map(action => action.replace('.', '_')));

export async function startRoomMcp() {
  const channels = new Map();
  const server = createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}` || request.headers.origin) {
      response.writeHead(403).end();
      return;
    }
    const channel = request.url === '/mcp' && channels.get(request.headers.authorization);
    if (!channel) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const call = channel.call;
    let data;
    try {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 250_000) {
          response.writeHead(413).end();
          return;
        }
      }
      data = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (data?.jsonrpc !== '2.0' || typeof data.method !== 'string') {
      response.writeHead(400).end();
      return;
    }
    if (data.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = value => response.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: data.id, ...value }));
    switch (data.method) {
      case 'initialize':
        return reply({ result: {
          protocolVersion: protocols.includes(data.params?.protocolVersion) ? data.params.protocolVersion : protocols[0],
          serverInfo: { name: roomServerName, version: '1.0.0' }, capabilities: { tools: {} },
        } });
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({ result: { tools: channel.tools } });
      case 'tools/call': {
        try {
          if (!call || channel.call !== call || !channels.has(request.headers.authorization)) {
            throw new Error('There is no active room turn for this connection.');
          }
          if (externalToolNames.has(data.params?.name) && !channel.tools.some(tool => tool.name === data.params.name)) {
            throw new Error('External MCP is unavailable in this turn.');
          }
          const result = await runMcpTool(call, data.params?.name, data.params?.arguments);
          return reply({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
        } catch (error) {
          return reply({ result: { isError: true, content: [{ type: 'text', text: error.message }] } });
        }
      }
      default:
        return reply({ error: { code: -32601, message: 'Unknown MCP method.' } });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    register(allowed) {
      const authorization = `Bearer ${randomBytes(32).toString('base64url')}`;
      const tools = mcpTools.filter(tool => allowed ? allowed.includes(tool.name) : !externalToolNames.has(tool.name));
      const channel = { url, headers: { Authorization: authorization }, tools, call: undefined, close() {
        channel.call = undefined;
        channels.delete(authorization);
      } };
      channels.set(authorization, channel);
      return channel;
    },
    close() {
      for (const channel of channels.values()) channel.close();
      server.close();
      server.closeAllConnections();
    },
  };
}
