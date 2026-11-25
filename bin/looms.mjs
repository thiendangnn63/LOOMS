#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runTerminal } from '../src/terminal/looms-terminal.mjs';

const args = process.argv.slice(2);
try {
  if (args.some(arg => ['--help', '-h', '--ccgpt-help'].includes(arg))) {
    console.log('LOOMS · LLM ROOMS\n\nUsage: looms [--demo] [workspace]\n' +
      'Choose a saved room or start a new one. Use /accounts to connect providers.\n' +
      'Use Tab and Shift+Tab to switch between response tabs.');
  } else if (args.includes('--version') || args.includes('-v')) {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else {
    const flags = ['--demo', '--room-demo', '--room'];
    const paths = args.filter(arg => !flags.includes(arg));
    if (paths.length > 1 || paths[0]?.startsWith('-')) throw new Error('Usage: looms [--demo] [workspace]');
    await runTerminal({ cwd: resolve(paths[0] ?? process.cwd()), demo: args.includes('--demo') || args.includes('--room-demo') });
  }
} catch (error) {
  console.error(`LOOMS: ${error.message}`);
  process.exitCode = 1;
}
