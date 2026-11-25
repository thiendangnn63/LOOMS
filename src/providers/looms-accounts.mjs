import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCode } from './looms-claude.mjs';
import { accountLabels, roomServices } from './room-services.mjs';
export { accountLabels };

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const planScope = 'chatgpt.tokens.use.direct';
export const accountDirectory = () => join(process.env.LOOMS_STATE_DIR ?? (process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_STATE_HOME)
  ?? join(homedir(), '.local', 'state'), 'looms');

export async function serviceRequest(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Request to ${new URL(url).hostname} failed (HTTP ${response.status}).`);
  }
  return response;
}

const dpapiScript = protect => `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Security
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $result = [Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))`;

async function dpapi(contents, protect) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(dpapiScript(protect), 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(20_000) });
  let result = '';
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', data => { result += data; });
  const closed = once(child, 'close');
  child.stdin.end(contents.toString('base64'));
  const [code] = await closed;
  if (code || !result) throw new Error('Windows could not unlock the LOOMS credential vault.');
  return Buffer.from(result, 'base64');
}

async function localVault(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('LOOMS state must be stored in a regular directory.');
  const protect = process.platform === 'win32';
  const path = join(directory, protect ? 'accounts.dpapi' : 'accounts.json');
  return {
    async read() {
      try {
        const info = await lstat(path);
        if (!info.isFile() || (!protect && (info.mode & 0o077))) throw new Error('LOOMS credentials require a private regular file.');
        const bytes = await readFile(path);
        return JSON.parse((protect ? await dpapi(bytes, false) : bytes).toString('utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    async save(value) {
      const bytes = Buffer.from(JSON.stringify(value));
      const contents = protect ? await dpapi(bytes, true) : bytes;
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600, flag: 'wx', flush: true });
      try { await rename(temporary, path); }
      catch (error) { await unlink(temporary); throw error; }
    },
  };
}

async function tokenRequest(fetcher, fields) {
  const response = await serviceRequest(fetcher, `${issuer}/api/accounts/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ ...fields, resource }),
  });
  const tokens = await response.json();
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error('ChatGPT returned incomplete credentials.');
  }
  return tokens;
}

async function identityOf(fetcher, idToken, client, nonce) {
  if (typeof idToken !== 'string' || idToken.length > 32_000) throw new Error('ChatGPT did not return an identity token.');
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) throw new Error('Invalid ChatGPT identity token.');
  const [header, payload, signature] = segments;
  const metadata = JSON.parse(Buffer.from(header, 'base64url'));
  if (metadata.alg !== 'RS256' || typeof metadata.kid !== 'string') throw new Error('Unsupported ChatGPT identity signature.');
  const response = await serviceRequest(fetcher, `${issuer}/.well-known/jwks.json`);
  const { keys } = await response.json();
  const key = keys.find(entry => entry.kid === metadata.kid && entry.kty === 'RSA' && (!entry.use || entry.use === 'sig'));
  if (!key || !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('Could not verify the ChatGPT identity signature.');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(client) || (audiences.length > 1 && claims.azp !== client) ||
      (claims.azp && claims.azp !== client) || claims.nonce !== nonce || !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= Date.now() || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid ChatGPT identity claims.');
  return { subject: claims.sub, email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email : undefined };
}

async function authorizeChatGPT(fetcher, host, previous, showURL, signal) {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(4 * 60_000)]) : AbortSignal.timeout(4 * 60_000);
  let received;
  let redirect;
  const listener = createServer((request, response) => {
    let url;
    try { url = new URL(request.url, redirect); }
    catch { response.writeHead(400).end('Invalid LOOMS callback.'); return; }
    if (!redirect) { response.writeHead(400).end('Invalid LOOMS callback.'); return; }
    const expected = new URL(redirect);
    if (request.method !== 'GET' || request.headers.host !== expected.host || url.origin !== expected.origin || url.pathname !== expected.pathname ||
        url.searchParams.get('state') !== state || received) {
      response.writeHead(400).end('Invalid LOOMS callback.');
      return;
    }
    const code = url.searchParams.get('code');
    const client = url.searchParams.get('client_id') ?? previous?.client;
    received = { code, client, error: url.searchParams.get('error') };
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      .end('Return to LOOMS to finish connecting your ChatGPT account.');
    listener.emit('authorization');
  });
  listener.listen(0, '127.0.0.1');
  try {
    await once(listener, 'listening', { signal: scope });
    redirect = `http://127.0.0.1:${listener.address().port}/auth/callback`;
    const authorize = new URL(`${issuer}/api/accounts/authorize`);
    authorize.search = new URLSearchParams({ client_id: previous?.client ?? 'dynamic_agent_client',
      ...(!previous?.client && { agent_name_hint: 'LOOMS' }), ext_agent_host_id: host,
      response_type: 'code', redirect_uri: redirect, scope: `openid profile email offline_access resource.invoke ${planScope}`,
      resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const callback = once(listener, 'authorization', { signal: scope });
    void callback.catch(() => {});
    await showURL(authorize.href);
    await callback;
    const { code, client, error } = received;
    if (error) throw new Error('ChatGPT authorization was declined or interrupted.');
    if (!code || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(client ?? '') || (previous?.client && client !== previous.client)) {
      throw new Error('ChatGPT returned an unexpected client registration.');
    }
    const tokens = await tokenRequest(fetcher, { grant_type: 'authorization_code', client_id: client, code, code_verifier: verifier, redirect_uri: redirect });
    const identity = await identityOf(fetcher, tokens.id_token, client, nonce);
    if (previous?.subject && identity.subject !== previous.subject) throw new Error('Use the same ChatGPT account or disconnect it before connecting another.');
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [];
    if (!scopes.includes(planScope)) throw new Error('Grant LOOMS permission to use your ChatGPT plan, then try again.');
    return { ...identity, client, scopes, access: tokens.access_token, refresh: tokens.refresh_token, expires: Date.now() + tokens.expires_in * 1000 };
  } finally {
    listener.close();
    listener.closeAllConnections();
  }
}

export async function openAccounts({ directory = accountDirectory(), fetcher = fetch, vault, claude = createClaudeCode(directory) } = {}) {
  vault ??= await localVault(directory);
  const data = await vault.read() ?? { host: `urn:uuid:${randomUUID()}`, accounts: {} };
  let writes = Promise.resolve();
  let refreshing;
  function save() {
    const snapshot = structuredClone(data);
    const pending = writes.then(() => vault.save(snapshot));
    writes = pending.catch(() => {});
    return pending;
  }

  return {
    list() {
      return Object.keys(accountLabels).map(provider => {
        const account = data.accounts[provider];
        const needsReconnect = provider === 'claude' && account && account.method !== 'claude-code';
        return { provider, connected: Boolean(account && !needsReconnect), email: account?.email,
          ...(needsReconnect && { needsReconnect: true }) };
      });
    },
    async connectChatGPT(showURL, signal) {
      await save();
      const previous = data.accounts.codex;
      const next = await authorizeChatGPT(fetcher, data.host, previous, showURL, signal);
      data.accounts.codex = next;
      await save();
    },
    async connectClaude(signal) {
      await claude.connect(signal);
      signal?.throwIfAborted();
      data.accounts.claude = { method: 'claude-code' };
      await save();
    },
    claudeCode() {
      if (data.accounts.claude?.method !== 'claude-code') throw new Error('Connect Claude Code in /accounts first.');
      return claude;
    },
    async connectKey(provider, key, signal) {
      const service = Object.hasOwn(roomServices, provider) && roomServices[provider];
      if (!service?.keyCheck || typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key)) {
        throw new Error(`Enter a valid ${service?.accountLabel ?? 'provider'} API key.`);
      }
      const response = await serviceRequest(fetcher, service.keyCheck.url,
        { headers: { [service.keyCheck.header]: key }, signal: signal && AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      await response.body?.cancel();
      data.accounts[provider] = { key };
      await save();
    },
    async disconnect(provider) {
      if (!Object.hasOwn(roomServices, provider)) throw new Error('Choose a provider from /accounts.');
      const signOut = provider === 'claude' && data.accounts.claude?.method === 'claude-code';
      delete data.accounts[provider];
      await save();
      if (signOut) await claude.disconnect();
    },
    async credential(provider) {
      if (provider === 'claude') throw new Error('Claude Code manages its own sign-in.');
      const account = Object.hasOwn(accountLabels, provider) && data.accounts[provider];
      if (!account) throw new Error(`Connect ${accountLabels[provider] ?? 'this provider'} in /accounts first.`);
      if (provider !== 'codex') return account.key;
      if (account.expires - Date.now() > 60_000) return account.access;
      if (!account.refresh) throw new Error('Reconnect ChatGPT in /accounts.');
      refreshing ??= (async () => {
        const tokens = await tokenRequest(fetcher, { grant_type: 'refresh_token', client_id: account.client, refresh_token: account.refresh });
        if (tokens.scope && !tokens.scope.split(/\s+/).includes(planScope)) throw new Error('ChatGPT plan permission expired. Reconnect in /accounts.');
        if (account !== data.accounts.codex) throw new Error('The connected ChatGPT account changed. Retry the request.');
        Object.assign(account, { access: tokens.access_token, refresh: tokens.refresh_token ?? account.refresh, expires: Date.now() + tokens.expires_in * 1000 });
        await save();
        return account.access;
      })().finally(() => { refreshing = undefined; });
      return refreshing;
    },
  };
}
