import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { providers } from './room-services.mjs';

const compact = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const byteLimit = 2000;
const maxProgress = 10;

function optional(read, missing) {
  try { return read(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return missing; }
}

function atomicWrite(path, text) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx', flush: true });
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

function sections(roomID, round, data, fields) {
  const taskCell = value => compact(String(value ?? ''), 120).replaceAll('|', '\\|');
  const decisionLine = ({ id, text }) => {
    if (!text.includes('\n')) return `- ${id}: ${text}`;
    const fence = '~'.repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map(match => match[0].length + 1)));
    return `- ${id}:\n\n${fence}\n${text}\n${fence}`;
  };
  const taskRows = data.tasks.map(task =>
    `| ${taskCell(task.id)} | ${taskCell(task.agent)} | ${taskCell(task.state ?? 'pending')} | ${taskCell(task.blocked_on ?? task.depends_on?.join(', '))} |`);
  const owners = data.tasks.filter(task => task.owns?.length).map(task =>
    `| ${taskCell(task.agent)} | ${taskCell(task.id)} | ${taskCell(task.owns.join(', '))} |`);
  return [
    `# Room ${roomID}: shared context (round ${round}, generated ${data.timestamp})`,
    `## Goal\n${fields.goal || 'No goal recorded.'}`,
    `## Decisions\n${data.decisions.map(decisionLine).join('\n') || '- None.'}`,
    `## Contracts\n${data.contracts.map(contract => `- ${contract.id} v${contract.version}: ${contract.path} (summary: ${contract.summary})`).join('\n') || '- None.'}`,
    ['## Ownership', '| Agent | Task | Owned paths |', '| --- | --- | --- |', ...owners].join('\n'),
    ['## Task status', '| Task | Agent | State | Blocked on |', '| --- | --- | --- | --- |', ...taskRows].join('\n'),
    `## Open questions\n${fields.questions.map(question => `- Q (from @${question.from} to ${question.to.map(to => `@${to}`).join(', ')}, ${question.id}): ${question.text}`).join('\n') || '- None.'}`,
    `## Recent progress\n${fields.progress.map(progress => `- ${progress.text}`).join('\n') || '- None.'}`,
  ].join('\n\n') + '\n';
}

function modelFields(text) {
  const value = typeof text === 'string' ? JSON.parse(text.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, '$1')) : text;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a summary JSON object.');
  return value;
}

export function createRoomSummary({ roomID, log, summarize, report = () => {} }) {
  const summaryPath = join(log.directory, 'AGENTS.md');
  const decisionsPath = join(log.directory, 'decisions.jsonl');
  const contractsDirectory = join(log.directory, 'contracts');
  const snapshotsDirectory = join(log.directory, 'snapshots');
  let previous = log.records({ after: log.activeStart }).findLast(message => message.kind === 'summary' && message.summary_fields);
  let requestedThrough = previous?.covers ?? log.activeStart;
  let pending = Promise.resolve();
  let closed = false;

  function decisions() {
    const raw = optional(() => readFileSync(decisionsPath, 'utf8'), '');
    if (raw && !raw.endsWith('\n')) throw new Error('Room decisions end with an incomplete record.');
    return raw ? raw.slice(0, -1).split('\n').map((line, index) => {
      const choice = JSON.parse(line);
      if (choice?.id !== `D${index + 1}` || typeof choice.text !== 'string' || !choice.source) {
        throw new Error(`Invalid room decision at line ${index + 1}.`);
      }
      return choice;
    }) : [];
  }

  function decide(text, source, supersedes) {
    if (!text.trim() || !log.records().some(message => message.id === source)) throw new Error('A decision needs text and a source message.');
    const existing = decisions();
    if (supersedes && !existing.some(decision => decision.id === supersedes)) throw new Error(`Unknown decision ${supersedes}.`);
    const decision = { id: `D${existing.length + 1}`, source, text, ...(supersedes ? { supersedes } : {}) };
    appendFileSync(decisionsPath, `${JSON.stringify(decision)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
    return decision;
  }

  function readInputs() {
    const job = optional(() => JSON.parse(readFileSync(join(log.directory, 'job.json'), 'utf8')), {});
    const names = optional(() => readdirSync(contractsDirectory, { withFileTypes: true }), []);
    const contracts = names.filter(entry => entry.isFile()).flatMap(entry => {
      const version = /^([a-z0-9_-]+)\.v(\d+)\.md$/i.exec(entry.name);
      if (!version) return [];
      const body = readFileSync(join(contractsDirectory, entry.name), 'utf8');
      return [{
        id: version[1], version: Number(version[2]), path: posix.join('.room', roomID, 'contracts', entry.name),
        summary: compact(body.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, ''), 120) || 'See contract.',
      }];
    }).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
    return { timestamp: new Date().toISOString(), decisions: decisions(), tasks: job.tasks ?? [], job, contracts };
  }

  function snapshot(round, reviewed) {
    mkdirSync(snapshotsDirectory, { recursive: true, mode: 0o700 });
    const path = join(snapshotsDirectory, `AGENTS.r${String(round).padStart(4, '0')}.md`);
    const existing = optional(() => readFileSync(path, 'utf8'), null);
    if (existing !== null) return existing;
    const latest = reviewed ?? (current() ||
      sections(roomID, Math.max(0, round - 1), readInputs(), { goal: '', questions: [], progress: [] }));
    atomicWrite(path, latest);
    return readFileSync(path, 'utf8');
  }

  async function generate(round, through) {
    const data = readInputs();
    const since = log.records({ after: previous?.covers ?? log.activeStart, through });
    const records = log.records({ after: log.activeStart, through });
    const answered = new Set(records.filter(message => message.kind === 'answer').map(message => message.reply_to));
    const open = records.filter(message => message.kind === 'question' && !answered.has(message.id));
    const byID = new Map(records.map(message => [message.id, message]));
    const done = new Map(data.tasks.filter(task => task.state === 'done').map(task => [task.id, task.done_round]));
    const sourceID = record => record.message_id;
    const proposed = summarize ? modelFields(await summarize({
      previous: previous?.text ?? '',
      messages: since.filter(message => !(message.kind === 'event' && message.activity)).map(({ activity, ...message }) => message),
      decisions: data.decisions, job: data.job, contracts: data.contracts,
    })) : {};
    if (closed) return;
    const goal = compact(proposed.goal, 320) || compact(data.job.goal, 320) || previous?.summary_fields.goal ||
      compact(since.find(message => message.from === 'user' && message.kind === 'chat')?.text, 320);
    const rephrased = new Map((Array.isArray(proposed.open_questions) ? proposed.open_questions : []).map(item =>
      [item?.message_id, compact(item?.text, 180)]));
    const questions = open.map(message => ({ id: message.id, from: message.from, to: message.to,
      text: rephrased.get(message.id) || compact(message.text, 180) }));
    const rawProgress = since.filter(message => message.kind === 'task_update' || message.kind === 'chat' &&
      !['system', 'user'].includes(message.from)).map(message => ({ message_id: message.id, text: message.text }));
    const normalize = items => {
      const seen = new Set();
      return items.flatMap(item => {
        const id = item && sourceID(item);
        const source = byID.get(id);
        const text = compact(item?.text, 240);
        if (!source || !text || !['task_update', 'chat'].includes(source.kind) ||
            ['user', 'system'].includes(source.from) || seen.has(id)) return [];
        const finished = done.get(source.task_id);
        if (Number.isInteger(finished) && round - finished >= 3) return [];
        seen.add(id);
        return [{ message_id: id, text }];
      }).sort((a, b) => Number(b.message_id.slice(4)) - Number(a.message_id.slice(4))).slice(0, maxProgress);
    };
    const proposedProgress = Array.isArray(proposed.recent_progress) ? proposed.recent_progress : rawProgress;
    const fields = { goal, questions, progress: normalize([...proposedProgress, ...(previous?.summary_fields.progress ?? [])]) };
    const render = () => sections(roomID, round, data, fields);
    let text = render();
    // A UTF-8 byte bound is conservative for byte-based tokenizers.
    if (Buffer.byteLength(text) > byteLimit && fields.progress.length && summarize) {
      const shortened = modelFields(await summarize({ shorten: true, recent_progress: fields.progress }));
      if (closed) return;
      if (Array.isArray(shortened.recent_progress)) {
        const previousIDs = new Set(fields.progress.map(sourceID));
        fields.progress = normalize(shortened.recent_progress.filter(item => previousIDs.has(item?.message_id)));
      }
      text = render();
    }
    while (Buffer.byteLength(text) > byteLimit && fields.progress.length) {
      fields.progress.pop();
      text = render();
    }
    if (Buffer.byteLength(text) > byteLimit) throw new Error('The pinned room summary sections exceed the size cap.');
    mkdirSync(log.directory, { recursive: true, mode: 0o700 });
    previous = log.append({ round, from: 'system', to: [], kind: 'summary', text, covers: through, summary_fields: fields });
    atomicWrite(summaryPath, text);
  }

  function request(round, complete = false) {
    const through = log.length;
    if (closed || through <= requestedThrough || (!complete && through - requestedThrough <= 30)) return;
    requestedThrough = through;
    pending = pending.then(() => {
      if (!closed) return generate(round, through);
    }).catch(error => { if (!closed) report(`Room summary failed: ${error.message}`); });
  }

  function current() {
    return previous?.text ?? (log.activeStart ? '' : optional(() => readFileSync(summaryPath, 'utf8'), ''));
  }

  const completed = log.records({ after: requestedThrough }).findLast(message =>
    message.kind === 'event' && message.text === 'round.complete');
  if (completed) request(log.round, true);

  return {
    decide, snapshot, request,
    current,
    reset: () => { previous = undefined; requestedThrough = log.length; },
    flush: () => pending,
    close: () => { closed = true; summarize?.close?.(); },
  };
}

export function configuredRoomSummarizer(cwd, specification, createAdapters) {
  if (!specification) return;
  const [provider, ...parts] = specification.split(':');
  const model = parts.join(':');
  if (!providers.includes(provider) || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) {
    throw new Error('The room summarizer must name a provider and model, for example provider:model.');
  }
  const adapters = createAdapters({ cwd, writeEnabled: false });
  const member = { provider, model };
  const run = async input => {
    const instructions = input.shorten
      ? 'Return only JSON with recent_progress as an array of {message_id,text}. Shorten only those progress bullets.'
      : 'Return only JSON with goal (one or two sentences), open_questions, and recent_progress. Both arrays contain {message_id,text} entries grounded in the supplied log. Keep at most 10 progress items. Use the previous summary for continuity. Decisions, contracts, ownership, and task status are handled by code.';
    return adapters.ask('summarizer', member, `${instructions}\n\nRoom data:\n${JSON.stringify(input)}`);
  };
  run.close = adapters.close;
  return run;
}
