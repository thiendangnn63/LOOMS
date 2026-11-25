import { assignmentEvidence, taskType, taskTypes } from './room-assignment.mjs';

const id = /^[a-z][a-z0-9_-]{0,63}$/;
const skillName = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const contractVersion = /^[a-z][a-z0-9_-]{0,63}@[1-9][0-9]*$/;
const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const hasText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const match = (value, pattern) => typeof value === 'string' && pattern.test(value);
const list = (value, validate, max = 40) => Array.isArray(value) && value.length <= max && value.every(validate);

function keys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}

function ownPath(pattern) {
  return hasText(pattern, 512) && !/[\\:\x00-\x1f<>|\[\]{}!()]/.test(pattern) &&
    pattern.split('/').every(segment => segment && segment !== '.' && segment !== '..' &&
      (!segment.includes('**') || segment === '**'));
}

function segmentsIntersect(left, right) {
  const a = [...left];
  const b = [...right];
  const queue = [[0, 0, false]];
  const visited = new Set();
  for (const [i, j, consumed] of queue) {
    const key = `${i},${j},${consumed}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (i === a.length && j === b.length && consumed) return true;
    if (a[i] === '*') queue.push([i + 1, j, consumed]);
    if (b[j] === '*') queue.push([i, j + 1, consumed]);
    if (i < a.length && j < b.length && (a[i] === b[j] || ['*', '?'].includes(a[i]) || ['*', '?'].includes(b[j]))) {
      queue.push([a[i] === '*' ? i : i + 1, b[j] === '*' ? j : j + 1, true]);
    }
  }
  return false;
}

export function pathsIntersect(left, right) {
  const split = value => (process.platform === 'win32' ? value.toLowerCase() : value).split('/');
  const a = split(left);
  const b = split(right);
  const queue = [[0, 0]];
  const visited = new Set();
  for (const [i, j] of queue) {
    const key = `${i},${j}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (i === a.length && j === b.length) return true;
    if (a[i] === '**') queue.push([i + 1, j]);
    if (b[j] === '**') queue.push([i, j + 1]);
    if (i < a.length && j < b.length && (a[i] === '**' || b[j] === '**' || segmentsIntersect(a[i], b[j]))) {
      queue.push([a[i] === '**' ? i : i + 1, b[j] === '**' ? j : j + 1]);
    }
  }
  return false;
}

export function ownsPath(patterns, path) {
  return ownPath(path) && !/[*?]/.test(path) && patterns.some(pattern => pathsIntersect(pattern, path));
}

function dependencyOrder(dependencies) {
  const ordered = new Set();
  const visiting = new Set();
  function visit(task) {
    if (ordered.has(task)) return;
    if (visiting.has(task)) {
      const cycle = [...visiting];
      return [...cycle.slice(cycle.indexOf(task)), task];
    }
    visiting.add(task);
    for (const parent of dependencies.get(task) ?? []) {
      const cycle = visit(parent);
      if (cycle) return cycle;
    }
    visiting.delete(task);
    ordered.add(task);
  }
  for (const task of dependencies.keys()) {
    const cycle = visit(task);
    if (cycle) return { cycle };
  }
  return { ordered };
}

export function validateRoomPlan(plan, roster) {
  if (!keys(plan, ['goal', 'contracts', 'tasks']) || !hasText(plan.goal, 8000) ||
      !Array.isArray(plan.contracts) || plan.contracts.length > 40 || !Array.isArray(plan.tasks) ||
      plan.tasks.length < 1 || plan.tasks.length > 12) {
    return ['Expected a goal, up to 40 contracts, and 1–12 tasks.'];
  }
  const errors = [];
  const agents = new Set(roster);
  const versions = new Set();
  const dependencies = new Map();
  const tasks = new Map();
  for (const [index, contract] of plan.contracts.entries()) {
    if (!keys(contract, ['id', 'version', 'owner', 'content']) || !match(contract.id, id) || windowsDevice.test(contract.id) ||
        !Number.isSafeInteger(contract.version) || contract.version < 1 || !hasText(contract.content, 48_000)) {
      errors.push(`Contract ${index + 1} has an invalid ID, version, or content.`);
      continue;
    }
    const reference = `${contract.id}@${contract.version}`;
    if (versions.has(reference)) errors.push(`Duplicate contract ${reference}.`);
    if (!agents.has(contract.owner)) errors.push(`Contract ${reference} owner must be a room member.`);
    versions.add(reference);
  }
  for (const [index, task] of plan.tasks.entries()) {
    if (!keys(task, ['id', 'agent', 'title', 'owns', 'depends_on', 'uses_contracts', 'verify', 'kind', 'task_type', 'assignment_reason', 'skill']) ||
        !match(task.id, id) || !hasText(task.title, 800) || (task.kind !== undefined && task.kind !== 'review') ||
        (task.task_type !== undefined && (!taskTypes.includes(task.task_type) || task.kind === 'review' && task.task_type !== 'review')) ||
        (task.assignment_reason !== undefined && !hasText(task.assignment_reason, 400)) ||
        (task.skill !== undefined && !match(task.skill, skillName)) ||
        !list(task.owns, ownPath) || !list(task.depends_on, item => match(item, id), 12) ||
        !list(task.uses_contracts, item => match(item, contractVersion)) || !list(task.verify, item => hasText(item, 2048))) {
      errors.push(`Task ${index + 1} has invalid fields. Use relative ownership paths with *, ?, or **.`);
      continue;
    }
    if (tasks.has(task.id)) errors.push(`Duplicate task ${task.id}.`);
    if (!agents.has(task.agent)) errors.push(`Task ${task.id} agent ${String(task.agent)} is not in the room.`);
    if (task.kind !== 'review' && !task.verify.length) errors.push(`Task ${task.id} is missing a verify command.`);
    for (const reference of task.uses_contracts) if (!versions.has(reference)) {
      errors.push(`Task ${task.id} refers to unknown contract ${reference}.`);
    }
    dependencies.set(task.id, task.depends_on);
    tasks.set(task.id, task);
  }
  for (const [task, deps] of dependencies) {
    for (const dependency of deps) if (!tasks.has(dependency)) errors.push(`Task ${task} depends on unknown task ${dependency}.`);
  }
  const { cycle, ordered } = dependencyOrder(dependencies);
  if (cycle) return [...errors, `Dependency cycle: ${cycle.join(' → ')}.`];
  if (errors.length) return errors;

  const transitives = new Map();
  for (const task of ordered) {
    const direct = dependencies.get(task);
    const parents = new Set(direct.flatMap(parent => [parent, ...transitives.get(parent)]));
    for (const [other, formerParents] of transitives) {
      if (parents.has(other) || formerParents.has(task)) continue;
      const overlap = tasks.get(task).owns.flatMap(a => tasks.get(other).owns.map(b => [a, b]))
        .find(([a, b]) => pathsIntersect(a, b));
      if (overlap) errors.push(`Overlapping owns for ${other} and ${task}: ${overlap[1]} intersects ${overlap[0]}.`);
    }
    transitives.set(task, parents);
  }
  return errors;
}

export function plannerPrompt(goal, roster, errors, assignment) {
  return [
    'Plan the job. Inspect the workspace as needed. Return only one JSON object with this shape:',
    '{"goal":"...","contracts":[{"id":"api","version":1,"owner":"codex","content":"..."}],"tasks":[{"id":"backend","agent":"codex","title":"...","task_type":"implementation","assignment_reason":"...","owns":["server/**"],"depends_on":[],"uses_contracts":["api@1"],"verify":["npm test"]}]}',
    `Available room members and vendors: ${roster.map(member => `${member.name} (${member.provider})`).join(', ')}.`,
    ...(assignment ? [
      'Inspect relevant files and existing checks with the read-only workspace tools when available. Identify the actual work before allocating it.',
      `Classify each task as one of ${taskTypes.join(', ')} and give a short assignment_reason grounded in the project and supplied capabilities. An optional skill names one assigned skill from that agent’s list. Keep tasks within their available tools and permissions.`,
      'Use the recorded outcomes for comparable task types and model configurations as evidence. Completion without scored checks gives no quality measurement. Use room preferences when evidence is sparse and say when a choice is a judgment call. The user will see the measured counts separately.',
      `Current room capabilities, preferences, and verified task evidence (JSON):\n${JSON.stringify(assignment)}`,
    ] : []),
    'Define shared interfaces, types, and paths as contracts before planning tasks. Treat a shared contract as an agreement that enables parallel work. Add a dependency only when a task needs another task’s finished output.',
    'Include every file a task writes in its owns list. Use relative paths with *, ?, or **. Tasks with overlapping ownership must be ordered by a dependency. Give shared config and lockfiles one owner.',
    'Give every non-review task at least one verify command. If the repo needs verification setup, add a task that sets it up and verifies it, then make other tasks that use it depend on setup.',
    'Aim for 2–8 tasks with a hard limit of 12. Prefer a final task with kind "review" assigned to a different vendor from the main implementation vendor. Review tasks can have empty owns and verify lists.',
    ...(errors?.length ? [`Fix all validation errors from the previous plan:\n${errors.map(error => `- ${error}`).join('\n')}`] : []),
    `Goal:\n${goal}`,
  ].join('\n\n');
}

export function displayPlan(plan, { vertical = false } = {}) {
  const assignment = plan.assignment_context;
  const rationale = task => [task.assignment_reason, assignmentEvidence(task, assignment)].filter(Boolean).join(' · ');
  if (vertical) {
    return [plan.goal, `${plan.state.replaceAll('_', ' ')} · planner @${plan.planner}`, '', ...plan.tasks.flatMap(task => {
      const profile = assignment?.profiles?.find(agent => agent.name === task.agent);
      const identity = [profile?.model, profile?.effort && `${profile.effort} effort`].filter(Boolean).join(' · ');
      return [
        `${task.title} · @${task.agent}${identity ? ` · ${identity}` : ''}`,
        `${task.id} · ${taskType(task)} · ${task.state}`,
        rationale(task),
        ...(task.skill ? [`Skill /${task.skill}`] : []),
        ...(task.depends_on.length ? [`After ${task.depends_on.join(', ')}`] : []),
        ...(task.blocked_on ? [`Blocked on ${task.blocked_on.task ?? task.blocked_on.question}`] : []),
        ...(task.uses_contracts.length ? [`Contracts ${task.uses_contracts.join(', ')}`] : []),
        ...(task.owns.length ? [`Owns ${task.owns.join(', ')}`] : []),
        ...(task.verify.length ? [`Verify ${task.verify.join(' · ')}`] : []),
        ...(task.usage ? [`${task.usage.input_tokens} input · ${task.usage.output_tokens} output tokens`] : []),
        '',
      ];
    })].join('\n');
  }
  const cell = value => value.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
  const rows = plan.tasks.map(task => [task.id, `@${task.agent}`, task.title, task.state, task.depends_on.join(', '),
    task.blocked_on?.task ?? task.blocked_on?.question, task.owns.join(', '), task.verify.join(' · '),
    task.usage && `${task.usage.input_tokens + task.usage.output_tokens}${task.usage.cost_usd === undefined ? '' : ` / $${task.usage.cost_usd.toFixed(4)}`}`]
    .map(value => cell(value || '—')));
  return [plan.goal, '', '| Task | Agent | Title | State | Dependencies | Blocked on | Owned paths | Verify | Tokens / cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`), '', ...plan.tasks.map(task =>
      `- ${task.id} · ${taskType(task)} · ${rationale(task)}${task.skill ? ` · skill /${task.skill}` : ''}`)].join('\n');
}
