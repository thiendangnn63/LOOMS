import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRoomHost } from './room-host.mjs';
import { createProviderAdapters, defaultProviders } from './room-providers.mjs';
import { createDemoAdapters } from './room-demo.mjs';
import { configuredRoomSummarizer } from './room-summary.mjs';

const help = [
  '<message>          Send a message to the room',
  '@<name> <message>  Give a model first turn',
  '@claude / or @codex /  List that member’s provider commands',
  '/chat <message>    Send a message to the room',
  '/models            List models in this room',
  '/add <name> <codex|claude> [model]  Add a model or provider default',
  '/model <name> <model|default> [effort|default]  Switch a room member’s model',
  '/effort <name> <level|default>  Change only its reasoning effort',
  '/remove <name>     Remove a model from the room',
  '/job <task>        Give the room a task to delegate',
  '/job --plan <goal> or /job --planner @agent <goal>  Draft a structured job plan',
  '/approve, /edit <json-patch>, /cancel, /status  Manage the current plan',
  '/auto-approve <on|off>  Set automatic approval for structured plans',
  '/budget <tokens>  Set the current structured job token budget',
  '/jobs              Show job and step status',
  '/retry <job-id>    Resume an incomplete job',
  '/review <task>     Codex proposes, Claude reviews, Codex revises',
  '/summary           Show the current room summary',
  '/log [count]       Show recent raw room messages',
  '/decide <text>     Record a room decision',
  '/contract approve <message-id>  Approve a proposed contract change',
  '/send <agent> <message>  Send to a single agent',
  '/new               Start fresh agent conversations',
  '/quit              Exit',
].join('\n');

export async function runAgentTerminal(cliArgs) {
  const writeEnabled = cliArgs.includes('--write');
  const jsonMode = cliArgs.includes('--chat-json');
  const demo = cliArgs.includes('--demo');
  if (cliArgs.includes('--help')) {
    console.log('Usage: node agent-terminal.mjs [--write] [--chat-json] [--demo] [project-directory]\n' +
      '       node agent-terminal.mjs <login|status> <codex|claude>\n\n' +
      '--write enables file edits for both agents in this project session.\n' +
      '--chat-json uses a JSON-lines interface.\n' +
      '--demo runs deterministic simulated models.\n\n' + help);
    return;
  }

  const [mode, provider] = cliArgs.filter(argument => !['--write', '--chat-json', '--demo'].includes(argument));
  const authMode = mode === 'login' || mode === 'status';
  const cwd = resolve(authMode ? process.cwd() : mode ?? process.cwd());
  let activeLabel;
  function display(label, chunk) {
    const clean = chunk.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!clean) return;
    const out = jsonMode ? process.stderr : process.stdout;
    if (activeLabel !== label) out.write(`\n[${label}] `);
    activeLabel = label;
    out.write(clean);
  }

  if (authMode) {
    if (!defaultProviders.includes(provider) || cliArgs.length !== 2) {
      console.error('Usage: node agent-terminal.mjs <login|status> <codex|claude>');
      process.exitCode = 1;
      return;
    }
    const args = provider === 'claude'
      ? ['auth', mode]
      : mode === 'login' ? ['login'] : ['login', 'status'];
    const child = createProviderAdapters({ cwd, writeEnabled, display }).launch(provider, args, true);
    child.once('error', error => console.error(error.message));
    child.once('close', code => { process.exitCode = code ?? 1; });
    return;
  }

  const emitJSON = event => process.stdout.write(`${JSON.stringify(event)}\n`);
  const host = createRoomHost({
    cwd,
    roomID: randomUUID(),
    liveTasks: !demo,
    summarize: demo ? undefined : configuredRoomSummarizer(cwd, process.env.CCGPT_ROOM_SUMMARIZER, createProviderAdapters),
    writeEnabled: writeEnabled && !demo,
    adapters: demo ? createDemoAdapters() : createProviderAdapters({ cwd, writeEnabled, display }),
    emit(event) {
      if (event.type === 'message') {
        if (jsonMode) emitJSON(event.entry);
        else if (event.entry.speaker !== 'user') {
          activeLabel = undefined;
          display(event.entry.speaker, `${event.entry.text}\n`);
        }
      } else if (jsonMode) {
        emitJSON({ speaker: 'system', text: event.text });
      } else if (event.error) {
        console.error(`\n${event.text}`);
      } else if (event.label === 'system') {
        console.log(event.text);
      } else {
        display(event.label, `${event.text}\n`);
      }
    },
  });

  const terminal = createInterface(jsonMode ? { input: process.stdin } : {
    input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY,
  });
  function stop() {
    terminal.close();
    host.close();
  }

  terminal.on('SIGINT', stop);
  process.on('SIGINT', stop);
  try {
    if (jsonMode) {
      emitJSON({ ready: true, models: host.roster().map(member => member.name) });
      for await (const line of terminal) {
        if (!line.trim()) continue;
        try {
          const { text } = JSON.parse(line);
          if (typeof text !== 'string' || !text.trim()) throw new Error('Expected {"text":"<message>"}.');
          await host.send(text.trim());
        } catch (error) {
          emitJSON({ speaker: 'system', text: error.message });
        }
        emitJSON({ done: true });
      }
      return;
    }

    console.log(`Agent Terminal · ${host.cwd} · ${demo ? 'Demo' : host.writeEnabled ? 'Edits enabled' : 'Read-only'}\n${help}\n`);
    terminal.setPrompt('> ');
    terminal.prompt();
    for await (const line of terminal) {
      const input = line.trim();
      if (input === '/quit') break;
      if (input) {
        try {
          if (input === '/help') console.log(help);
          else await host.command(input);
        } catch (error) {
          console.error(`\n${error.message}`);
          if (!process.stdin.isTTY) process.exitCode = 1;
        }
        process.stdout.write('\n');
        activeLabel = undefined;
      }
      terminal.prompt();
    }
  } finally {
    process.removeListener('SIGINT', stop);
    stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await runAgentTerminal(process.argv.slice(2));
}
