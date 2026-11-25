import { runAgentTerminal } from './agent-terminal.mjs';

await runAgentTerminal(['--chat-json', '--demo', ...process.argv.slice(2)]);
