export function recordJobUsage(job, agent, usage) {
  const meter = job.measurements ??= { tokens: { summarizer: 0 }, cost_usd: 0, unpriced_runs: 0 };
  const tokens = [usage?.input, usage?.output].filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  if (tokens) meter.tokens[agent] = (Object.hasOwn(meter.tokens, agent) ? meter.tokens[agent] : 0) + tokens;
  if (Number.isFinite(usage?.costUsd)) meter.cost_usd += usage.costUsd;
  else meter.unpriced_runs++;
}

export function jobMetrics(job) {
  const legacy = typeof job.id === 'number';
  const started = Date.parse(job.created_at ?? job.started_at);
  const { tokens = { summarizer: 0 }, cost_usd, unpriced_runs } = job.measurements ?? {};
  const tasks = legacy ? [...(job.workers ?? [])].map(([id, worker]) => ({ ...worker, id,
    state: worker.result ? 'done' : job.state === 'failed' ? 'failed' : 'blocked' })) : job.tasks;
  return {
    job_id: legacy ? `legacy_${job.id}` : job.id, mode: 'job', success: ['done', 'complete'].includes(job.state),
    wall_clock_s: Number.isFinite(started) ? Math.max(0, Date.now() - started) / 1000 : 0,
    tokens, cost_usd: unpriced_runs || cost_usd === undefined ? null : cost_usd,
    verify_failures: tasks.reduce((sum, task) => sum + (task.verify_failures ?? 0), 0),
    retries: job.retries ?? tasks.reduce((sum, task) => sum + (task.retries ?? 0), 0), hops: job.hops ?? 0,
    tasks: tasks.map(({ id, state, runs = 0, duration_ms = 0 }) => ({ id, state, runs, duration_s: duration_ms / 1000 })),
  };
}
