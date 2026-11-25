#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const roomPlugin = new URL('./opencode-room-plugin', import.meta.url).href;

function packageCommand(name, command) {
  const manifestPath = require.resolve(`${name}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return resolve(dirname(manifestPath), bin[command]);
}

export function launchOptions(args, env, resolveBridge) {
  const separator = args.indexOf('--');
  const flags = separator === -1 ? args : args.slice(0, separator);
  const attach = flags.some(arg => arg === '--server' || arg.startsWith('--server='));
  const standalone = flags.includes('--standalone');
  const options = { args: [...args], env: { ...env } };
  if (attach || !env.TMUX) return options;

  const command = flags.filter(arg => !arg.startsWith('-')).slice(0, 2).join(' ');
  const maintenance = /^(?:serve|service|upgrade|update|uninstall|acp)(?: |$)/.test(command) ||
    /^(?:mcp add|debug paths|debug heap-dump|plugin (?:add|check|update|remove))$/.test(command);
  if (maintenance && !command.startsWith('serve')) return options;
  const listing = command === 'mcp list' && !flags.some(arg => ['--version', '-v', '--help', '-h'].includes(arg));
  if (!standalone && !maintenance && !listing) options.args.unshift('--standalone');
  if (listing) options.waitForBridge = true;

  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object');
  }
  const servers = config.mcp?.servers;
  if (!Object.hasOwn(servers ?? {}, 'tmux-bridge')) {
    config.mcp = {
      ...config.mcp,
      servers: {
        ...servers,
        'tmux-bridge': { type: 'local', command: [process.execPath, resolveBridge()] },
      },
    };
  }
  options.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return options;
}

function startOpenCode(launcher, args, env, stdio = 'inherit') {
  const isScript = /\.[cm]?js$/.test(launcher);
  return spawn(isScript ? process.execPath : launcher,
    isScript ? [launcher, ...args] : args, { env, stdio });
}

async function listBridge(launcher, options) {
  const password = randomBytes(32).toString('base64url');
  const env = { ...options.env, OPENCODE_PASSWORD: password };
  const service = startOpenCode(launcher, ['serve', '--stdio', '--port', '0'], env, ['pipe', 'pipe', 'inherit']);
  service.stdin.on('error', () => {});
  const lines = createInterface({ input: service.stdout });
  try {
    const deadline = AbortSignal.timeout(15_000);
    const [line] = await Promise.race([
      once(lines, 'line', { signal: deadline }),
      once(service, 'exit').then(() => { throw new Error('OpenCode exited before its private service was ready'); }),
    ]);
    const { url } = JSON.parse(line);
    const endpoint = new URL('/api/mcp', url);
    endpoint.searchParams.set('location[directory]', process.cwd());
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    try {
      // The API can return an empty list while the location's MCP plugin is loading.
      while (true) {
        const response = await fetch(endpoint, { headers, signal: deadline });
        if (!response.ok) throw new Error(`OpenCode MCP status returned HTTP ${response.status}`);
        const { data } = await response.json();
        if (data.some(server => server.name === 'tmux-bridge' && server.status.status !== 'pending')) break;
        await delay(150, undefined, { signal: deadline });
      }
    } catch (error) {
      if (!deadline.aborted) throw error;
      console.error('ccgpt: timed out waiting for tmux-bridge status');
    }
    const args = options.args.filter(arg => arg !== '--standalone');
    const child = startOpenCode(launcher, ['--server', url, ...args], env);
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
  } finally {
    lines.close();
    service.stdin.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--ccgpt-help') {
    console.log('Usage: ccgpt [OpenCode arguments]\n' +
      'Inside tmux, CCGPT starts a private OpenCode service with the tmux bridge.\n' +
      'Use /room in OpenCode, or ccgpt --room-demo to try it with simulated replies.\n' +
      'Use ccgpt --room [--demo] for the line-oriented CCGPT chatroom.');
    return;
  }
  if (args[0] === '--room') return import('./agent-terminal.mjs').then(module => module.runAgentTerminal(args.slice(1)));
  const demo = args[0] === '--room-demo';
  if (demo) args.shift();
  const options = launchOptions(args, process.env, () => packageCommand('tmux-bridge-mcp', 'tmux-bridge-mcp'));
  const launcher = packageCommand('@opencode/cli', 'opencode');
  if (options.waitForBridge) return listBridge(launcher, options);
  const [command] = args;
  const cliCommands = new Set(['upgrade', 'update', 'uninstall', 'acp', 'api', 'debug', 'auth', 'login', 'mcp',
    'plugin', 'models', 'stats', 'mini', 'run', 'session', 'service', 'reload', 'machine', 'serve']);
  const externalServer = args.some(arg => arg === '--server' || arg.startsWith('--server='));
  const help = args.some(arg => ['--help', '-h', '--version', '-v', '--completions'].includes(arg));
  let room;
  if (!externalServer && !help && !cliCommands.has(command)) {
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT || '{}');
    const cliConfig = JSON.parse(options.env.OPENCODE_CLI_CONFIG_CONTENT || '{}');
    const cwd = command && !command.startsWith('-') ? realpathSync(resolve(command)) : process.cwd();
    const { startRoomModel } = await import('./room-model.mjs');
    room = await startRoomModel({ cwd, demo });
    if (!options.args.includes('--standalone')) options.args.unshift('--standalone');
    options.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...config,
      providers: { ...config.providers, ...room.config.providers },
      agents: { ...config.agents, ...room.config.agents },
    });
    options.env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({
      ...cliConfig,
      plugins: [...(cliConfig.plugins ?? []), {
        package: roomPlugin, options: { demo, agent: room.agent, model: room.model, control: room.control },
      }],
    });
  }
  const child = startOpenCode(launcher, options.args, options.env);
  const forwardTerminate = () => child.kill('SIGTERM');
  process.once('SIGTERM', forwardTerminate);
  child.once('error', error => {
    console.error(`ccgpt: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
  child.once('close', () => {
    process.removeListener('SIGTERM', forwardTerminate);
    room?.close();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`ccgpt: ${error.message}`);
    process.exitCode = 1;
  }
}
