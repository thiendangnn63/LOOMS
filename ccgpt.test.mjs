import assert from 'node:assert/strict';
import test from 'node:test';
import { launchOptions } from './ccgpt.mjs';

test('a tmux launch uses the private V2 service and preserves other MCP servers', () => {
  const args = [];
  const env = {
    TMUX: '/tmp/tmux/socket,100,0',
    TMUX_PANE: '%2',
    OPENCODE_CONFIG_CONTENT: '{"mcp":{"servers":{"other":{"type":"local","command":["example"]}}}}',
  };
  const options = launchOptions(args, env, () => '/bridge/cli.js');
  assert.deepEqual(options.args, ['--standalone']);
  assert.equal(options.env.TMUX_PANE, '%2');
  const servers = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).mcp.servers;
  assert.deepEqual(servers.other.command, ['example']);
  assert.deepEqual(servers['tmux-bridge'].command, [process.execPath, '/bridge/cli.js']);
  assert.deepEqual(args, []);
});

test('MCP listing waits for service readiness while serve keeps its native flags', () => {
  const env = { TMUX: 'socket' };
  const bridge = () => '/bridge/cli.js';
  const listing = launchOptions(['mcp', 'list'], env, bridge);
  assert.deepEqual(listing.args, ['mcp', 'list']);
  assert.equal(listing.waitForBridge, true);
  const service = launchOptions(['serve', '--port', '0'], env, bridge);
  assert.deepEqual(service.args, ['serve', '--port', '0']);
  assert.match(service.env.OPENCODE_CONFIG_CONTENT, /tmux-bridge/);
});

test('bridge lookup is skipped outside tmux, when attaching, and for an existing bridge', () => {
  const noLookup = () => assert.fail('Unexpected bridge lookup');
  const args = ['--server=http://localhost:1234'];
  const env = { TMUX: 'socket' };
  assert.deepEqual(launchOptions(args, env, noLookup), { args, env });
  assert.deepEqual(launchOptions([], {}, noLookup), { args: [], env: {} });

  const configured = { ...env, OPENCODE_CONFIG_CONTENT: '{"mcp":{"servers":{"tmux-bridge":{"disabled":true}}}}' };
  assert.deepEqual(launchOptions(['--standalone'], configured, noLookup), {
    args: ['--standalone'],
    env: configured,
  });
});
