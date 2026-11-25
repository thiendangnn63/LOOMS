import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createPlanStore(directory) {
  const jobPath = join(directory, 'job.json');
  const settingsPath = join(directory, 'planning.json');

  function read(path) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return null;
    if (!entry.isFile()) throw new Error(`Invalid room planning file ${path}.`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  function write(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    try { renameSync(temporary, path); }
    catch (error) { unlinkSync(temporary); throw error; }
  }

  function updateSettings(change) {
    const settings = read(settingsPath) ?? {};
    change(settings);
    write(settingsPath, settings);
  }

  return {
    load() {
      const job = read(jobPath);
      if (job && job.version !== 1) throw new Error('The existing job file does not use this room plan format.');
      return job;
    },
    save(job) { write(jobPath, job); },
    saveMetrics(metrics) { write(join(directory, 'metrics.json'), metrics); },
    planner() {
      const job = read(jobPath);
      return job?.version === 1 && job.state !== 'cancelled' ? job.planner : undefined;
    },
    autoApprove: () => read(settingsPath)?.auto_approve === true,
    setAutoApprove(value) { updateSettings(settings => { settings.auto_approve = value; }); },
    preferredAgents: () => read(settingsPath)?.preferred_agents ?? {},
    setPreferredAgent(type, agent) {
      updateSettings(settings => {
        const preferred = settings.preferred_agents ??= {};
        if (agent) preferred[type] = agent;
        else delete preferred[type];
      });
    },
  };
}
