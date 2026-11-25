import { resolveProvider, roomServices } from './room-services.mjs';

const commandName = /^[a-z0-9][a-z0-9_:-]{0,95}$/i;

// The App Server has typed operations rather than the Codex TUI's slash dispatcher.
// Keep the published terminal commands discoverable and explicitly map room operations.
const codexTerminal = `agents app apps approve archive btw cd clean clear cloud cloud-environment compact config copy cwd
  daybreak debug-config diff exit experimental export fast feedback fork goal hooks ide ide-context import init keymap
  local logout mcp memories mention model new permissions pet pets plan plugins presets project ps pwd quit raw recap
  reasoning remote rename resume review rollout setup-default-sandbox side skills status statusline stop subagents theme
  title tui vim voice warnings worktree`.trim().split(/\s+/);

const claudeTerminal = `add-dir advisor agents allowed-tools android app artifact-capabilities artifact-diagramming artifacts
  auto-mode-setup autocompact autofix-pr background batch bashes bg branch btw bug cd checkpoint checkup chrome claude-api
  claude-in-chrome clear code-review color compact config context continue copy cost dataviz debug deep-research design
  desktop diff doctor effort exit export fast feedback fewer-permission-prompts focus fork goal help hooks ide import
  init insights install-github-app install-slack-app ios keybindings list-agents login logout loop mcp memory mobile
  model new output-style passes peers permissions plan plugin plugin-authoring powerup privacy-settings proactive quit
  radio rate-limit-options rc recap release-notes reload-plugins reload-skills remote-control remote-env rename reset
  restart resume review rewind routines run run-skill-generator sandbox schedule scroll-speed security-review settings
  share ship ship:review ship:steward simplify skill-doctor skills stats status statusline steward stickers stop subtask
  tasks team-onboarding teleport terminal-setup theme tp tui ultrareview undo update update-config upgrade usage
  usage-credits verify voice web-setup whiteboard`.trim().split(/\s+/);

const common = {
  help: ['List slash commands for this service.'],
  status: ['Show this service’s model, effort, and room access.'],
  model: ['Show or change this member’s model.', '[model]'],
  usage: ['Show this service’s account limits in the room.'],
  new: ['Start a fresh provider session with shared room context.'],
  clear: ['Start a fresh provider session with shared room context.', '', 'new'],
};

const supported = {
  codex: {
    ...common,
    pwd: ['Show the room workspace.'],
    cwd: ['Show the room workspace.', '', 'pwd'],
    reasoning: ['Show or set this member’s reasoning effort.', '[level]', 'effort'],
    compact: ['Compact the current Codex thread.'],
    review: ['Review uncommitted changes or follow review instructions.', '[instructions]'],
    mcp: ['List MCP servers on the current Codex thread.'],
  },
  claude: {
    ...common,
    effort: ['Show or set this member’s effort.', '[level]'],
    cost: ['Show Claude usage.', '', 'usage'],
    stats: ['Show Claude usage.', '', 'usage'],
    reset: ['Start a fresh provider session with shared room context.', '', 'new'],
    compact: ['Compact the current Claude conversation.', '[focus]'],
    context: ['Show context usage for this Claude conversation.', '[all]'],
    mcp: ['List MCP servers on the current Claude conversation.'],
  },
};

function visibleText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) : '';
}

export function providerCommandCatalog(provider, discovered = []) {
  if (!Object.hasOwn(roomServices, provider)) return [];
  const catalog = new Map(Object.entries(supported[provider] ?? common).map(([name, [description, argumentHint = '', action = name]]) =>
    [name, { name, description, argumentHint, action, available: true }]));
  for (const command of discovered) {
    const value = typeof command === 'string' ? { name: command } : command;
    if (typeof value?.name !== 'string') continue;
    const primary = value.name.replace(/^\//, '').toLowerCase();
    for (const alias of [primary, ...(Array.isArray(value.aliases) ? value.aliases : [])]) {
      if (typeof alias !== 'string') continue;
      const name = alias.replace(/^\//, '').toLowerCase();
      if (!commandName.test(name) || catalog.has(name)) continue;
      catalog.set(name, { name, description: visibleText(value.description, 240), argumentHint: visibleText(value.argumentHint, 80), available: false });
    }
  }
  for (const name of ({ codex: codexTerminal, claude: claudeTerminal })[provider] ?? []) {
    if (!catalog.has(name)) catalog.set(name, { name, description: '', argumentHint: '', available: false });
  }
  return [...catalog.values()].sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

export function parseProviderCommand(text) {
  const match = /^\s*@([a-z][a-z0-9_-]*)[ \t]+\/([a-z0-9_:-]*)(?:[ \t]+([\s\S]*))?\s*$/i.exec(text);
  if (!match || (match[2] && !commandName.test(match[2]))) return;
  const [ , alias, command, args = ''] = match;
  return { target: resolveProvider(alias.toLowerCase()), command: command.toLowerCase() || 'help', args: args.trim() };
}
