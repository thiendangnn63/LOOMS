const turnBudget = 20;
const jsonOnly = 'Reply with one JSON object, with no prose outside it.';

function parseObject(reply) {
  const text = reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The caller reports the failed turn and leaves it available for retry.
  }
  throw new Error('Expected a JSON object from the model.');
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function planJob(job, turn) {
  const roster = [...job.members].map(([name, member]) => `@${name} (${member.model ?? member.provider})`).join(', ');
  const reply = await turn(job.lead,
    `Divide this task among suitable members of the room. Available: ${roster}.\n\nTask:\n${job.task}\n\n` +
    'Give each selected member one distinct responsibility, leaving independent work they can start in parallel. ' +
    'Include more than one member if useful. Workers can ask each other for missing results during the job. ' +
    `${jsonOnly} Format: {"assignments":[{"agent":"name without @","task":"specific responsibility"}]}.`);
  const { assignments } = parseObject(reply);
  if (!Array.isArray(assignments) || !assignments.length) throw new Error('The plan contains no assignments.');
  const workers = new Map();
  for (const assignment of assignments) {
    const name = assignment?.agent;
    if (!job.members.has(name) || workers.has(name) || !hasText(assignment.task)) {
      throw new Error('The plan must assign each selected room member one non-empty task.');
    }
    workers.set(name, { task: assignment.task.trim(), prompt: 'Start with the work you can do independently.', version: 0 });
  }
  return workers;
}

async function work(job, name, worker, { turn, report, publish, coordinate = publish }) {
  const peers = [...job.workers].filter(([peer]) => peer !== name)
    .map(([peer, assignment]) => `@${peer}: ${assignment.task}`).join('\n');
  const reply = await turn(name,
    `Job ${job.id}. User task: ${job.task}\nYour assignment: ${worker.task}\n` +
    `Other assignments:\n${peers || '(none)'}\n\n${worker.prompt}\n\n` +
    'If a peer’s result, correction, or answer is needed, finish what you can now and ask that peer. ' +
    'After any handoff, check whether it meets your needs and ask another specific question if necessary. ' +
    `${jsonOnly} Use {"action":"done","text":"your completed contribution"} or ` +
    '{"action":"ask","to":"peer name without @","text":"specific request","progress":"what you completed before waiting"}.');
  const { action, to, text, progress } = parseObject(reply);
  if (!hasText(text) || (action !== 'done' && (action !== 'ask' || to === name || !job.workers.has(to)))) {
    throw new Error('Expected a completed contribution or a request to another assigned model.');
  }
  delete worker.prompt;
  worker.version++;
  if (action === 'done') {
    worker.result = text.trim();
    publish(name, worker.result);
    return;
  }
  const checkpoint = hasText(progress) ? progress.trim() : undefined;
  const request = { from: name, to, question: text.trim(), checkpoint, checkedVersion: -1 };
  job.requests.add(request);
  job.hops = (job.hops ?? 0) + 1;
  if (checkpoint) publish(name, checkpoint);
  coordinate(name, `@${to}, ${request.question}`);
  report(`@${name} is waiting for @${to}. Monitor armed.`);
}

async function checkDelivery(job, request, { turn, publish, coordinate = publish, report }) {
  const { from, to, question, checkpoint } = request;
  const reply = await turn(to,
    `Job ${job.id}. @${from} asks: ${question}\n\n` +
    'Dependency delivered? Use what you already know or do the extra work now if possible. ' +
    'Answer YES only if you can include the actual usable result, revision, or answer now. ' +
    `Otherwise answer NO and explain what is missing. ${jsonOnly} Format: {"status":"YES or NO","text":"result or blocker"}.`);
  const { status, text } = parseObject(reply);
  if ((status !== 'YES' && status !== 'NO') || !hasText(text)) {
    throw new Error('Expected YES or NO with a result or blocker.');
  }
  coordinate(to, `@${from} — ${status}: ${text.trim()}`);
  if (status === 'NO') return;

  job.requests.delete(request);
  job.workers.get(from).prompt =
    `Resume after your request to @${to}: ${question}\n` +
    (checkpoint ? `Your checkpoint: ${checkpoint}\n` : '') +
    `Dependency delivered — YES. @${to} replied:\n${text.trim()}`;
  report(`Monitor received YES from @${to}. Waking @${from}.`);
}

export async function runRoomJob(job, io) {
  const { turn, report, publish, shouldStop } = io;
  job.state = 'planning';
  if (!job.workers) {
    report(`@${job.lead} is dividing the task.`);
    job.workers = await planJob(job, turn);
    for (const [name, { task }] of job.workers) report(`@${name}: ${task}`);
  }

  job.state = 'running';
  const running = new Map();
  const failedWorkers = new Set();
  let hadError = false;
  let turns = 0;
  // An explicit retry may recheck pending requests once. Automatic checks wait for fresh peer progress.
  for (const request of job.requests) request.checkedVersion = -1;
  while (true) {
    if (!shouldStop()) {
      for (const [name, worker] of job.workers) {
        if (turns >= turnBudget) break;
        if (running.has(name) || failedWorkers.has(name)) continue;
        const request = [...job.requests].find(item => item.to === name && item.checkedVersion < worker.version);
        if (!worker.prompt && !request) continue;
        const isWork = Boolean(worker.prompt);
        if (!isWork) request.checkedVersion = worker.version;
        const started = Date.now();
        if (isWork) worker.runs = (worker.runs ?? 0) + 1;
        const operation = isWork ? work(job, name, worker, io) : checkDelivery(job, request, io);
        turns++;
        running.set(name, operation.catch(error => {
          if (isWork) failedWorkers.add(name);
          hadError = true;
          report(`@${name} ${isWork ? 'work' : 'delivery check'} failed: ${error.message}`);
        }).finally(() => {
          if (isWork) worker.duration_ms = (worker.duration_ms ?? 0) + Date.now() - started;
          running.delete(name);
        }));
      }
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }

  if (shouldStop()) return;
  if ([...job.workers.values()].some(worker => !worker.result)) {
    const waiting = [...job.requests].map(({ from, to }) => `@${from} → @${to}`).join(', ');
    job.state = hadError ? 'failed' : turns >= turnBudget ? 'paused' : 'blocked';
    const reason = job.state === 'paused' ? 'Automatic turn limit reached. ' : '';
    report(`${reason}${waiting ? `Pending monitors: ${waiting}. ` : ''}Use /retry ${job.id} to resume.`);
    return;
  }

  if (job.workers.size > 1) {
    job.state = 'summarizing';
    const contributions = [...job.workers].map(([name, { result }]) => `@${name}:\n${result}`).join('\n\n');
    const final = await turn(job.lead,
      `Answer the original user task using the completed contributions. Give the final answer, not a status report.\n\n` +
      `Task:\n${job.task}\n\nContributions:\n${contributions}`, true);
    publish(job.lead, final, false);
  }
  job.state = 'complete';
  report('Complete.');
}
