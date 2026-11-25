import { createEffect, createSignal, For, Show } from 'solid-js';
import type { KeyEvent, TextareaRenderable } from '@opentui/core';

const aliases = { codex: 'codex', chatgpt: 'codex', claude: 'claude', gemini: 'gemini' };

type ServiceChoice = { title: string; description: string; value: string; searchText: string };

function mentions(input = '') {
  let text = input.trim();
  const providers = [];
  while (true) {
    const match = /^@([a-z][a-z0-9_-]*)(?:[\s,]+|$)/i.exec(text);
    if (!match) break;
    const provider = aliases[match[1].toLowerCase()];
    if (!provider) break;
    if (!providers.includes(provider)) providers.push(provider);
    text = text.slice(match[0].length).trimStart();
  }
  return { providers, text };
}

function modelSummary(member) {
  return `${member.modelLabel} · effort ${member.effortLabel}`;
}

function usageDetails(member) {
  const { activity, account } = member;
  const lines = [`Room: ${activity.turns} turns · ${activity.replies} non-pass replies`];
  if (activity.input !== undefined || activity.output !== undefined) {
    lines.push(`Reported tokens: ${activity.input?.toLocaleString() ?? '—'} in · ${activity.output?.toLocaleString() ?? '—'} out`);
  }
  if (!account.length) lines.push('Account limits unavailable from this CLI.');
  for (const { label, used, reset } of account) {
    const date = reset?.includes('T') ? new Date(reset) : undefined;
    const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : reset;
    lines.push(`${label}: ${used}% used${when ? ` · resets ${when}` : ''}`);
  }
  return lines;
}

export default {
  id: 'ccgpt.room',
  setup(context) {
    const { agent, model, demo, control } = context.options;
    const title = demo ? 'CCGPT Room Demo' : 'CCGPT Room';
    let opening = false;
    let changingModel;
    const [views, setViews] = createSignal({});

    async function invoke(operation, input) {
      const response = await fetch(`${control.url}/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${control.token}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(40_000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? `Room request failed (HTTP ${response.status}).`);
      return value;
    }

    function remember(sessionID, state) {
      setViews(current => ({ ...current, [sessionID]: state }));
      return state;
    }

    function activeRoom() {
      const route = context.ui.router.current();
      if (route.type !== 'session') return;
      const session = context.data.session.get(route.sessionID);
      return session?.metadata?.ccgptRoom === agent ? session : undefined;
    }

    async function apply(session, update) {
      await invoke('settings', { sessionID: session.id, ...update });
      return remember(session.id, await invoke('models', { sessionID: session.id }));
    }

    function showError(error) {
      context.ui.toast.show({ title, message: error.message, variant: 'error' });
    }

    function command(action) {
      return async input => {
        try { await action(input); }
        catch (error) { showError(error); }
      };
    }

    function completeService(_input?: string, event?: KeyEvent) {
      const editor = context.renderer.currentFocusedEditor as TextareaRenderable | undefined;
      if (!editor || !Object.hasOwn(editor, 'getClipboardText')) return false;
      const mode = context.keymap.mode.current();
      if (mode !== 'base' && mode !== 'autocomplete') return false;

      const offset = editor.cursorOffset;
      const before = editor.getTextRange(0, offset);
      const head = /^\/(room(?:-new)?|include)[ \t]+/i.exec(before);
      if (!head || !/[ \t,]$/.test(before)) return false;

      event?.preventDefault();
      event?.stopPropagation();
      if (mode === 'autocomplete') context.keymap.dispatch('prompt.autocomplete.hide');
      void chooseService(editor, offset, head[1].toLowerCase(), before.slice(head[0].length)).catch(showError);
    }

    async function chooseService(editor: TextareaRenderable, offset: number, slash: string, argument: string) {
      const including = slash === 'include';
      const session = including ? activeRoom() : undefined;
      if (including && !session) {
        context.ui.toast.show({ title, message: 'Open a CCGPT room first.', variant: 'warning' });
        return;
      }
      const draft = editor.plainText;
      const directory = session?.location?.directory ?? context.data.location.default().directory;
      const [options, setOptions] = createSignal<ServiceChoice[]>([]);
      let open = true;

      const choice = context.ui.dialog.select({
        title: including ? 'Include a signed-in CLI' : 'Select a signed-in CLI',
        placeholder: 'Filter services',
        options: [],
        search(query) {
          const filter = query.trim().replace(/^@/, '').toLowerCase();
          return options().filter(option => option.searchText.includes(filter));
        },
      });
      void Promise.all([
        invoke('providers', { directory }),
        session ? invoke('state', { sessionID: session.id }) : undefined,
      ]).then(([services, state]) => {
        if (!open) return;
        const selected = state ? state.members.map(member => member.provider) : mentions(argument).providers;
        const choices = services.filter(service => !selected.includes(service.provider)).map(service => ({
          title: `@${service.provider}`,
          description: service.label,
          value: service.provider,
          searchText: `${service.provider} ${service.label}`.toLowerCase(),
        }));
        setOptions(choices);
        if (!choices.length) {
          context.ui.toast.show({
            title,
            message: 'No additional signed-in CLI services are available.',
            variant: 'info',
          });
        }
      }).catch(error => { if (open) showError(error); });

      const provider = await choice;
      open = false;
      if (!provider || editor.isDestroyed || editor.plainText !== draft) return;
      editor.cursorOffset = offset;
      const next = editor.getTextRange(offset, offset + 1);
      const hasSpace = next === ' ';
      editor.insertText(`@${provider}${hasSpace ? '' : ' '}`);
      if (hasSpace) editor.moveCursorRight();
    }

    function completeProviderCommand(_input?: string, event?: KeyEvent) {
      const session = activeRoom();
      const editor = context.renderer.currentFocusedEditor as TextareaRenderable | undefined;
      if (!session || !editor || !Object.hasOwn(editor, 'getClipboardText')) return false;
      const mode = context.keymap.mode.current();
      if (mode !== 'base' && mode !== 'autocomplete') return false;
      const offset = editor.cursorOffset;
      const before = editor.getTextRange(0, offset);
      const match = /^@(claude|codex|chatgpt)[ \t]+$/i.exec(before);
      if (!match || editor.plainText !== before) return false;

      event?.preventDefault();
      event?.stopPropagation();
      if (mode === 'autocomplete') context.keymap.dispatch('prompt.autocomplete.hide');
      editor.insertText('/');
      void chooseProviderCommand(session, editor, editor.cursorOffset, match[1].toLowerCase()).catch(showError);
    }

    async function chooseProviderCommand(session, editor: TextareaRenderable, offset: number, target: string) {
      const draft = editor.plainText;
      const [options, setOptions] = createSignal<ServiceChoice[]>([]);
      let open = true;
      let providerLabel = `@${target}`;
      const choice = context.ui.dialog.select({
        title: `@${target} commands`,
        placeholder: 'Filter commands',
        options: [],
        search(query) {
          const filter = query.trim().replace(/^\//, '').toLowerCase();
          const rank = (option: ServiceChoice) => option.value === filter ? 0 : option.value.startsWith(filter) ? 1 : 2;
          return options().filter(option => option.searchText.includes(filter)).sort((left, right) => rank(left) - rank(right));
        },
      });
      const loaded = invoke('commands', { sessionID: session.id, target }).then(result => {
        providerLabel = result.label;
        if (open) setOptions(result.commands.map(({ name, description, available, argumentHint }) => ({
          title: `/${name}${argumentHint ? ` ${argumentHint}` : ''}`,
          description: available ? description : ['Native CLI', description].filter(Boolean).join(' · '),
          value: name,
          searchText: `${name} ${description}`.toLowerCase(),
        })));
        return result.commands;
      }).catch(error => { if (open) showError(error); return []; });
      const selected = await choice;
      open = false;
      if (!selected || editor.isDestroyed || editor.plainText !== draft || activeRoom()?.id !== session.id) return;
      const entry = (await loaded).find(item => item.name === selected);
      if (!entry) return;
      if (!entry.available) {
        context.ui.toast.show({ title, message: `Use /${selected} in the ${providerLabel} terminal.`, variant: 'info' });
        return;
      }
      editor.cursorOffset = offset;
      editor.insertText(`${entry.name}${entry.argumentHint ? ' ' : ''}`);
    }

    async function openRoom(input, fresh = false) {
      if (opening) return;
      opening = true;
      try {
        const selection = mentions(input);
        const location = context.data.location.default();
        let session = !fresh && !selection.providers.length ? activeRoom() : undefined;
        if (!session && !fresh && !selection.providers.length) {
          const { data } = await context.client.session.list({ directory: location.directory, archived: false, limit: 100 });
          session = data.find(entry => entry.metadata?.ccgptRoom === agent);
        }
        if (!session) {
          if (selection.providers.length) {
            const signedIn = await invoke('providers', { directory: location.directory });
            const missing = selection.providers.find(provider => !signedIn.some(service => service.provider === provider));
            if (missing) throw new Error(`Sign in to @${missing} in its CLI first.`);
          }
          session = await context.client.session.create({ location, title, agent, model, metadata: { ccgptRoom: agent } });
          const state = await invoke('settings', {
            sessionID: session.id,
            directory: session.location?.directory ?? location.directory,
            ...(selection.providers.length ? { roster: selection.providers } : {}),
          });
          remember(session.id, state);
        }
        await context.data.session.sync(session.id);
        if (!context.ui.tabs.focus(session.id)) context.ui.router.navigate({ type: 'session', sessionID: session.id });
        if (selection.text) await context.client.session.prompt({ sessionID: session.id, text: selection.text, delivery: 'queue' });
      } finally {
        opening = false;
      }
    }

    async function include(input) {
      const session = activeRoom();
      const state = await invoke('state', { sessionID: session.id });
      const selection = mentions(input);
      let provider;
      if (input?.trim()) {
        if (selection.providers.length !== 1 || selection.text) throw new Error('Usage: /include @codex, @claude, or @gemini');
        [provider] = selection.providers;
      } else {
        const directory = session.location?.directory ?? context.data.location.default().directory;
        const available = await invoke('providers', { directory });
        const choices = available.filter(service => !state.members.some(member => member.provider === service.provider));
        if (!choices.length) {
          await context.ui.dialog.alert({ title: 'Include a service', message: 'No additional signed-in services are available.' });
          return;
        }
        provider = await context.ui.dialog.select({
          title: 'Include a service',
          options: choices.map(service => ({ title: service.label, description: `@${service.provider}`, value: service.provider })),
        });
      }
      if (!provider) return;
      await apply(session, { include: provider });
      context.ui.toast.show({ title, message: `@${provider} is in the room.`, variant: 'success' });
    }

    async function permissions() {
      const session = activeRoom();
      const state = await invoke('state', { sessionID: session.id });
      const choice = await context.ui.dialog.select({
        title: 'Room permissions',
        current: state.writeEnabled ? 'write' : 'read',
        options: [
          { title: 'Read-only', description: 'Let room agents inspect the workspace', value: 'read' },
          { title: 'Workspace edits', description: 'Let all room agents edit workspace files', value: 'write' },
        ],
      });
      if (choice === undefined) return;
      const writeEnabled = choice === 'write';
      if (writeEnabled && !state.writeEnabled && !(await context.ui.dialog.confirm({
        title: 'Enable workspace edits?',
        message: 'Every service in this room can edit files in the workspace.',
        label: { confirm: 'Enable workspace edits' },
      }))) return;
      await apply(session, { writeEnabled });
    }

    async function selectModel(session, member) {
      if (!member.models.length) {
        await context.ui.dialog.alert({ title: member.label, message: 'The CLI did not report a model catalog. Verify that you are signed in.' });
        return;
      }
      const choices = member.models.filter(item => item.id !== 'default');
      const defaultModel = member.models.find(item => item.default);
      const selected = await context.ui.dialog.select({
        title: `${member.label} model`,
        current: member.model ?? '',
        options: [
          { title: 'CLI default', description: defaultModel?.actual ?? defaultModel?.label, value: '' },
          ...choices.map(item => ({ title: item.label ?? item.id, description: item.actual ?? item.id, value: item.id })),
        ],
      });
      if (selected === undefined) return;
      const selectedModel = selected ? choices.find(item => item.id === selected) : defaultModel;
      let effort = '';
      if (selectedModel?.efforts.length) {
        effort = await context.ui.dialog.select({
          title: `${member.label} effort`,
          current: selected === (member.model ?? '') ? member.effort ?? '' : '',
          options: [
            { title: 'CLI default', description: selectedModel.defaultEffort, value: '' },
            ...selectedModel.efforts.map(value => ({ title: value, value })),
          ],
        });
        if (effort === undefined) return;
      }
      await apply(session, { modelSettings: { provider: member.provider, model: selected || null, effort: effort || null } });
    }

    async function showCards(kind) {
      const session = activeRoom();
      const editable = kind === 'models';
      const state = await invoke(kind, { sessionID: session.id });
      if (editable) remember(session.id, state);
      context.ui.dialog.show(() => {
        const [active, setActive] = createSignal(0);
        const theme = context.theme;
        const choose = command(async () => {
          const member = state.members[active()];
          if (!member) return;
          context.ui.dialog.clear();
          await selectModel(session, member);
        });
        if (editable) context.keymap.layer(() => ({
          mode: 'modal', priority: 100,
          commands: [
            { bind: 'up', title: 'Previous service', run: () => { setActive(value => Math.max(0, value - 1)); } },
            { bind: 'down', title: 'Next service', run: () => { setActive(value => Math.min(state.members.length - 1, value + 1)); } },
            { bind: 'return', title: 'Change service model', run: () => choose() },
          ],
        }));
        return <box padding={1} flexDirection="column" gap={1}>
          <text fg={theme.text.base}>{editable ? 'Room models' : 'Room usage'}</text>
          <scrollbox maxHeight={Math.max(8, context.renderer.height - 9)}>
            <For each={state.members}>{(member, index) =>
              <box border borderStyle="rounded" paddingX={1} flexDirection="column"
                borderColor={editable && index() === active() ? theme.text.base : theme.text.muted}>
                <text fg={theme.text.base}>{member.label}</text>
                <For each={editable ? [modelSummary(member)] : usageDetails(member)}>
                  {line => <text fg={theme.text.muted}>{line}</text>}
                </For>
              </box>}
            </For>
          </scrollbox>
          <text fg={theme.text.muted}>{editable ? '↑↓ Select service · Enter Change model · Esc Close' : 'Esc Close'}</text>
        </box>;
      });
      context.ui.dialog.set({ size: 'large', centered: true });
    }

    context.ui.slot({
      append: 'session.composer.top',
      render(input) {
        const state = () => views()[input.sessionID];
        return <Show when={state()}>
          <box flexDirection="column" paddingX={1}>
            <For each={state()?.members}>{member =>
              <text fg={context.theme.text.base}>{`${member.label} · ${modelSummary(member)}`}</text>}
            </For>
            <text fg={context.theme.text.muted}>{state()?.writeEnabled ? 'Room access: Workspace edits' : 'Room access: Read-only'}</text>
          </box>
        </Show>;
      },
    });

    context.ui.slot({
      append: 'app',
      render() {
        createEffect(() => {
          const session = activeRoom();
          if (!session) return;
          if (session.model?.providerID !== model.providerID && changingModel !== session.id) {
            changingModel = session.id;
            void context.client.session.switchModel({ sessionID: session.id, model }).catch(showError)
              .finally(() => { if (changingModel === session.id) changingModel = undefined; });
          }
          if (context.data.session.status(session.id) === 'idle') {
            void invoke('models', { sessionID: session.id }).then(state => remember(session.id, state)).catch(showError);
          }
        });
        context.keymap.layer(() => ({
          mode: 'global',
          priority: 100,
          commands: [
            { id: 'ccgpt.room.completeService', bind: '@', run: completeService },
            { id: 'ccgpt.room.completeProviderCommand', bind: '/', run: completeProviderCommand },
            ...[
              { id: 'ccgpt.room.open', title: 'Open CCGPT Room', slash: { name: 'room', arguments: true },
                run: command(openRoom) },
              { id: 'ccgpt.room.new', title: 'New CCGPT Room', slash: { name: 'room-new', arguments: true },
                run: command(input => openRoom(input, true)) },
              { id: 'ccgpt.room.include', title: 'Include a room service', slash: { name: 'include', arguments: true },
                enabled: () => !!activeRoom(), run: command(include) },
              { id: 'ccgpt.room.permissions', title: 'Change room permissions', slash: { name: 'permissions' },
                enabled: () => !!activeRoom(), run: command(permissions) },
            ].map(item => ({ group: 'CCGPT', palette: true, ...item })),
          ],
        }));
        context.keymap.layer(() => ({
          mode: 'global',
          priority: 200,
          commands: activeRoom() ? [
            { id: 'model.list', title: 'View room models', group: 'CCGPT', palette: true,
              slash: { name: 'model', aliases: ['models'] }, run: command(() => showCards('models')) },
            { id: 'usage.show', title: 'View room usage', group: 'CCGPT', palette: true,
              slash: { name: 'usage' }, run: command(() => showCards('usage')) },
          ] : [],
        }));
        return null;
      },
    });
  },
};
