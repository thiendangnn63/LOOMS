// Official @modelcontextprotocol/client 2.4.0 (v2 request-options signatures).
const CONNECT_MS = 15_000;
const LIST_MS = 15_000;
const CALL_MS = 60_000;
const CLOSE_MS = 5_000;
const TERMINATE_MS = 1_000;
const MAX_TOOL_PAGES = 100;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

class ExternalMcpError extends Error {}
class DeadlineError extends ExternalMcpError {}

const isRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isString = value => typeof value === 'string' && !value.includes('\0');
const isStringMap = value => isRecord(value) && Object.entries(value).every(
  ([key, item]) => isString(key) && isString(item),
);

function parseConfig(config) {
  const invalid = () => new ExternalMcpError('Invalid external MCP server configuration.');
  if (!isRecord(config)) throw invalid();
  const { command, args, env, url, headers } = config;
  if (isString(command) && command.trim() && url === undefined && headers === undefined &&
      (args === undefined || (Array.isArray(args) && [...args].every(isString))) &&
      (env === undefined || (isStringMap(env) && Object.keys(env).every(key => key && !key.includes('='))))) {
    return { command, args: [...(args ?? [])], ...(env === undefined ? {} : { env: { ...env } }) };
  }
  if (!isString(url) || command !== undefined || args !== undefined || env !== undefined ||
      (headers !== undefined && !isStringMap(headers))) throw invalid();
  try {
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw invalid();
    }
    return { endpoint, headers: Object.fromEntries(new Headers(Object.entries(headers ?? {}))) };
  } catch {
    throw invalid();
  }
}

async function bounded(ms, operation, parentSignal) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new DeadlineError('External MCP operation timed out.')), ms);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation({ timeout: ms, signal });
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function safeError(sdk, error, operation) {
  if (error instanceof ExternalMcpError) return error;
  // Never surface SDK messages or causes: they may contain URLs, headers, argv or server output.
  if (operation === 'connect' && error?.code === 'ENOENT') {
    return new ExternalMcpError('External MCP executable was not found.');
  }
  if (sdk.SdkHttpError && error instanceof sdk.SdkHttpError &&
      Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    return new ExternalMcpError(`External MCP could not ${operation} (HTTP ${error.status}).`);
  }
  return new ExternalMcpError(`External MCP could not ${operation}.`);
}

/**
 * Connect to an already user-approved `{ command, args?, env? }` or `{ url, headers? }`.
 * Stdio launches only the configured command/argv, e.g. `cmd.exe` with `['/d', '/c', ...]`
 * on Windows. LOOMS adds no shell, installer, OAuth flow, or executable from server data.
 * `listTools()` returns full tool descriptors across pages; `callTool(name, args)` returns
 * the SDK result intact (including `content`, `structuredContent`, and `isError`). Oversize
 * catalogs/results fail rather than being truncated. `close()` is idempotent. Tool calls
 * are never retried by LOOMS; a canceled/timed-out call may still have run on the server.
 */
export async function connectExternalMcp(config) {
  const { endpoint, headers, ...stdio } = parseConfig(config);
  let sdk, transport, client;
  try {
    sdk = await import('@modelcontextprotocol/client');
    client = new sdk.Client({ name: 'looms-rooms', version: '1.0.0' }, { capabilities: {} });
    if (endpoint) {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client/streamableHttp').catch(error => {
        if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return sdk;
        throw error;
      });
      transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers },
        // Do not follow redirects to an endpoint the user did not approve.
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      });
    } else {
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
      transport = new StdioClientTransport({ ...stdio, stderr: 'ignore' });
    }
  } catch {
    throw new ExternalMcpError('Could not load or configure the external MCP client.');
  }

  try {
    await bounded(CONNECT_MS, options => client.connect(transport, options));
  } catch (error) {
    await bounded(CLOSE_MS, () => transport.close()).catch(() => {});
    throw safeError(sdk, error, 'connect');
  }

  const lifetime = new AbortController();
  let closing;
  function close() {
    return closing ??= (async () => {
      lifetime.abort(new ExternalMcpError('External MCP connection is closed.'));
      if (endpoint && transport.sessionId !== undefined) {
        // Best effort: a stateful HTTP server may refuse DELETE or never answer it.
        await bounded(TERMINATE_MS, () => transport.terminateSession()).catch(() => {});
      }
      try { await bounded(CLOSE_MS, () => client.close()); }
      catch (error) { throw safeError(sdk, error, 'close'); }
    })();
  }

  async function request(ms, label, operation) {
    try { return await bounded(ms, operation, lifetime.signal); }
    catch (error) {
      // Some legacy transports do not abort their I/O on a request timeout.
      if (error instanceof DeadlineError) void close().catch(() => {});
      throw safeError(sdk, error, label);
    }
  }

  return {
    listTools: () => request(LIST_MS, 'list tools', async options => {
      const tools = [];
      const seen = new Set();
      let cursor, bytes = 2;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        options.signal.throwIfAborted();
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, options);
        for (const tool of result.tools) {
          bytes += Buffer.byteLength(JSON.stringify(tool)) + Number(tools.length > 0);
          if (bytes > MAX_CATALOG_BYTES) throw new ExternalMcpError('External MCP tool catalog exceeds the size limit.');
          tools.push(tool);
        }
        cursor = result.nextCursor;
        if (cursor === undefined) return tools;
        if (seen.has(cursor)) throw new ExternalMcpError('External MCP tool catalog repeated a pagination cursor.');
        seen.add(cursor);
      }
      throw new ExternalMcpError('External MCP tool catalog exceeds the page limit.');
    }),
    async callTool(name, args = {}) {
      if (!isString(name) || !name.trim() || !isRecord(args)) {
        throw new ExternalMcpError('An external MCP tool name and an arguments object are required.');
      }
      return request(CALL_MS, 'call the tool', async options => {
        const result = await client.callTool({ name, arguments: args }, options);
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
          throw new ExternalMcpError('External MCP tool result exceeds the size limit.');
        }
        return result;
      });
    },
    close,
  };
}
