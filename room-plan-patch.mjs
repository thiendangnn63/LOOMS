import { isDeepStrictEqual } from 'node:util';

const own = Object.hasOwn;

function pointer(path) {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('Invalid JSON Pointer.');
  const parts = path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Invalid JSON Pointer key.');
  return parts;
}

function lookup(parent, segment, add = false) {
  if (Array.isArray(parent)) {
    if (add && segment === '-') return parent.length;
    if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= parent.length + Number(add)) {
      throw new Error(`Array index ${segment} is outside the plan.`);
    }
    return Number(segment);
  }
  if (!parent || typeof parent !== 'object' || (!add && !own(parent, segment))) {
    throw new Error(`Plan path ${segment} does not exist.`);
  }
  return segment;
}

function locate(plan, path, add) {
  const parent = path.slice(0, -1).reduce((node, part) => node[lookup(node, part)], plan);
  return [parent, lookup(parent, path.at(-1), add)];
}

function get(plan, path) {
  if (!path.length) return plan;
  const [parent, key] = locate(plan, path);
  return parent[key];
}

function update(plan, path, op, value) {
  if (!path.length) return op === 'remove' ? undefined : value;
  const [parent, key] = locate(plan, path, op === 'add');
  if (op === 'remove') {
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  } else if (op === 'add' && Array.isArray(parent)) {
    parent.splice(key, 0, value);
  } else {
    parent[key] = value;
  }
  return plan;
}

export function patchRoomPlan(plan, patch) {
  if (!Array.isArray(patch) || !patch.length || patch.length > 100) throw new Error('Expected a JSON Patch array of 1–100 operations.');
  let draft = structuredClone(plan);
  for (const item of patch) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid JSON Patch operation.');
    const { op, path, from, value } = item;
    const target = pointer(path);
    if (['add', 'replace', 'test'].includes(op) && !own(item, 'value')) throw new Error(`${op} requires a value.`);
    switch (op) {
      case 'test':
        if (!isDeepStrictEqual(get(draft, target), value)) throw new Error(`Plan patch test failed at ${path}.`);
        break;
      case 'move':
      case 'copy': {
        const source = pointer(from);
        if (op === 'move' && target.length > source.length && source.every((segment, index) => segment === target[index])) {
          throw new Error('A plan patch cannot move a value inside itself.');
        }
        const original = structuredClone(get(draft, source));
        if (op === 'move') draft = update(draft, source, 'remove');
        draft = update(draft, target, 'add', original);
        break;
      }
      case 'add':
      case 'remove':
      case 'replace':
        draft = update(draft, target, op, structuredClone(value));
        break;
      default:
        throw new Error(`Unsupported plan patch operation ${String(op)}.`);
    }
  }
  return draft;
}
