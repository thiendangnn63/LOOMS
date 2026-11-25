export const roomServices = {
  codex: {
    label: 'ChatGPT · Codex', accountLabel: 'ChatGPT', aliases: ['chatgpt', 'openai'], defaultRoom: true,
    auth: 'browser', connect: 'connectChatGPT', usage: { label: 'ChatGPT usage settings', url: 'https://chatgpt.com/settings/usage' },
    demoModel: { label: 'Demo Codex', efforts: ['low', 'medium', 'high'] },
  },
  claude: {
    label: 'Claude Code', accountLabel: 'Claude', defaultRoom: true, auth: 'terminal', connect: 'connectClaude',
    consent: 'Allow LOOMS to send room context to Claude Code using your subscription?',
    signIn: 'Complete sign-in through Claude Code in your browser.',
    connected: 'Claude Code connected with your Claude subscription.',
    demoModel: { label: 'Demo Claude', efforts: ['low', 'medium', 'high'] },
  },
  gemini: {
    label: 'Gemini CLI', accountLabel: 'Gemini', auth: 'key', keyTitle: 'Gemini API key from Google AI Studio',
    keyCheck: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', header: 'x-goog-api-key' },
  },
};
export const providers = Object.keys(roomServices);
export const defaultProviders = providers.filter(provider => roomServices[provider].defaultRoom);
export const providerLabels = Object.fromEntries(providers.map(provider => [provider, roomServices[provider].label]));
export const accountLabels = Object.fromEntries(providers.map(provider => [provider, roomServices[provider].accountLabel]));
const aliases = new Map(providers.flatMap(provider => (roomServices[provider].aliases ?? []).map(alias => [alias, provider])));
export const resolveProvider = name => aliases.get(name) ?? name;
export const roomAccessLabel = (writeEnabled, askBeforeChanges) => askBeforeChanges ? 'Ask before changes' : writeEnabled ? 'Workspace edits' : 'Read-only';

export function parseClaudeUsage(result) {
  return [...(result ?? '').matchAll(/^([^:\r\n]+):\s+(\d+(?:\.\d+)?)% used(?:\s+·\s+resets ([^\r\n]+))?\s*$/gm)]
    .map(([, label, used, reset]) => ({ label, used: Number(used), reset }));
}
