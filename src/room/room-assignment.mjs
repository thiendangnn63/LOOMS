export const taskTypes = ['planning', 'implementation', 'debugging', 'review', 'testing', 'documentation', 'other'];
export const taskType = task => task.task_type ?? (task.kind === 'review' ? 'review' : 'implementation');
const id = /^[a-z][a-z0-9_-]{0,63}$/;
const model = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const count = value => Number.isSafeInteger(value) && value >= 0;
const validProfile = profile => typeof profile?.provider === 'string' && id.test(profile.provider) &&
  typeof profile.model === 'string' && model.test(profile.model) &&
  (profile.effort === null || typeof profile.effort === 'string' && id.test(profile.effort));

export function executionProfile(member, observed) {
  return {
    provider: member.provider,
    model: member.actualModel ?? observed?.model ?? member.model ?? null,
    effort: member.actualEffort ?? observed?.effort ?? member.effort ?? null,
  };
}

const sameProfile = (a, b) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;

export function recordTaskProfile(task, profile) {
  if (!task.execution_profile) task.execution_profile = profile;
  else if (!sameProfile(task.execution_profile, profile)) task.mixed_profiles = true;
}

export function taskOutcomes(job) {
  return job.tasks.flatMap(task => {
    const profile = task.execution_profile;
    if (!validProfile(profile) || task.mixed_profiles || task.fixup_for || task.replaced_by) return [];
    const checks = task.verification_run === task.runs ? task.verification ?? [] : [];
    let result;
    if (task.state === 'done') {
      if (!task.verify.length) result = 'unscored';
      else if (checks.length === task.verify.length && checks.every(check => check.exit_code === 0)) result = 'passed';
    } else if (task.state === 'failed' && checks.some(check => check.exit_code !== 0)) {
      result = 'failed';
    }
    if (!result) return [];
    const tokens = task.usage && task.usage.input_tokens + task.usage.output_tokens;
    return [{ id: task.id, type: taskType(task), profile, result, duration_ms: task.duration_ms ?? 0,
      ...(count(tokens) && tokens > 0 && { tokens }) }];
  });
}

export function assignmentScorecard(records, profiles) {
  const seen = new Set();
  const evidence = new Map(profiles.map(({ name }) => [name, new Map()]));
  for (let index = records.length - 1; index >= 0; index--) {
    const { job_outcomes: sample } = records[index];
    if (!sample) continue;
    for (const outcome of sample.tasks) {
      const key = `${sample.job}:${outcome.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const profile of profiles) {
        if (!profile.model || !sameProfile(profile, outcome.profile)) continue;
        const byType = evidence.get(profile.name);
        const stats = byType.get(outcome.type) ?? { passed: 0, failed: 0, unscored: 0, verified_duration_ms: 0,
          verified_tokens: 0, verified_token_samples: 0 };
        stats[outcome.result]++;
        if (outcome.result === 'passed') {
          stats.verified_duration_ms += outcome.duration_ms;
          if (outcome.tokens !== undefined) {
            stats.verified_tokens += outcome.tokens;
            stats.verified_token_samples++;
          }
        }
        byType.set(outcome.type, stats);
      }
    }
  }
  return Object.fromEntries([...evidence].map(([name, byType]) => [name, Object.fromEntries(byType)]));
}

export function assignmentEvidence(task, assignment) {
  const type = taskType(task);
  const stats = assignment?.scorecard?.[task.agent]?.[type];
  if (stats?.passed || stats?.failed) {
    return `${stats.passed}/${stats.passed + stats.failed} verified in this room`;
  }
  const detail = stats?.unscored ? `${stats.unscored} completed without scored checks` : 'No comparable verified results yet';
  return assignment?.preferences?.[type] === task.agent ? `Room preference · ${detail}` : detail;
}

export function validJobOutcomes(value) {
  return typeof value?.job === 'string' && /^job_\d+$/.test(value.job) && Array.isArray(value.tasks) &&
    value.tasks.every(task => typeof task?.id === 'string' && id.test(task.id) && taskTypes.includes(task.type) &&
      ['passed', 'failed', 'unscored'].includes(task.result) && validProfile(task.profile) && count(task.duration_ms) &&
      (task.tokens === undefined || count(task.tokens)));
}
