const maxFiles = 32;
const maxDiff = 8_000;
const truncated = '… Diff preview truncated.';
const linesOf = text => text === null || text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

function fileDiff(before, after) {
  if (before === undefined || after === undefined) return;
  const oldLines = linesOf(before);
  const newLines = linesOf(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const tooManyLines = oldEnd + newEnd - 2 * start > 300;
  const old = oldLines.slice(start, tooManyLines ? Math.min(oldEnd, start + 150) : oldEnd);
  const next = newLines.slice(start, tooManyLines ? Math.min(newEnd, start + 150) : newEnd);
  if (!old.length && !next.length) return before === null || after === null ? 'Empty file.' : 'Line endings changed.';
  const lengths = Array.from({ length: old.length + 1 }, () => new Uint16Array(next.length + 1));
  for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
    lengths[i][j] = old[i] === next[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const rows = [`@@ -${start + Number(old.length > 0)},${old.length} +${start + Number(next.length > 0)},${next.length} @@`];
  for (let i = 0, j = 0; i < old.length || j < next.length;) {
    if (i < old.length && j < next.length && old[i] === next[j]) { rows.push(` ${old[i++]}`); j++; }
    else if (i < old.length && (j === next.length || lengths[i + 1][j] >= lengths[i][j + 1])) rows.push(`-${old[i++]}`);
    else rows.push(`+${next[j++]}`);
  }
  const diff = rows.join('\n');
  if (!tooManyLines && diff.length <= maxDiff) return diff;
  const limit = maxDiff - truncated.length - 1;
  const end = diff.lastIndexOf('\n', limit);
  const preview = diff.length <= limit ? diff : diff.slice(0, end > diff.indexOf('\n') ? end : limit);
  return `${preview}\n${truncated}`;
}

export function collectActivity() {
  const files = new Map();
  let commands = 0;
  let omitted = false;
  return {
    command() { commands++; },
    file({ path, before, after }) {
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      const previous = files.get(key);
      if (!previous && files.size >= maxFiles) { omitted = true; return; }
      files.set(key, { path, before: previous ? previous.before : before, after });
    },
    summary() {
      const changes = [...files.values()].flatMap(({ path, before, after }) => {
        if (before !== undefined && before === after) return [];
        const kind = before === null ? 'created' : after === null ? 'deleted' : 'edited';
        const diff = fileDiff(before, after);
        return [{ path, kind, ...(diff && { diff }) }];
      });
      return commands || changes.length || omitted ? { commands, files: changes, ...(omitted && { omitted: true }) } : undefined;
    },
  };
}

export function validActivity(value) {
  return value && Number.isSafeInteger(value.commands) && value.commands >= 0 &&
    (value.omitted === undefined || value.omitted === true) && Array.isArray(value.files) && value.files.length <= maxFiles &&
    value.files.every(file => typeof file?.path === 'string' && file.path.length > 0 && file.path.length <= 512 &&
      ['created', 'edited', 'deleted'].includes(file.kind) && (file.diff === undefined || typeof file.diff === 'string' && file.diff.length <= maxDiff));
}

export function fileActivityLabel({ path, kind }) {
  return `${kind[0].toUpperCase() + kind.slice(1)} ${path}`;
}

export function activityRows({ commands, files, omitted }) {
  return [
    ...(commands ? [{ text: `Ran ${commands} shell command${commands === 1 ? '' : 's'}` }] : []),
    ...files.map(file => ({ text: `${fileActivityLabel(file)}  ·  ${file.diff ? 'View diff' : 'Diff unavailable'}`, file })),
    ...(omitted ? [{ text: 'More files changed.' }] : []),
  ];
}

export const activityText = activity => activityRows(activity).map(row => row.text).join('\n');

export function modelChatText(text) {
  let fence;
  let indented = false;
  return text.split(/\r?\n/).flatMap(line => {
    const body = line.replace(/^(?: {0,3}> ?)+/, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+(?=`{3,}|~{3,})/, '');
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      return [];
    }
    if (marker) { fence = marker[1]; indented = false; return ['[Code block hidden]']; }
    if (/^(?: {4,}|\t)\S/.test(body)) {
      if (indented) return [];
      indented = true;
      return ['[Code block hidden]'];
    }
    if (line.trim()) indented = false;
    return [line];
  }).join('\n');
}
