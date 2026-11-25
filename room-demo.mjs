export function createDemoAdapters() {
  return {
    async accountUsage(provider) { return [{ label: 'Example allowance', used: provider === 'claude' ? 35 : 20 }]; },
    async ask(name, member, prompt, _showReply, context) {
      if (context?.providerCommand) return `Demo ${name} ${prompt}`;
      prompt = context?.originalPrompt ?? prompt;
      if (prompt.startsWith('Divide this task')) {
        return JSON.stringify({ assignments: [{ agent: name, task: 'Summarize the requested task' }] });
      }
      if (prompt.startsWith('Job ') && prompt.includes('\nYour assignment:')) {
        const task = prompt.slice(prompt.indexOf('User task: ') + 'User task: '.length, prompt.indexOf('\nYour assignment:'));
        return JSON.stringify({ action: 'done', text: `Demo job result: ${task}` });
      }
      const user = prompt.lastIndexOf('[user] ');
      if (user === -1) return 'PASS';
      const turn = prompt.slice(user).split('\n\nReply to the conversation briefly.')[0];
      const peer = turn.match(/\n\n\[([a-z][a-z0-9_-]*)\] ([\s\S]+)/i);
      if (peer) {
        const [, speaker, reply] = peer;
        const label = speaker === 'codex' ? 'Codex' : speaker === 'claude' ? 'Claude' : `@${speaker}`;
        return `I saw ${label}’s reply: ${reply}`;
      }
      return `I received your message: ${turn.slice('[user] '.length)}`;
    },
  };
}
