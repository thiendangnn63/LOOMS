import { resolveProvider } from './room-services.mjs';

export function mentionedMembers(text, names) {
  const mentions = [...text.matchAll(/(?<![\w@-])@([a-z][a-z0-9_-]*)/gi)].map(match => match[1].toLowerCase());
  return [...new Set(mentions.filter(name => names.includes(name)))];
}

export function parseRoomChain(text, roster) {
  const member = value => {
    const name = value?.toLowerCase();
    const resolved = roster.includes(name) ? name : resolveProvider(name);
    return roster.includes(resolved) ? resolved : undefined;
  };
  const lead = /^(?:@|\(@\))?([a-z][\w-]*)[ \t]+/i.exec(text);
  const first = member(lead?.[1]);
  if (!first) return;

  const handoff = /(?:[ \t,;]+(?:and\s+)?then\b|[ \t,;]+after\s+you(?:'re|\s+are)\s+done\b|\s*(?:->|→))\s*(?:(?:let|have|ask|ping|hand off to|pass it to)\s+)?(?:@|\(@\))?([a-z][\w-]*)\s+(?:to\s+)?/gi;
  const steps = [];
  let agent = first;
  let start = lead[0].length;
  for (const match of text.matchAll(handoff)) {
    const next = member(match[1]);
    const instruction = text.slice(start, match.index).trim();
    if (!next || !instruction || next === agent) continue;
    steps.push({ agent, instruction });
    agent = next;
    start = match.index + match[0].length;
  }
  const final = text.slice(start).trim();
  if (steps.length && final) return [...steps, { agent, instruction: final }];

  const dependent = /^(critique|review|evaluate|assess|verify|test)\s+(.+?)\s+(?:that|which)\s+(?:@|\(@\))?([a-z][\w-]*)\s+(?:will|should|is going to)\s+([a-z]+)\b([\s\S]*)$/i.exec(text.slice(lead[0].length));
  const producer = member(dependent?.[3]);
  if (!producer || producer === first) return;
  const [, review, artifact, , verb, details] = dependent;
  return [
    { agent: producer, instruction: `${verb} ${artifact}${details}` },
    { agent: first, instruction: `${review} ${artifact} from the preceding step. Apply any review criteria in the original request.` },
  ];
}

export function formatChainStep(step) {
  return [
    `Ordered step ${step.number} of ${step.total}: ${step.instruction}`,
    'Complete your assigned step. LOOMS handles the next handoff.',
    step.previous && `Output from the previous step (@${step.previous.speaker}):\n${step.previous.text}`,
  ].filter(Boolean).join('\n\n');
}

export function buildPrompt(name, names, updates, { catchUp = false, cwd } = {}) {
  const peers = names.filter(other => other !== name).map(other => `@${other}`).join(', ') || 'no other models';
  const transcript = updates.map(({ speaker, text }) => `[${speaker}] ${text}`).join('\n\n');
  const heading = catchUp ? 'Conversation so far as you join or rejoin:' : 'New messages since your last turn:';
  return `You are @${name} in a group chat with the user and ${peers}.\n` +
    (cwd ? `Workspace: ${cwd}\n` : '') +
    `${heading}\n${transcript}\n\n` +
    'Reply to the conversation briefly. You may respond to the other models by @name. ' +
    'If you have nothing useful to add, reply with exactly PASS.';
}

export function createChatRoom({ ask, prepare, cwd, maxTurns = 6, history = [], append }) {
  const logDetails = message => message?.activity ? { activity: message.activity, ...(message.kind === 'event' && { activityOnly: true }) } : {};
  const transcript = history.map(({ from, speaker, text, ts, round, ...details }, index) => ({
    id: index + 1, speaker: from ?? speaker, text, ts: ts ?? new Date().toISOString(), ...(round !== undefined && { round }),
    ...logDetails(details),
  }));
  const seen = new Map();

  function post(speaker, text, onMessage, details) {
    const message = append?.(speaker, text, details);
    const entry = { id: transcript.length + 1, speaker, text, ts: message?.ts ?? new Date().toISOString(),
      ...(message && { round: message.round }), ...logDetails(message) };
    transcript.push(entry);
    onMessage?.(entry);
    return entry;
  }

  async function send(names, text, onMessage = () => {}, onStatus = onMessage, { directed = false, roster = names, chain, skill } = {}) {
    if (!names.length) throw new Error('The room is empty. Use /add to add a model.');
    const trigger = post('user', text, onMessage, { to: directed ? [...new Set(names)] : [] });
    const priorities = mentionedMembers(text, names);
    const quiet = new Set();
    const failures = new Map();
    let last;
    let peers = [];
    let previousStep;
    const budget = chain?.length ?? (directed ? names.length : maxTurns);
    for (let turn = 0; turn < budget; turn++) {
      const start = names.indexOf(last) + 1;
      const order = [...names.slice(start), ...names.slice(0, start)];
      const name = chain?.[turn].agent ?? (directed ? names[turn] : [...priorities, ...peers, ...order].find(candidate =>
        candidate !== last && !quiet.has(candidate) && (failures.get(candidate) ?? 0) < 2));
      if (!name) break;
      const priority = priorities.indexOf(name);
      if (priority !== -1) priorities.splice(priority, 1);
      peers = [];
      last = name;
      if (prepare?.(name) === false) seen.delete(name);
      const cursor = seen.get(name);
      const end = transcript.length;
      const updates = transcript.slice(cursor ?? 0, end).filter(entry => !entry.activityOnly && (cursor === undefined || entry.speaker !== name));
      if (!updates.length && !chain) {
        quiet.add(name);
        continue;
      }
      let reply;
      try {
        const catchUp = cursor === undefined;
        const step = chain && { ...chain[turn], number: turn + 1, total: budget, previous: previousStep };
        const prompt = buildPrompt(name, roster, updates, { catchUp, cwd });
        reply = String(await ask(name, step ? `${prompt}\n\n${formatChainStep(step)}` : prompt, {
          updates, catchUp, trigger: chain || updates.includes(trigger) ? trigger : undefined, step, skill,
        }) ?? '').trim();
        if (seen.get(name) === cursor) seen.set(name, end);
        failures.delete(name);
      } catch (error) {
        failures.set(name, (failures.get(name) ?? 0) + 1);
        onStatus({ speaker: 'system', text: `@${name} failed: ${error.message}` });
        if (chain) break;
      }
      if (!reply || /^PASS\.?$/i.test(reply)) {
        quiet.add(name);
        previousStep = undefined;
        continue;
      }
      quiet.clear();
      previousStep = post(name, reply, onMessage);
      peers = mentionedMembers(reply, names);
    }
  }

  return { transcript, post, send, forget: name => seen.delete(name) };
}
