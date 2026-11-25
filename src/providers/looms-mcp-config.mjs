import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const serverName = /^[a-z][a-z0-9_-]{0,63}$/i;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const stringMap = value => isObject(value) && Object.values(value).every(item => typeof item === 'string');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalizeServer(name, input) {
  const invalid = () => new Error(`Invalid MCP configuration for ${name}.`);
  if (!isObject(input)) throw invalid();
  const { command, args = [], env, url, headers, type } = input;
  if (typeof command === 'string' && command.trim() && url === undefined && headers === undefined &&
      (type === undefined || type === 'stdio') && Array.isArray(args) && args.every(arg => typeof arg === 'string') &&
      (env === undefined || stringMap(env))) return { command, args, env };
  if (typeof url !== 'string' || command !== undefined || input.args !== undefined || env !== undefined ||
      ![undefined, 'http', 'streamable-http'].includes(type) || (headers !== undefined && !stringMap(headers))) throw invalid();
  let endpoint;
  try { endpoint = new URL(url); } catch { throw invalid(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))) throw invalid();
  return { url: endpoint.href, headers };
}

async function readServers(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error('Could not read the LOOMS MCP configuration.');
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('The LOOMS MCP configuration must be valid JSON.'); }
  if (!isObject(data?.mcpServers)) throw new Error('The LOOMS MCP configuration needs an mcpServers object.');
  return new Map(Object.entries(data.mcpServers).map(([name, input]) => {
    if (!serverName.test(name)) throw new Error('MCP server names must start with a letter and use letters, numbers, underscores, or hyphens.');
    const config = normalizeServer(name, input);
    return [name, { config, hash: fingerprint(config) }];
  }));
}

export function createRoomMcpConnections({ directory, approvals, hasWriteAccess, connect }) {
  const path = join(directory, 'mcp.json');
  const sessions = new Map();
  let servers = new Map();
  let configError;
  let closing;
  const approved = (name, server) => server && Object.hasOwn(approvals, name) && approvals[name] === server.hash;

  function disconnect(name) {
    const session = sessions.get(name);
    sessions.delete(name);
    return session?.client.then(client => client.close()).catch(() => {});
  }

  async function refresh() {
    try { servers = await readServers(path); configError = undefined; }
    catch (error) { servers = new Map(); configError = error.message; }
    await Promise.all([...sessions].filter(([name, session]) =>
      !approved(name, servers.get(name)) || session.hash !== servers.get(name).hash).map(([name]) => disconnect(name)));
  }

  function enabled() {
    return !closing && hasWriteAccess() ? [...servers].filter(([name, server]) => approved(name, server)).map(([name]) => name) : [];
  }

  async function withServer(name, operation) {
    await refresh();
    if (!enabled().includes(name)) throw new Error(`MCP server ${name} needs room approval and Workspace edits.`);
    const server = servers.get(name);
    let session = sessions.get(name);
    if (!session) {
      session = { hash: server.hash, state: 'Connecting', client: Promise.resolve().then(() => connect(server.config)) };
      sessions.set(name, session);
    }
    try {
      const client = await session.client;
      if (!enabled().includes(name) || sessions.get(name) !== session) throw new Error('MCP access changed.');
      session.state = 'Connected';
      return await operation(client);
    } catch {
      if (sessions.get(name) === session) await disconnect(name);
      throw new Error(`MCP request to ${name} failed. Check that the server is available and its configuration is current.`);
    }
  }

  const pause = () => Promise.all([...sessions.keys()].map(disconnect));
  return {
    path, refresh, enabled,
    pause,
    get configError() { return configError; },
    async setEnabled(name, value) {
      if (!serverName.test(name)) throw new Error('Specify an MCP server name.');
      if (value) {
        const server = servers.get(name);
        if (!server) throw new Error(`MCP server ${name} is not configured.`);
        approvals[name] = server.hash;
      } else {
        delete approvals[name];
        await disconnect(name);
      }
    },
    status() {
      return [...servers].map(([name, server]) => {
        const access = approved(name, server) ? hasWriteAccess() ? sessions.get(name)?.state ?? 'Enabled' : 'Paused by room access' :
          Object.hasOwn(approvals, name) ? 'Configuration changed · enable again' : 'Disabled';
        return `${name}  ·  ${server.config.url ? 'HTTP' : 'stdio'}  ·  ${access}`;
      });
    },
    listTools: name => withServer(name, client => client.listTools()),
    callTool: (name, tool, args) => withServer(name, client => client.callTool(tool, args)),
    close: () => closing ??= pause(),
  };
}
