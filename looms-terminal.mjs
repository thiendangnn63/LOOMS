import { spawn } from 'node:child_process';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { accountLabels } from './looms-accounts.mjs';
import { openLooms } from './looms-app.mjs';
import { createSkillMenus } from './looms-skills-menu.mjs';
import { layoutLooms, previewControls } from './looms-view.mjs';
import { activityText, fileActivityLabel, modelChatText } from './room-activity.mjs';
import { parseProviderCommand } from './room-provider-commands.mjs';
import { resolveProvider, roomServices } from './room-services.mjs';

const mouseOn = '\x1b[?1000h\x1b[?1006h';
const mouseOff = '\x1b[?1006l\x1b[?1000l';
const scrollablePanes = ['usage', 'approval', 'preview', 'diff', 'plan'];

function terminalKeys(input, onKey, onWheel, onClick) {
  const keys = new PassThrough();
  emitKeypressEvents(keys);
  keys.on('keypress', onKey);
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let timer;

  function forward(text) { if (text) keys.write(text); }
  function receive(chunk) {
    clearTimeout(timer);
    let text = partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    partial = text.match(/\x1b(?:\[(?:<[\d;]{0,17})?)?$/)?.[0] ?? '';
    if (partial) {
      text = text.slice(0, -partial.length);
      timer = setTimeout(() => { forward(partial); partial = ''; }, 30);
    }
    let end = 0;
    for (const event of text.matchAll(/\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/g)) {
      forward(text.slice(end, event.index));
      const button = Number(event[1]) & ~28;
      if (event[4] === 'M') {
        if (button === 64 || button === 65) onWheel(button === 64 ? -3 : 3);
        if (button === 0) onClick(Number(event[2]), Number(event[3]));
      }
      end = event.index + event[0].length;
    }
    forward(text.slice(end));
  }

  return {
    resume() { input.on('data', receive); input.resume(); },
    pause() {
      input.off('data', receive);
      input.pause();
      clearTimeout(timer);
      partial = '';
    },
  };
}

const slash = [
  ['/accounts', 'Connect or disconnect providers'], ['/rooms', 'Switch rooms'], ['/room ', 'Start a room with @mentions'],
  ['/include', 'Add a connected provider'], ['/model', 'Choose a model or effort'], ['/permissions', 'Set room access'],
  ['/usage', 'Show provider usage'], ['/mcp', 'Show and manage room MCP connections'],
  ['/skills', 'Show the room’s agent skills'],
  ['/diff', 'Browse saved file diffs'],
  ['/preview ', 'Review prompts before sending a task'], ['/job --plan ', 'Draft a structured job'],
  ['/job --prefer ', 'Set preferred agents by task type'],
  ['/approve', 'Approve the current job plan'],
  ['/status', 'Show structured job progress'], ['/cancel', 'Cancel a structured job'], ['/summary', 'Show shared memory'],
  ['/log', 'Show the shared log'], ['/decide ', 'Record a decision'], ['/quit', 'Exit LOOMS'],
];

async function openBrowser(url) {
  const config = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise(resolve => {
    const child = spawn(...config, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

export async function runTerminal(options, input = process.stdin, output = process.stdout) {
  let app;
  let draft = '';
  let cursor = 0;
  let commandIndex = 0;
  let commandsHidden = false;
  const commandLists = new Map();
  const selections = new Map();
  let firstRow;
  let viewport;
  let mode;
  const approvals = [];
  const activeMode = () => approvals[0] ?? mode;
  let busy = false;
  let current = Promise.resolve();
  let notices = [];
  let browserFallback = false;
  const interactive = input.isTTY && output.isTTY && typeof input.setRawMode === 'function';
  function requestApproval(request, signal) {
    if (!interactive || signal.aborted) return false;
    return new Promise(resolve => {
      const pane = { type: 'approval', request, firstRow: 0, allow: false, settle };
      const cancel = () => settle(false);
      function settle(allowed) {
        const index = approvals.indexOf(pane);
        if (index < 0) return;
        approvals.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        resolve(allowed);
        draw();
      }
      approvals.push(pane);
      signal.addEventListener('abort', cancel, { once: true });
      draw();
    });
  }
  const notify = event => {
    if (!interactive) {
      if (event.type === 'message' && event.entry.speaker !== 'user') {
        const { speaker, text, activity } = event.entry;
        output.write([`@${speaker}`, modelChatText(text), activity && activityText(activity)].filter(Boolean).join('\n') + '\n');
      }
      if (event.type === 'status') output.write(`${event.text}\n`);
      if (event.type === 'usage') output.write(`${event.text}\n${event.link ? `${event.linkLabel}: ${event.link}\n` : ''}`);
      return;
    }
    if (event.type === 'status') {
      if (event.planText) mode = { type: 'plan', text: event.planText, firstRow: 0 };
      else notices = [...notices.slice(-3), event.text];
    }
    if (event.type === 'room') {
      notices = []; selections.clear(); firstRow = undefined;
      commandLists.clear();
      // A preview belongs to the room it was built in.
      if (mode?.type === 'preview' || mode?.type === 'plan') mode = undefined;
    }
    if (event.type === 'skills') commandLists.clear();
    if (event.type === 'usage') mode = { type: 'usage', text: event.text, title: event.title, link: event.link, linkLabel: event.linkLabel, firstRow: 0 };
    draw();
  };
  app = await openLooms({ ...options, startBlank: interactive && !options.demo, notify, requestApproval });

  if (!interactive) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const text = line.trim();
        if (text === '/quit') break;
        if (!text) continue;
        if (text === '/accounts') {
          output.write(`${app.accounts().map(({ provider, connected }) => `${accountLabels[provider]} · ${connected ? 'Connected' : 'Connect in the interactive LOOMS terminal'}`).join('\n')}\n`);
          continue;
        }
        try { await app.command(text); }
        catch (error) { output.write(`${error.message}\n`); }
      }
    } finally { await app.close(); }
    return;
  }

  const resetSuggestions = () => { commandIndex = 0; commandsHidden = false; };
  const setDraft = value => { draft = value; cursor = value.length; resetSuggestions(); };

  function commandSuggestions() {
    if (commandsHidden || cursor !== draft.length) return;
    const match = /^(?:@([a-z][\w-]*)[ \t]+)?\/([a-z0-9_:-]*)$/i.exec(draft);
    if (!match) return;
    const [, handle, query] = match;
    const prefix = draft.slice(0, draft.length - query.length);
    let title = 'Room commands';
    let choices = slash.map(([value, description]) => ({ value, label: `${value.trim()}   ${description}`, completeFirst: value.endsWith(' ') }));
    if (handle) {
      const target = resolveProvider(handle.toLowerCase());
      const member = app.roster().find(member => member.name === target);
      if (!member) return;
      title = `@${handle} commands`;
      let state = commandLists.get(target);
      if (!state) {
        state = { commands: app.localProviderCommands(target) };
        commandLists.set(target, state);
        void app.providerCommands(target).then(commands => {
          if (commandLists.get(target) !== state) return;
          state.commands = commands;
          draw();
        }).catch(() => {});
      }
      choices = state.commands.map(command => ({ value: `${prefix}${command.name}${command.argumentHint ? ' ' : ''}`,
        label: [`/${command.name}`, !command.available && 'Native CLI', command.description].filter(Boolean).join('   ') }));
    }
    const queryText = draft.toLowerCase();
    const options = choices.filter(choice => choice.value.toLowerCase().startsWith(queryText));
    const exact = options.findIndex(choice => choice.value.trimEnd().toLowerCase() === queryText);
    if (exact > 0) options.unshift(...options.splice(exact, 1));
    return options.length ? { title, options, index: Math.min(commandIndex, options.length - 1) } : undefined;
  }
  function selectResponse(group, tab) {
    selections.set(group.id, tab);
    firstRow = group.header;
    draw();
  }

  const nextTab = direction => {
    const group = viewport?.activeGroup;
    if (!group) return;
    const { tabs, selected } = group;
    const index = tabs.findIndex(tab => tab.id === selected);
    selectResponse(group, tabs[(index + direction + tabs.length) % tabs.length].id);
  };

  function click(column, row) {
    if (browserFallback) return;
    const pane = activeMode();
    const action = viewport?.actions.find(hit => hit.row === row && column >= hit.start && column < hit.end);
    if (pane?.type === 'preview') {
      if (action?.control) {
        pane.focus = previewControls.indexOf(action.control);
        choosePreview(pane);
      }
      return;
    }
    if (pane || !action) return;
    if (action.file) openDiff(action.file);
    else if (action.prompt) {
      firstRow = action.group.start;
      draw();
    } else selectResponse(action.group, action.tab);
  }

  function scrollBy(rows) {
    const pane = activeMode();
    if (!viewport || (pane && !scrollablePanes.includes(pane.type)) || browserFallback) return;
    const next = Math.max(0, Math.min(viewport.lastRow, viewport.firstRow + rows));
    if (pane) pane.firstRow = next;
    else firstRow = next === viewport.lastRow ? undefined : next;
    draw();
  }

  function draw() {
    if (!app || browserFallback) return;
    const pane = activeMode();
    const width = output.columns ?? 80;
    const height = output.rows ?? 24;
    const visibleDraft = !pane && !busy ? draft.slice(Math.max(0, cursor - width + 7)) : draft;
    viewport = layoutLooms({ width, height, title: app.title, members: app.roster(), canWrite: app.writeEnabled,
      askBeforeChanges: app.askBeforeChanges, entries: app.transcript(), selections, firstRow: pane?.firstRow ?? firstRow,
      notices, mode: pane, input: visibleDraft, suggestions: !pane && !busy ? commandSuggestions() : undefined, busy, demo: app.demo });
    if (firstRow !== undefined && !pane) firstRow = viewport.firstRow;
    const rows = viewport.screen.split('\n');
    output.write(`\x1b[?25l\x1b[H${rows.map(row => `\x1b[2K${row}`).join('\r\n')}\x1b[J`);
    if (!busy && (!pane || pane.type === 'secret')) {
      const column = pane?.type === 'secret' ? Math.min(pane.value.length + 4, 24) : Math.min(cursor + 4, width - 2);
      output.write(`\x1b[${rows.length};${column}H\x1b[?25h`);
    }
  }

  function openMenu(title, optionsToShow) {
    mode = { type: 'menu', title, all: optionsToShow, options: optionsToShow, index: 0, query: '' };
    if (!busy) draw();
  }

  const item = (label, select) => ({ label, select });
  const skillMenus = createSkillMenus({ app, openMenu, setDraft });

  function openDiff(file) {
    mode = { type: 'diff', file, firstRow: 0 };
    if (!busy) draw();
  }

  async function openPreview(task) {
    if (!task) throw new Error('Usage: /preview <task> or /preview @name <task>');
    const preview = await app.preview(task);
    // Focus starts on a section toggle so a stray Enter cannot send the task.
    mode = { type: 'preview', task, preview, excluded: new Set(), focus: 0, firstRow: 0 };
  }

  function choosePreview(pane) {
    const control = previewControls[pane.focus];
    if (control === 'cancel') { mode = undefined; draw(); return; }
    if (control === 'edit') {
      mode = undefined;
      setDraft(`/preview ${pane.task}`);
      draw();
      return;
    }
    if (busy) return;
    if (control === 'send') {
      const { preview, task } = pane;
      mode = undefined;
      firstRow = undefined;
      notices = [];
      run(async () => {
        try { await app.sendPreview(preview); }
        catch (error) {
          if (error.code === 'STALE_PREVIEW') setDraft(`/preview ${task}`);
          throw error;
        }
      });
      return;
    }
    const excluded = new Set(pane.excluded);
    if (excluded.has(control)) excluded.delete(control);
    else excluded.add(control);
    run(async () => {
      try {
        const next = await app.preview(pane.preview.text, [...excluded], pane.preview);
        if (mode !== pane) return;
        Object.assign(pane, { preview: next, excluded, error: undefined });
      } catch (error) {
        if (mode !== pane) return;
        pane.error = error.code === 'STALE_PREVIEW' ? `${error.message} Choose Edit to open it again.` : error.message;
      }
    });
  }

  async function signInTerminal(provider) {
    browserFallback = true;
    keyboard.pause();
    input.setRawMode(false);
    output.write(`${mouseOff}\x1b[?25h\x1b[?1049l\n${roomServices[provider].signIn}\n`);
    try { await app.connect(provider); }
    finally {
      input.setRawMode(true);
      keyboard.resume();
      browserFallback = false;
      output.write(`\x1b[?1049h${mouseOn}`);
    }
  }

  function accountMenu() {
    openMenu('Provider accounts', app.accounts().map(({ provider, connected, email, needsReconnect }) => item(
      `${accountLabels[provider]}  ·  ${connected ? email ? `Connected as ${email}` : 'Connected' : needsReconnect ? 'Reconnect' : 'Connect'}`, () => {
        if (app.demo) { notify({ type: 'status', text: 'Demo mode uses simulated accounts.' }); return; }
        const begin = () => {
          const service = roomServices[provider];
          if (service.auth === 'browser') return app.connect(provider, async url => {
            notify({ type: 'status', text: `Continue with ${service.accountLabel} in your browser.` });
            if (!await openBrowser(url)) {
              browserFallback = true;
              output.write(`${mouseOff}\x1b[?25h\x1b[?1049l\nOpen this address in your browser to connect LOOMS:\n${url}\n`);
            }
          }).finally(() => {
            if (browserFallback) {
              browserFallback = false;
              output.write(`\x1b[?1049h${mouseOn}`);
            }
          });
          if (service.auth === 'terminal') return openMenu(service.consent, [
            item(`Allow and sign in through ${service.label}`, () => signInTerminal(provider)),
            item('Back', accountMenu),
          ]);
          mode = { type: 'secret', title: service.keyTitle, provider, value: '' };
        };
        if (!connected) return begin();
        openMenu(`${accountLabels[provider]} connection`, [item('Reconnect', begin),
          item('Disconnect from LOOMS', () => app.disconnect(provider))]);
      })));
  }

  async function models() {
    openMenu('Room models', app.roster().map(member => item(`@${member.name}  ·  ${member.model ?? member.actual?.model ?? 'Account default'}`,
      async () => {
        const choices = await app.catalog(member.provider);
        openMenu(`Choose @${member.name} model`, [item('Account default', () => app.setModel(member.name)), ...choices.map(model =>
          item(`${model.label ?? model.id}  ·  ${model.id}`, () => {
            if (!model.efforts.length) return app.setModel(member.name, model.id);
            openMenu(`Choose @${member.name} reasoning effort`, [item('Provider default', () => app.setModel(member.name, model.id)),
              ...model.efforts.map(effort => item(effort, () => app.setModel(member.name, model.id, effort)))]);
          }))]);
      })));
  }

  function chooseRoom() {
    const saved = app.rooms().map(room => {
      const members = room.members.map(member => `@${member.name}`).join(' ');
      return item(members ? `${room.title}  ·  ${members}` : room.title, () => app.activate(room.id));
    });
    openMenu('Choose a room', [item('New room', () => app.newRoom()), ...saved, item('Provider accounts', accountMenu)]);
  }

  async function submit(line) {
    if (line === '/accounts') return accountMenu();
    if (line === '/rooms') return chooseRoom();
    if (line === '/help') { setDraft('/'); return; }
    if (!app.hasRoom) return app.command(line);
    if (line === '/skills') return skillMenus.open();
    const addressed = parseProviderCommand(line);
    if (addressed?.command === 'skills') {
      if (addressed.args) await app.command(line);
      return skillMenus.open(addressed.target);
    }
    if (line === '/diff') {
      const files = app.transcript().toReversed().flatMap(entry => entry.activity?.files.filter(file => file.diff) ?? []);
      if (!files.length) throw new Error('This room has no saved diffs.');
      return openMenu('Saved diffs · newest first', files.map(file => item(fileActivityLabel(file), () => openDiff(file))));
    }
    if (line === '/permissions') return openMenu('Room access', [item('Read-only', () => app.permissions(false)),
      item('Ask before changes', () => app.permissions('ask')), item('Workspace edits', () => app.permissions(true))]);
    if (line === '/model' || line === '/models') return models();
    if (line === '/include') {
      return openMenu('Include a provider', app.accounts().filter(account => account.connected && !app.roster().some(member => member.provider === account.provider))
        .map(account => item(accountLabels[account.provider], () => app.include([account.provider]))));
    }
    const preview = /^\/preview(?:\s+([\s\S]*))?$/.exec(line);
    if (preview) return openPreview(preview[1]?.trim() ?? '');
    await app.command(line);
  }

  function run(action) {
    if (busy) return;
    busy = true;
    draw();
    current = Promise.resolve().then(action).catch(error => notify({ type: 'status', text: error.message })).finally(() => { busy = false; draw(); });
  }

  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const handleKey = (character, key = {}) => {
    if (key.ctrl && key.name === 'c') { app.abort(); finish(); return; }
    const pane = activeMode();
    if (!pane || scrollablePanes.includes(pane.type)) {
      if (key.name === 'pageup' || key.name === 'pagedown') {
        return scrollBy(Math.max(1, (viewport?.pageSize ?? 1) - 1) * (key.name === 'pageup' ? -1 : 1));
      }
      if (key.ctrl && (key.name === 'home' || key.name === 'end')) return scrollBy(key.name === 'home' ? -Infinity : Infinity);
    }
    if (pane?.type === 'approval') {
      if (key.name === 'escape') return pane.settle(false);
      if (key.name === 'return') return pane.settle(pane.allow);
      if (key.name === 'tab') pane.allow = !pane.allow;
      if (key.name === 'left' || key.name === 'up') pane.allow = false;
      if (key.name === 'right' || key.name === 'down') pane.allow = true;
      draw();
      return;
    }
    if (pane?.type === 'preview') {
      if (key.name === 'escape') { mode = undefined; draw(); return; }
      if (key.name === 'up' || key.name === 'down') return scrollBy(key.name === 'up' ? -1 : 1);
      if (key.name === 'return') return choosePreview(pane);
      const step = key.name === 'left' || key.name === 'tab' && key.shift ? -1 : key.name === 'right' || key.name === 'tab' ? 1 : 0;
      if (step) {
        pane.focus = (pane.focus + step + previewControls.length) % previewControls.length;
        draw();
      }
      return;
    }
    if (mode) {
      if (key.name === 'escape') { mode = undefined; draw(); return; }
      if (mode.type === 'diff') {
        if (key.name === 'up' || key.name === 'down') return scrollBy(key.name === 'up' ? -1 : 1);
        return;
      }
      if (mode.type === 'plan') {
        if (key.name === 'up' || key.name === 'down') return scrollBy(key.name === 'up' ? -1 : 1);
        if (!busy && character === '/') { mode = undefined; setDraft('/'); draw(); }
        return;
      }
      if (mode.type === 'usage') {
        if (key.name === 'return' && mode.link) {
          const usage = mode;
          run(async () => { if (!await openBrowser(usage.link)) usage.text += `\n\n${usage.link}`; });
        }
        return;
      }
      if (mode.type === 'secret') {
        if (key.name === 'return' && mode.value) {
          const { provider, value } = mode;
          mode = undefined;
          run(() => app.connect(provider, value));
        } else if (key.name === 'backspace') mode.value = mode.value.slice(0, -1);
        else if (!key.ctrl && !key.meta && character && /^[\x21-\x7e]+$/.test(character)) mode.value = (mode.value + character).slice(0, 512);
        draw();
        return;
      }
      if (key.name === 'return') {
        const active = mode.options[mode.index];
        if (active) { mode = undefined; run(active.select); }
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        mode.index = Math.min(Math.max(0, mode.options.length - 1), Math.max(0, mode.index + (key.name === 'up' ? -1 : 1)));
      } else if (key.name === 'backspace' || !key.ctrl && !key.meta && character && !/[\x00-\x1f\x7f]/.test(character)) {
        mode.query = key.name === 'backspace' ? mode.query.slice(0, -1) : mode.query + character;
        const search = mode.query.toLowerCase().replace(/^\//, '');
        const rank = label => label.toLowerCase().replace(/^\//, '').startsWith(search) ? 0 : 1;
        mode.options = mode.all.filter(row => row.label.toLowerCase().includes(search)).sort((a, b) => rank(a.label) - rank(b.label));
        mode.index = 0;
      }
      draw();
      return;
    }
    if (busy) return;
    const suggestions = commandSuggestions();
    if (suggestions) {
      if (key.name === 'up' || key.name === 'down') {
        commandIndex = Math.max(0, Math.min(suggestions.options.length - 1, suggestions.index + (key.name === 'up' ? -1 : 1)));
        draw();
        return;
      }
      if (key.name === 'escape') { commandsHidden = true; draw(); return; }
      const exact = suggestions.options.some(choice => !choice.completeFirst && choice.value.trimEnd().toLowerCase() === draft.toLowerCase());
      if (key.name === 'tab' && !key.shift || key.name === 'return' && (!exact || commandIndex > 0)) {
        setDraft(suggestions.options[suggestions.index].value);
        commandsHidden = true;
        draw();
        return;
      }
    }
    const before = draft;
    if (key.name === 'tab') return nextTab(key.shift ? -1 : 1);
    if (key.name === 'return') {
      const line = draft.trim();
      if (!line) return;
      if (line === '/quit') { finish(); return; }
      setDraft('');
      firstRow = undefined;
      notices = [];
      run(() => submit(line));
    } else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'right') cursor = Math.min(draft.length, cursor + 1);
    else if (key.name === 'home') cursor = 0;
    else if (key.name === 'end') cursor = draft.length;
    else if (key.name === 'escape' || key.ctrl && key.name === 'u') setDraft('');
    else if (key.name === 'backspace' && cursor > 0) { draft = draft.slice(0, cursor - 1) + draft.slice(cursor); cursor--; }
    else if (key.name === 'delete') draft = draft.slice(0, cursor) + draft.slice(cursor + 1);
    else if (!key.ctrl && !key.meta && character && !/[\x00-\x1f\x7f]/.test(character)) {
      draft = draft.slice(0, cursor) + character + draft.slice(cursor);
      cursor += character.length;
      if (character === '@' && cursor === draft.length && /^\/(room(?:-new)?|include)[ \t]+(?:@[a-z][\w-]*[\s,]+)*@$/i.test(draft)) {
        const prefix = draft;
        const chosen = new Set([...draft.matchAll(/@([a-z][\w-]*)/gi)].map(match => match[1].toLowerCase()));
        if (draft.startsWith('/include ')) for (const member of app.roster()) chosen.add(member.provider);
        openMenu('Connected providers', app.accounts().filter(account => account.connected && !chosen.has(account.provider))
          .map(account => item(`@${account.provider}  ·  ${accountLabels[account.provider]}`, () => setDraft(`${prefix}${account.provider} `))));
        return;
      }
    }
    if (draft !== before) resetSuggestions();
    draw();
  };

  const stop = () => { app.abort(); finish(); };
  const keyboard = terminalKeys(input, handleKey, scrollBy, click);
  input.setRawMode(true);
  keyboard.resume();
  output.on('resize', draw);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  output.write(`\x1b[?1049h${mouseOn}\x1b]0;LOOMS\x07`);
  if (app.hasRoom) draw();
  else chooseRoom();
  try { await done; await current; await app.close(); }
  finally {
    keyboard.pause();
    output.off('resize', draw);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    input.setRawMode(false);
    output.write(`${mouseOff}\x1b[?25h\x1b[?1049l`);
  }
}
