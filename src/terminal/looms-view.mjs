import { stripVTControlCharacters } from 'node:util';
import { roomAccessLabel } from '../providers/room-services.mjs';
import { activityRows, fileActivityLabel, modelChatText } from '../room/room-activity.mjs';
import { logoArt, logoWidth } from './looms-logo.mjs';

const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/\r\n/g, '\n').replace(/[^\S\n]/g, ' ')
  .replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' ? character : '');
const upper = value => clean(value).toUpperCase();
const formattedEntries = new WeakMap();
const approvalText = value => value.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, character =>
  character === ' ' || character === '\n' ? character : `\\u{${character.codePointAt(0).toString(16)}}`);

export const previewControls = Object.freeze(['summary', 'history', 'send', 'edit', 'cancel']);
const previewLabels = { summary: 'Room summary', history: 'Recent room history' };
const previewNotice = 'Send starts fresh sessions with one initial reply per target or ordered step. Estimates cover the prompt ' +
  'text shown here. Trimming either section also disables room-log reads for this send. Tool calls can add context and tokens.';
const previewSectionRows = new WeakMap();

export function responseTabs(entries, roster = []) {
  const speakers = [...new Set(entries.filter(entry => !['user', 'system', 'room'].includes(entry.speaker)).map(entry => entry.speaker))].sort();
  if (speakers.length < 2) return [];
  return [{ id: 'all', title: 'ALL RESPONSES' }, ...speakers.map(id => {
    const provider = roster.find(member => member.name === id)?.provider ?? id;
    return { id, title: `${upper(id === provider ? provider : id)} RESPONSE` };
  })];
}

function responseGroups(entries) {
  const groups = [];
  let group;
  for (const entry of entries) {
    if (!group || entry.speaker === 'user' || entry.round !== group.round) {
      group = { id: `${entry.round ?? 'history'}:${entry.id ?? groups.length}`, round: entry.round, replies: [] };
      groups.push(group);
    }
    if (entry.speaker === 'user') group.prompt = entry;
    else group.replies.push(entry);
  }
  return groups;
}

function wrap(text, width) {
  return clean(text).split('\n').flatMap(line => {
    const characters = Array.from(line);
    if (!characters.length) return [''];
    const rows = [];
    for (let i = 0; i < characters.length; i += width) rows.push(characters.slice(i, i + width).join(''));
    return rows;
  });
}

const color = (text, code, enabled) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

function inlineSpans(line, style = '') {
  const spans = [];
  let end = 0;
  const inline = /\\([*_`\\])|(`+)(.+?)\2(?!`)|\*\*(\S(?:.*?\S)?)\*\*|(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g;
  for (const match of line.matchAll(inline)) {
    const [, escaped, , code, bold, italic] = match;
    spans.push({ text: line.slice(end, match.index), style });
    if (escaped) spans.push({ text: escaped, style });
    else if (code) spans.push({ text: code, style: style ? `${style};96` : '96' });
    else if (bold) spans.push(...inlineSpans(bold, '1'));
    else spans.push(...inlineSpans(italic, style ? `${style};3` : '3'));
    end = match.index + match[0].length;
  }
  spans.push({ text: line.slice(end), style });
  return spans;
}

function wrapSpans(spans, width, styled, code) {
  const rows = [];
  let remaining = width;
  let row = '';
  for (const { text, style } of spans) {
    for (const word of text.match(/\S+| +/g) ?? []) {
      const chars = Array.from(word);
      if (!code && word[0] !== ' ' && chars.length > remaining && chars.length <= width && row) {
        rows.push(row);
        row = '';
        remaining = width;
      }
      for (let start = 0; start < chars.length;) {
        if (!remaining) {
          rows.push(row);
          row = '';
          remaining = width;
        }
        if (!code && !row && rows.length && word[0] === ' ') break;
        const count = Math.min(remaining, chars.length - start);
        row += color(chars.slice(start, start + count).join(''), style, styled && Boolean(style));
        remaining -= count;
        start += count;
      }
    }
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

function messageRows(entry, width, styled) {
  const { text } = entry;
  const cached = formattedEntries.get(entry);
  if (cached?.width === width && cached.styled === styled && cached.text === text) return cached.rows;
  let fence;
  const visible = ['user', 'system', 'room'].includes(entry.speaker) ? text : modelChatText(stripVTControlCharacters(text));
  const rows = clean(visible).split('\n').flatMap(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) {
      fence = marker[1];
      const language = marker[2].trim();
      return language ? wrapSpans([{ text: language, style: '2;96' }], width, styled, true) : [];
    }
    if (fence && marker && marker[1].startsWith(fence) && !marker[2].trim()) {
      fence = undefined;
      return [];
    }
    if (fence) return wrapSpans([{ text: line, style: '96' }], width, styled, true);
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    const prose = (heading?.[1] ?? line).replace(/^(\s*)[-+*] /, '$1• ').replace(/^(\s*)> ?/, '$1│ ');
    return wrapSpans(inlineSpans(prose, heading ? '1;96' : ''), width, styled, false);
  }).map(line => `  ${line}`);
  formattedEntries.set(entry, { width, styled, text, rows });
  return rows;
}

// Show invisible characters as escapes so the reviewed text is visible and safe to render.
function sectionRows(section, width) {
  const cached = previewSectionRows.get(section);
  if (cached?.width === width) return cached.rows;
  const rows = wrap(approvalText(section.text), width);
  previewSectionRows.set(section, { width, rows });
  return rows;
}

function previewBody(mode, width, tint, clip) {
  const body = [];
  const note = (text, style) => body.push(...wrap(text, width - 3).map(line => ({ text: tint(` ${line}`, style) })));
  body.push({ text: tint(` ${clip(`Preview · ${mode.preview.text}`)}`, '1;96') }, { text: '' });
  note(previewNotice, '2');
  body.push({ text: '' });
  if (mode.error) {
    note(mode.error, '1;91');
    body.push({ text: '' });
  }
  for (const target of mode.preview.targets) {
    body.push({ text: tint(` ${clip(`@${target.name}  ·  ~${target.tokens.toLocaleString('en-US')} tokens`)}`, '1;96') });
    const excluded = previewControls.filter(id => mode.excluded.has(id)).map(id => ({ id, excluded: true }));
    const sections = [...target.sections];
    const after = Math.max(0, sections.findIndex(section => section.id === 'instructions') + 1);
    sections.splice(after, 0, ...excluded);
    for (const section of sections) {
      if (section.excluded) {
        body.push({ text: tint(` ${clip(`── ${previewLabels[section.id]}  ·  excluded`)}`, '2') });
        continue;
      }
      const tokens = `~${section.tokens.toLocaleString('en-US')} tokens${section.optional ? '  ·  optional' : ''}`;
      body.push({ text: tint(` ${clip(`── ${section.label}  ·  ${tokens}`)}`, '2') });
      body.push(...sectionRows(section, width - 5).map(text => ({ text: `   ${text}` })));
    }
    if (target.pending) {
      body.push({ text: tint(` ${clip('── Pending handoff')}`, '2') });
      body.push(...wrap(target.pending, width - 5).map(text => ({ text: tint(`   ${text}`, '3') })));
    }
    body.push({ text: '' });
  }
  return body;
}

function previewFooter(mode, width, busy, tint) {
  const labels = {
    summary: `[${mode.excluded.has('summary') ? ' ' : 'x'}] Summary`,
    history: `[${mode.excluded.has('history') ? ' ' : 'x'}] History`,
    send: 'Send', edit: 'Edit', cancel: 'Cancel',
  };
  const rows = [];
  let row;
  for (const [index, control] of previewControls.entries()) {
    const focused = index === mode.focus;
    const piece = `${focused ? '›' : ' '} ${labels[control]}`;
    const length = Array.from(piece).length;
    if (!row || row.column + 2 + length > width - 1) {
      row = { text: ' ', column: 2, actions: [] };
      rows.push(row);
    } else {
      row.text += '  ';
      row.column += 2;
    }
    row.actions.push({ start: row.column, end: row.column + length, control });
    row.text += tint(piece, focused ? '1;96' : '');
    row.column += length;
  }
  const hint = busy ? ' Working…' : ' ←→ Choose · Enter Select · Wheel/PgUp/PgDn Scroll · Esc Cancel';
  return [{ text: tint(Array.from(hint).slice(0, width - 1).join(''), '2') }, ...rows];
}

function responseBar(group, width, tint) {
  let text = tint(' ╭─ ', '2');
  let column = 5;
  const actions = [];
  const add = (label, action, style) => {
    const end = column + Array.from(label).length;
    actions.push({ start: column, end, group, ...action });
    text += tint(label, style);
    column = end;
  };
  const showPrompt = Boolean(group.prompt);
  let tabs = group.tabs;
  const fullPrompt = tabs.map(tab => tab.title).join(' | ').length + (tabs.length ? 3 : 0) + 8 <= width - 6;
  const promptLabel = fullPrompt ? '↑ Prompt' : '↑';
  const budget = width - 6 - (showPrompt ? promptLabel.length + (tabs.length ? 3 : 0) : 0);
  const separator = tabs.length * 4 - 3 > budget ? '|' : ' | ';
  const capacity = Math.floor((budget + separator.length) / (1 + separator.length));
  if (tabs.length > capacity) {
    const first = Math.min(tabs.findIndex(tab => tab.id === group.selected), tabs.length - capacity);
    tabs = tabs.slice(first, first + capacity);
  }
  const labels = tabs.map(tab => tab.title);
  if (labels.join(separator).length > budget) {
    const limit = Math.max(1, Math.floor((budget - (labels.length - 1) * separator.length) / labels.length));
    for (const [index, label] of labels.entries()) labels[index] = Array.from(label.split(' RESPONSE')[0]).slice(0, limit).join('');
  }
  for (const [index, tab] of tabs.entries()) {
    if (index) { text += tint(separator, '2'); column += separator.length; }
    add(labels[index], { tab: tab.id }, tab.id === group.selected ? '1;96' : '2');
  }
  if (showPrompt) {
    if (labels.length) { text += tint(separator, '2'); column += separator.length; }
    add(promptLabel, { prompt: true }, '96');
  }
  return { text: text + tint(`${'─'.repeat(Math.max(0, width - column - 1))}╮`, '2'), actions, group };
}

export function layoutLooms({ width, height, title, members, canWrite, askBeforeChanges, entries, selections, firstRow, notices, mode, input, suggestions, busy, demo, styled = true }) {
  width = Math.max(24, width);
  height = Math.max(10, height);
  const tint = (text, style) => color(text, style, styled);
  const clip = (text, limit = width - 2) => Array.from(clean(text)).slice(0, limit).join('');
  const header = [tint('LOOMS', '1;96'), ...(title ? [clip(`${title}${demo ? ' · Demo' : ''}`, width - 10)] : [])].join('   ');
  const lines = [` ${header}`];
  const services = members.map(member => `@${member.name}${member.actual?.model || member.model ? ` ${member.actual?.model ?? member.model}` : ''}`);
  if (title) lines.push(tint(` ${clip([roomAccessLabel(canWrite, askBeforeChanges), ...services].join('  ·  '))}`, '2'));
  lines.push(tint('─'.repeat(width - 1), '2'));
  const overlay = ['usage', 'approval', 'preview', 'diff', 'plan'].includes(mode?.type);
  const groups = overlay ? [] : responseGroups(entries);
  const body = [];
  const speaker = (entry, limit) => tint(` ${clip(entry.speaker === 'user' ? 'YOU' : `@${entry.speaker.toUpperCase()}`, limit)}`,
    entry.speaker === 'user' ? '1' : '1;96');
  const boxLine = text => `${tint(' │', '2')}${text}${' '.repeat(Math.max(1, width - 4 - Array.from(stripVTControlCharacters(text)).length))}${tint('│', '2')}`;
  for (const group of groups) {
    group.start = body.length;
    if (group.prompt) body.push({ text: speaker(group.prompt) }, ...messageRows(group.prompt, width - 3, styled).map(text => ({ text })), { text: '' });
    if (!group.replies.length) continue;
    group.tabs = responseTabs(group.replies, members);
    const selected = selections?.get(group.id);
    group.selected = group.tabs.some(tab => tab.id === selected) ? selected : 'all';
    group.header = body.length;
    body.push(responseBar(group, width, tint));
    for (const entry of group.replies) {
      if (group.selected !== 'all' && !['system', 'room', group.selected].includes(entry.speaker)) continue;
      body.push({ text: boxLine(speaker(entry, width - 5)) });
      if (entry.text) for (const text of messageRows(entry, width - 6, styled)) body.push({ text: boxLine(text) });
      if (entry.activity) {
        for (const { text, file } of activityRows(entry.activity)) {
          const actions = file?.diff ? [{ file, start: 3, end: width - 1 }] : undefined;
          for (const line of wrap(approvalText(text), width - 6)) body.push({ text: boxLine(tint(`  ${line}`, '1;96')), actions });
        }
      }
      body.push({ text: boxLine('') });
    }
    body.push({ text: tint(` ╰${'─'.repeat(width - 4)}╯`, '2') });
    group.end = body.length;
    body.push({ text: '' });
  }
  if (mode?.type === 'approval') {
    const { action, agent, taskID, path, command, content } = mode.request;
    const verb = { create: 'Create file', replace: 'Replace file', delete: 'Delete file', verify: 'Run verification' }[action];
    lines.push(tint(` ${clip(`Approval requested by @${agent}`)}`, '1;96'));
    const request = [verb, taskID && `Task ${taskID}`, action === 'verify' ? approvalText(command) : approvalText(path),
      ...(content === undefined ? [] : ['', 'Proposed file contents', approvalText(content || '(empty file)')])].filter(line => line !== undefined).join('\n');
    body.push(...wrap(request, width - 3).map(text => ({ text: ` ${text}` })));
  } else if (mode?.type === 'usage' || mode?.type === 'plan') {
    body.push({ text: tint(` ${mode.type === 'plan' ? 'Job plan' : mode.title ?? 'Usage'}`, '1;96') }, { text: '' },
      ...clean(mode.text).split('\n').flatMap(line => wrapSpans([{ text: line }], width - 3, styled, false)).map(text => ({ text: ` ${text}` })));
  } else if (mode?.type === 'preview') {
    body.push(...previewBody(mode, width, tint, clip));
  } else if (mode?.type === 'diff') {
    body.push({ text: tint(` ${clip(approvalText(fileActivityLabel(mode.file)))}`, '1;96') }, { text: '' });
    for (const line of mode.file.diff.split('\n')) {
      const style = line.startsWith('+') ? '32' : line.startsWith('-') ? '31' : '2';
      for (const row of wrap(approvalText(line), width - 3)) body.push({ text: tint(` ${row}`, style) });
    }
  }
  const activity = overlay ? [] : notices.flatMap(text => wrap(text, width - 3).map(line => tint(` ${line}`, '2'))).slice(-4);
  const footer = [];
  if (mode?.type === 'menu') {
    footer.push(tint(` ${clip(mode.title)}`, '1;96'), ` Filter: ${clip(mode.query)}`);
    const offset = Math.max(0, mode.index - 4);
    for (const [index, option] of mode.options.slice(offset, offset + 5).entries()) {
      footer.push(tint(` ${mode.index === offset + index ? '›' : ' '} ${clip(option.label)}`, mode.index === offset + index ? '1;96' : ''));
    }
    if (!mode.options.length) footer.push(tint(' No matching options.', '2'));
    footer.push(tint(' ↑↓ Select · Enter Confirm · Esc Back', '2'));
  } else if (mode?.type === 'secret') {
    footer.push(tint(` ${clip(mode.title)}`, '1;96'), tint(' Stored in the local LOOMS credential vault. Enter to connect · Esc back.', '2'),
      ` › ${'•'.repeat(Math.min(mode.value.length, 20))}`);
  } else if (mode?.type === 'approval') {
    footer.push(tint(` ${clip('← → Choose · Enter Confirm · Esc Deny')}`, '2'),
      ` ${mode.allow ? '  Deny' : tint('› Deny', '1;96')}   ${mode.allow ? tint('› Allow once', '1;96') : '  Allow once'}`);
  } else if (mode?.type === 'usage' || mode?.type === 'diff') {
    footer.push(tint(' Esc Back · Wheel/PgUp/PgDn Scroll', '2'));
    if (mode.link) footer.push(tint(` ${clip(`Enter Open ${mode.linkLabel ?? 'usage settings'}`)}`, '96'));
  } else if (mode?.type === 'plan') {
    footer.push(tint(` ${clip('↑↓ Scroll · Esc Back · / Commands')}`, '2'));
  } else if (mode?.type === 'preview') {
    footer.push(...previewFooter(mode, width, busy, tint));
  } else {
    if (suggestions) {
      const count = Math.max(1, Math.min(5, height - lines.length - activity.length - 4));
      const offset = Math.max(0, suggestions.index - count + 1);
      footer.push(tint(` ${clip(`${suggestions.title} · ↑↓ Select · Tab Complete`)}`, '2'));
      for (const [index, option] of suggestions.options.slice(offset, offset + count).entries()) {
        const selected = suggestions.index === offset + index;
        footer.push(tint(` ${selected ? '›' : ' '} ${clip(option.label, width - 4)}`, selected ? '1;96' : '0'));
      }
    } else footer.push(tint(` ${clip(`Wheel/PgUp/PgDn Scroll · ${groups.some(group => group.tabs?.length) ? 'Tab Responses · ' : ''}/ Commands`)}`, '2'));
    footer.push(
      ` ${tint('›', '1;96')} ${clip(busy ? 'Working…' : input)}`);
  }
  const bodyRows = Math.max(1, height - lines.length - footer.length - activity.length - 1);
  if (!body.length && !overlay) {
    const showLogo = width >= logoWidth + 2 && bodyRows >= logoArt.plain.length;
    const art = showLogo ? (styled ? logoArt.styled : logoArt.plain) : [tint('LOOMS', '1;96')];
    const inset = ' '.repeat(Math.floor((width - (showLogo ? logoWidth : 'LOOMS'.length)) / 2));
    const hint = !mode && bodyRows > art.length
      ? !title ? 'Open /rooms to choose a room.' :
        members.length ? 'Start a conversation or type / for commands.' : 'Open /accounts to connect a model.'
      : '';
    const padding = Math.floor((bodyRows - art.length - Number(Boolean(hint))) / 2);
    for (let row = 0; row < padding; row++) body.push({ text: '' });
    body.push(...art.map(line => ({ text: inset + line })));
    if (hint) body.push({ text: tint(' '.repeat(Math.max(1, Math.floor((width - hint.length) / 2))) + clip(hint), '2') });
  }
  const pinnedAt = row => bodyRows > 1 && groups.find(group => group.tabs?.length && group.header < row && row < group.end);
  const naturalEnd = Math.max(0, body.length - bodyRows);
  const lastRow = naturalEnd + Number(Boolean(pinnedAt(naturalEnd)));
  const start = Math.max(0, Math.min(lastRow, firstRow ?? lastRow));
  const pinned = pinnedAt(start);
  const page = body.slice(start, start + bodyRows - Number(Boolean(pinned)));
  if (pinned) page.unshift(body[pinned.header]);
  const actions = page.flatMap((row, i) => (row.actions ?? []).map(action => ({ ...action, row: lines.length + i + 1 })));
  const footerTop = lines.length + bodyRows + activity.length;
  for (const [i, row] of footer.entries()) for (const action of row.actions ?? []) actions.push({ ...action, row: footerTop + i + 1 });
  const activeGroup = page.find(row => row.group?.tabs.length)?.group;
  const screen = [...lines, ...page.map(row => row.text), ...Array(Math.max(0, bodyRows - page.length)).fill(''), ...activity,
    ...footer.map(row => typeof row === 'string' ? row : row.text)].join('\n');
  return { screen, actions, activeGroup, firstRow: start, lastRow, pageSize: bodyRows };
}

export const renderLooms = options => layoutLooms(options).screen;
