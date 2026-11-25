import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { validActivity } from './room-activity.mjs';
import { validJobOutcomes } from './room-assignment.mjs';

const kinds = new Set(['chat', 'task_update', 'question', 'answer', 'event', 'summary']);
const participant = /^[a-z][a-z0-9_-]*$/;
const messageID = /^msg_\d{4,}$/;
const usageFields = new Set(['input_tokens', 'output_tokens', 'cost_usd']);
const boundaries = new Set(['conversation.reset', 'conversation.rebased']);
const idFor = sequence => `msg_${String(sequence).padStart(4, '0')}`;
const visibleKinds = new Set(['chat', 'task_update', 'question', 'answer']);

function validateMessage(message, sequence, previousRound = 0) {
  if (!message || typeof message !== 'object' || message.id !== idFor(sequence) ||
      typeof message.ts !== 'string' || Number.isNaN(Date.parse(message.ts)) ||
      !Number.isSafeInteger(message.round) || message.round < previousRound ||
      typeof message.from !== 'string' || !participant.test(message.from) ||
      !Array.isArray(message.to) || !message.to.every(name => typeof name === 'string' && participant.test(name)) ||
      !kinds.has(message.kind) || typeof message.text !== 'string') {
    throw new Error(`Invalid room message ${idFor(sequence)}.`);
  }
  if (message.task_id !== undefined && typeof message.task_id !== 'string' ||
      message.reply_to !== undefined && (typeof message.reply_to !== 'string' || !messageID.test(message.reply_to) ||
        Number(message.reply_to.slice(4)) >= sequence || Number(message.reply_to.slice(4)) < 1) ||
      message.artifacts !== undefined && (!Array.isArray(message.artifacts) ||
        !message.artifacts.every(path => typeof path === 'string' && path.length))) {
    throw new Error(`Invalid room message references in ${message.id}.`);
  }
  if (message.usage !== undefined && (
    ['user', 'system'].includes(message.from) || !message.usage || typeof message.usage !== 'object' ||
    Array.isArray(message.usage) || Object.entries(message.usage).some(([key, value]) =>
      !usageFields.has(key) || !Number.isFinite(value) || value < 0 || (key !== 'cost_usd' && !Number.isSafeInteger(value)))
  )) {
    throw new Error(`Invalid room usage in ${message.id}.`);
  }
  if (message.activity !== undefined && (['user', 'system'].includes(message.from) ||
      (!visibleKinds.has(message.kind) && message.kind !== 'event') || !validActivity(message.activity))) {
    throw new Error(`Invalid room activity in ${message.id}.`);
  }
  if (message.job_outcomes !== undefined && (message.kind !== 'event' || message.from !== 'system' ||
      message.text !== 'job.outcomes' || !validJobOutcomes(message.job_outcomes))) {
    throw new Error(`Invalid job outcomes in ${message.id}.`);
  }
  if (message.history_hash !== undefined && (
    message.kind !== 'event' || message.from !== 'system' || message.text !== 'conversation.checkpoint' ||
    typeof message.history_hash !== 'string' || !/^[a-f0-9]{64}$/.test(message.history_hash)
  )) {
    throw new Error(`Invalid history checkpoint in ${message.id}.`);
  }
  if (message.covers !== undefined || message.summary_fields !== undefined) {
    const fields = message.summary_fields;
    if (message.kind !== 'summary' || message.from !== 'system' ||
        !Number.isSafeInteger(message.covers) || message.covers < 0 || message.covers >= sequence ||
        typeof fields?.goal !== 'string' || !Array.isArray(fields.questions) || !Array.isArray(fields.progress) ||
        fields.progress.some(item => typeof item?.message_id !== 'string' || typeof item.text !== 'string')) {
      throw new Error(`Invalid summary checkpoint in ${message.id}.`);
    }
  }
  if (message.contract_event !== undefined) {
    const { type, from, version, contract } = message.contract_event ?? {};
    if (message.kind !== 'event' || message.from !== 'system' || typeof from !== 'string' || !participant.test(from) ||
        !['proposed', 'updated'].includes(type) || !Number.isSafeInteger(version) || version < (type === 'updated' ? 1 : 0) ||
        (type === 'updated' && !message.reply_to) || !/^[a-z][a-z0-9_-]{0,63}$/.test(contract?.id ?? '') ||
        typeof contract?.content !== 'string' || typeof contract?.reason !== 'string') {
      throw new Error(`Invalid contract event in ${message.id}.`);
    }
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

export function openRoomLog(cwd, roomID) {
  if (typeof roomID !== 'string' || !/^[A-Za-z0-9_-]{1,140}$/.test(roomID)) {
    throw new Error('Invalid room log ID.');
  }
  const root = join(cwd, '.room');
  const directory = join(root, roomID);
  const path = join(directory, 'log.jsonl');
  const lockPath = join(directory, 'log.lock');
  for (const item of [root, directory, path]) {
    if (lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Room log path must not be a symbolic link: ${item}`);
    }
  }
  const raw = readOptional(path);
  if (raw && !raw.endsWith('\n')) throw new Error(`Room log ends with an incomplete record: ${path}`);
  let size = Buffer.byteLength(raw);
  let round = 0;
  let start = 0;
  let historyHash;
  const entries = [];

  function remember(message) {
    if (visibleKinds.has(message.kind)) historyHash = undefined;
    if (message.kind === 'event' && message.from === 'system') {
      if (boundaries.has(message.text)) {
        start = entries.length + 1;
        historyHash = undefined;
      }
      if (message.text === 'conversation.checkpoint') historyHash = message.history_hash;
    }
    round = message.round;
    entries.push(message);
  }

  for (const [index, line] of (raw ? raw.slice(0, -1).split('\n') : []).entries()) {
    try {
      const message = JSON.parse(line);
      validateMessage(message, index + 1, round);
      remember(message);
    } catch (error) {
      throw new Error(`Room log ${path}, line ${index + 1}: ${error.message}`, { cause: error });
    }
  }

  function append(fields) {
    const message = { ...fields, id: idFor(entries.length + 1), ts: fields.ts ?? new Date().toISOString() };
    validateMessage(message, entries.length + 1, round);
    const line = `${JSON.stringify(message)}\n`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`The room log is locked: ${path}`, { cause: error });
    }
    try {
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) !== size) {
        throw new Error('The room log changed in another process. Reopen the room before sending more messages.');
      }
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600, flush: true });
      size += Buffer.byteLength(line);
      remember(JSON.parse(line));
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
    return message;
  }

  return {
    directory, path, append,
    get round() { return round; },
    get activeStart() { return start; },
    get historyHash() { return historyHash; },
    get length() { return entries.length; },
    activeMessages: (sequence = entries.length) =>
      entries.slice(start, sequence).filter(message => visibleKinds.has(message.kind)),
    transcriptMessages: () => entries.slice(start).filter(message => visibleKinds.has(message.kind) || message.activity),
    records: ({ after = 0, through = entries.length } = {}) => entries.slice(after, through),
    snapshot: () => ({ sequence: entries.length, id: entries.at(-1)?.id ?? null }),
  };
}
