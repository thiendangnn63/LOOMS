const terminal = new Set(['done', 'failed', 'cancelled']);
const elapsedOutput = output => String(output ?? '').split(/\r?\n/).slice(-200).join('\n').slice(-60_000);
export const approvalDenied = 'ROOM_APPROVAL_DENIED';

export function withRoomDeadline(operation, signal, timeoutMs, label, waitForCleanup = false) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const error = () => timeout.aborted ? new Error(`${label} timed out.`) : combined.reason;
  const work = Promise.resolve().then(() => {
    if (combined.aborted) throw error();
    return operation(combined);
  });
  if (waitForCleanup) return work.then(result => {
    if (combined.aborted) throw error();
    return result;
  }, cause => { throw combined.aborted ? error() : cause; });
  let stop;
  const interruption = new Promise((_, reject) => {
    stop = () => reject(error());
    combined.addEventListener('abort', stop, { once: true });
  });
  return Promise.race([work, interruption]).finally(() => combined.removeEventListener('abort', stop));
}

export async function runRoomSchedule(job, {
  run, verify, approveVerification, onVerificationCommands, change, currentRound, settleQuestions = async () => {}, hasAnswer = () => false,
  snapshot, signal, isolation, runTimeout = 15 * 60_000, wallLimit = 2 * 60 * 60_000, retries = 2,
}) {
  const tasks = new Map(job.tasks.map(task => [task.id, task]));
  const active = new Map();
  const activeAgents = new Set();
  const started = Date.parse(job.started_at ?? '') || Date.now();
  job.started_at ??= new Date(started).toISOString();
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(new Error('Job wall-clock limit reached.')), Math.max(0, started + wallLimit - Date.now()));
  const stop = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
  job.usage ??= { input_tokens: 0, output_tokens: 0, by_agent: {} };

  function transition(task, state, fields = {}) {
    Object.assign(task, fields, { state });
    change(`task.${state}`, task);
  }

  function fail(task, reason) {
    const failures = (task.failures ?? 0) + 1;
    const next = failures <= retries ? 'ready' : 'failed';
    transition(task, next, { reason, failures, retries: (task.retries ?? 0) + Number(next === 'ready') });
  }

  function fixConflict(task, conflict) {
    if (task.fixup_for) {
      transition(task, 'failed', { reason: `merge_conflict: ${conflict.paths.join(', ')}` });
      return;
    }
    let id;
    for (let index = 1; !id || tasks.has(id); index++) id = `fix_${task.id.slice(0, 50)}_${index}`;
    const fix = { id, agent: task.agent, title: `Resolve the merge conflict in ${conflict.paths.join(', ')}`,
      owns: task.owns, depends_on: [...task.depends_on], uses_contracts: task.uses_contracts, verify: task.verify,
      state: 'pending', fixup_for: task.id, merge_source: conflict.source };
    tasks.set(id, fix);
    job.tasks.push(fix);
    for (const dependent of tasks.values()) {
      dependent.depends_on = dependent.depends_on.map(parent => parent === task.id ? id : parent);
      if (dependent.blocked_on?.task === task.id) dependent.blocked_on.task = id;
    }
    transition(task, 'failed', { reason: `merge_conflict: ${conflict.paths.join(', ')}`, replaced_by: id });
    change('task.fixup_created', fix);
  }

  function track(task, usage) {
    if (!usage) return;
    const { by_agent } = job.usage;
    if (!Object.hasOwn(by_agent, task.agent)) by_agent[task.agent] = { input_tokens: 0, output_tokens: 0 };
    const agent = by_agent[task.agent];
    task.usage ??= { input_tokens: 0, output_tokens: 0 };
    for (const key of ['input_tokens', 'output_tokens', 'cost_usd']) {
      if (!Number.isFinite(usage[key]) || usage[key] < 0) continue;
      for (const target of [job.usage, agent, task.usage]) target[key] = (target[key] ?? 0) + usage[key];
    }
  }

  function updateLimits() {
    if (!job.token_budget) return false;
    const used = job.usage.input_tokens + job.usage.output_tokens;
    if (used >= job.token_budget * 0.8 && job.budget_warning !== job.token_budget) {
      job.budget_warning = job.token_budget;
      change('job.budget_warning');
    }
    return used >= job.token_budget;
  }

  function dependenciesReady(task) {
    return task.depends_on.every(id => tasks.get(id).state === 'done');
  }

  function ready() {
    for (const task of tasks.values()) {
      if (!dependenciesReady(task)) continue;
      const blocker = task.blocked_on;
      if (task.state === 'pending' || task.state === 'blocked' && (blocker?.question && hasAnswer(blocker.question) ||
          blocker?.task && tasks.get(blocker.task)?.state === 'done')) {
        transition(task, 'ready', { resumed_from: blocker, blocked_on: undefined, reason: undefined });
      }
    }
  }

  async function attempt(task, cutoff) {
    const started = Date.now();
    let disposition;
    let workspace;
    let commands = 0;
    const finish = result => {
      if (disposition) throw new Error('The task has already submitted an outcome for this run.');
      disposition = result;
    };
    try {
      const usage = await withRoomDeadline(async scope => {
        workspace = await isolation?.begin(task, scope);
        return run(task, { signal: scope, finish, snapshot: cutoff, workspace });
      }, stop, runTimeout, 'Agent run', Boolean(isolation));
      track(task, usage);
      if (stop.aborted) throw stop.reason;
      if (!disposition) throw new Error('The agent ended its run without a task outcome.');
      if (disposition.blocked_on) {
        transition(task, 'blocked', { blocked_on: disposition.blocked_on, reason: disposition.reason });
        return;
      }
      transition(task, 'verifying', { summary: disposition.summary, artifacts: disposition.artifacts, verification: [], verification_run: task.runs });
      for (const command of task.verify) {
        let launched = false;
        const onStart = () => {
          if (!launched) commands++;
          launched = true;
        };
        const result = await withRoomDeadline(async scope => {
          await approveVerification?.(task, command, scope);
          scope.throwIfAborted();
          return workspace ? workspace.verify(command, scope, onStart) : verify(task, command, scope, onStart);
        },
          stop, runTimeout, 'Verification', Boolean(workspace));
        onStart();
        const output = elapsedOutput(result.output);
        task.verification.push({ command, exit_code: result.code, output });
        if (result.code !== 0) task.verify_failures = (task.verify_failures ?? 0) + 1;
        change('task.verification', task);
        if (result.code !== 0) throw new Error(`Verification exited ${result.code}: ${command}\n${output}`);
      }
      if (workspace?.finish) await withRoomDeadline(workspace.finish, stop, runTimeout, 'Git integration', true);
      transition(task, 'done', { done_round: currentRound(), reason: undefined });
    } catch (error) {
      if (stop.aborted) transition(task, 'cancelled', { reason: stop.reason?.message });
      else if (error.code === approvalDenied) transition(task, 'failed', { reason: error.message });
      else if (error.mergeConflict) fixConflict(task, error.mergeConflict);
      else fail(task, error.message);
    } finally {
      task.duration_ms = (task.duration_ms ?? 0) + Date.now() - started;
      await workspace?.close?.();
      if (commands) onVerificationCommands?.(task, commands);
    }
  }

  try {
    job.state = 'running';
    change('job.running');
    while (!stop.aborted) {
      ready();
      const overBudget = updateLimits();
      if (!overBudget) {
        const cutoff = snapshot?.();
        for (const task of tasks.values()) {
          if (task.state !== 'ready' || activeAgents.has(task.agent)) continue;
          activeAgents.add(task.agent);
          transition(task, 'running', { runs: (task.runs ?? 0) + 1 });
          const work = attempt(task, cutoff);
          active.set(task.id, work);
          const clean = () => {
            active.delete(task.id);
            activeAgents.delete(task.agent);
          };
          void work.then(clean, clean);
        }
      }
      if (active.size) {
        await Promise.race(active.values());
        continue;
      }
      if (overBudget && job.tasks.some(task => !terminal.has(task.state))) {
        job.state = 'paused';
        change('job.paused');
        return;
      }
      await settleQuestions(stop);
      if (stop.aborted) break;
      ready();
      if (job.tasks.some(task => task.state === 'ready')) continue;
      if (job.tasks.every(task => task.state === 'done' || tasks.get(task.replaced_by)?.state === 'done')) job.state = 'done';
      else if (job.tasks.some(task => !terminal.has(task.state))) job.state = 'stalled';
      else job.state = 'failed';
      change(`job.${job.state}`);
      return;
    }
    for (const task of tasks.values()) {
      if (!terminal.has(task.state)) transition(task, 'cancelled', { reason: stop.reason?.message });
    }
    job.state = 'cancelled';
    change('job.cancelled');
  } finally {
    clearTimeout(timer);
  }
}
