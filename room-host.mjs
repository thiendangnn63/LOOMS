import { createChatRoom, formatChainStep, mentionedMembers, parseRoomChain } from './chat-room.mjs';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimatePreviewTokens, optionalPreviewSections, previewSection, stalePreview } from './looms-preview.mjs';
import { runRoomJob } from './room-job.mjs';
import { defaultProviders, providerLabels, providers, resolveProvider, roomAccessLabel } from './room-services.mjs';
import { parseProviderCommand, providerCommandCatalog } from './room-provider-commands.mjs';
import { openRoomLog } from './room-log.mjs';
import { createRoomSummary } from './room-summary.mjs';
import { createRoomContracts } from './room-contracts.mjs';
import { displayPlan, plannerPrompt, validateRoomPlan } from './room-plan.mjs';
import { patchRoomPlan } from './room-plan-patch.mjs';
import { createPlanStore } from './room-plan-store.mjs';
import { approvalDenied, runRoomSchedule, withRoomDeadline } from './room-scheduler.mjs';
import { openRoomIsolation } from './room-isolation.mjs';
import { jobMetrics, recordJobUsage } from './room-metrics.mjs';
import { assignmentScorecard, executionProfile, recordTaskProfile, taskOutcomes, taskTypes } from './room-assignment.mjs';
import { isProtectedPath, ownedWorkspace, readableWorkspace } from './room-workspace.mjs';
import { describeActions, describeExternalMcp, externalMcpActions, externalMcpActionsFor, readTextAction, runExternalMcpAction, validateAction } from './room-tools.mjs';
import { collectActivity } from './room-activity.mjs';

const memberName = /^[a-z][a-z0-9_-]*$/;
const modelName = /^[a-z0-9][a-z0-9._:/-]*$/i;
const effortName = /^[a-z][a-z0-9-]*$/;
const aliases = ['all', 'both'];
const chatActions = ['room.post', 'room.ask', 'room.answer', 'room.read_log', 'room.decide', 'contract.propose'];
const workspaceReadActions = ['workspace.list', 'workspace.read_text'];
const sequenceOf = id => Number(id?.slice(4));

function addUsage(total, usage) {
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (Number.isFinite(value) && value >= 0) total[key] = (total[key] ?? 0) + value;
  }
}

function workspaceOperation(operation) {
  try { return operation(); }
  catch (error) {
    // Filesystem errors can include host paths and usernames.
    if (typeof error.path === 'string') throw new Error(`Workspace file operation failed (${error.code}).`);
    throw error;
  }
}

export function createRoomHost({ cwd, writeEnabled = false, adapters, history = [], emit = () => {}, onTurn,
  roomID, nativeHistoryHash, contextMessages = 12, summarize, hopLimit = 4, subagentLimit = 0,
  taskExecution, liveTasks = false, workspaceTools = false, protectedPaths = [], askBeforeChanges = false, requestApproval,
  trackActivity = false, externalMcp, resolveSkill, describeMember,
  initialMembers = defaultProviders.map(provider => ({ name: provider, provider })) }) {
  if (!Number.isSafeInteger(contextMessages) || contextMessages < 1) throw new Error('Invalid room context window.');
  if (!Number.isSafeInteger(hopLimit) || hopLimit < 0) throw new Error('Invalid room hop limit.');
  const log = roomID ? openRoomLog(cwd, roomID) : undefined;
  if (liveTasks && log) taskExecution ??= { open: openRoomIsolation };
  if (log && (log.length === 0 || nativeHistoryHash && nativeHistoryHash !== log.historyHash)) {
    if (log.length) log.append({ round: log.round, from: 'system', to: [], kind: 'event', text: 'conversation.rebased' });
    for (const { speaker, text, ts } of history) {
      log.append({ round: log.round, from: speaker, to: [], kind: 'chat', text, ts });
    }
  }
  const members = new Map(initialMembers.map(({ name, ...member }) => [name, { ...member }]));
  const jobs = new Map();
  const previews = new WeakMap();
  let rosterRevision = 0;
  const summary = log && createRoomSummary({ roomID, log, summarize,
    report: text => emit({ type: 'status', label: 'summary', text, error: true }) });
  const plans = log && createPlanStore(log.directory);
  const usageByMember = new Map();
  const activityByMember = new Map();
  const shutdown = new AbortController();
  let nextJobId = 1;
  let pending = Promise.resolve();
  let closed = false;
  let round;
  let planningAdapter;
  let runningJob;
  const canChange = () => writeEnabled || askBeforeChanges;

  async function approveAction(request, signal) {
    const scope = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal;
    scope.throwIfAborted();
    const approved = await requestApproval?.(Object.freeze(request), scope) === true;
    scope.throwIfAborted();
    event(`approval.${approved ? 'allowed_once' : 'denied'} @${request.agent} ${request.action}`,
      request.taskID ? { task_id: request.taskID } : {});
    if (!approved) throw Object.assign(new Error(`Approval denied for ${request.action === 'verify' ? 'the verification command' : 'the file change'}.`),
      { code: approvalDenied });
  }

  function roomPrompt(name, prompt, chat, options, scope, snapshot = options?.control?.snapshot ?? log.snapshot()) {
    const excluded = scope.preview?.excluded;
    const source = chat?.updates ?? log.activeMessages(snapshot.sequence);
    const latest = source.filter(entry => !entry.activityOnly && entry !== chat?.trigger && entry !== chat?.step?.previous).slice(-contextMessages);
    const adapter = options?.adapter ?? (options?.planning ? planningAdapter : undefined) ?? adapters;
    const nativeTools = adapter.supportsTools?.(members.get(name).provider);
    const directory = options?.control?.workspace?.cwd ?? cwd;
    const readOnly = workspaceTools && readableWorkspace(directory, protectedPaths);
    const files = options?.control?.workspace?.files ?? (workspaceTools && chat && canChange() ? ownedWorkspace(cwd, ['**']) : undefined);
    const rules = [
      `You are @${name} in room ${roomID}. ${workspaceTools ? 'Use paths relative to the workspace root.' : `Workspace: ${directory}.`}`,
      `Other members: ${[...members.keys()].filter(member => member !== name).map(member => `@${member}`).join(', ') || 'none'}.`,
      chat
        ? 'Reply briefly. You may address other members by @name. If you have nothing useful to add, reply with exactly PASS.'
        : 'Follow the task under Triggering message. Use the shared context and messages for background.',
    ];
    if (trackActivity && !options?.planning) rules.push('Summarize your work in prose and use workspace tools to make edits. LOOMS displays file diffs and command counts.');
    const allowed = options?.planning || options?.providerCommand ? [] : options?.answerOnly ? ['room.answer', 'room.read_log'] :
      chatActions.filter(action => !chat?.step || action !== 'room.ask');
    if (excluded?.size && allowed.includes('room.read_log')) allowed.splice(allowed.indexOf('room.read_log'), 1);
    if (readOnly && (!options?.providerCommand || options.providerCommand.name === 'review')) allowed.push(...workspaceReadActions);
    const canDelegate = subagentLimit > scope.subagents && !options?.planning && !options?.providerCommand && !options?.answerOnly;
    if (canDelegate) allowed.push('room.delegate');
    if (options?.answerOnly && !options.blocking) allowed.push('room.ask');
    if (options?.task) {
      const { id, title, owns, uses_contracts, verify } = options.task;
      rules.push(`Task ${id}: ${title}. Owned paths: ${owns.join(', ') || 'none'}. Contracts: ${uses_contracts.join(', ') || 'none'}. Verify: ${verify.join(', ') || 'none'}.`,
        'Call the task complete action when the work is ready for verification. Call the task block or room ask action if you need a dependency. End the turn after submitting an outcome.');
      allowed.push('task.complete', 'task.block');
    }
    if (files && (!options?.task || options.task.owns.length)) {
      rules.push('Use workspace actions for edits. Each edit is checked against this turn’s access.');
      if (askBeforeChanges) rules.push('The user must approve each file change. Respect denied requests.');
      allowed.push('workspace.write_text', 'workspace.delete_file');
    }
    if (!options?.planning && !options?.providerCommand && !options?.answerOnly && name === scope.planner) {
      allowed.push('contract.approve');
      const proposals = excluded?.size ? [] : contracts.pending(snapshot.sequence).slice(-contextMessages);
      if (proposals.length) rules.push(`Pending contract proposals: ${proposals.map(message =>
        `${message.id} (${message.contract_event.contract.id})`).join(', ')}. Inspect them with the room log tool before deciding.`);
    }
    const externalMcpAllowed = Boolean(chat && writeEnabled && !askBeforeChanges && !excluded?.size &&
      !options?.planning && !options?.providerCommand && !options?.answerOnly && !options?.task && !options?.control);
    const external = externalMcpActionsFor(externalMcp, externalMcpAllowed);
    if (external.length) {
      allowed.push(...external);
      rules.push(describeExternalMcp(externalMcp, allowed));
    }
    if (allowed.length) rules.push(describeActions(allowed, nativeTools));
    const context = latest.map(entry => `[${entry.from ?? entry.speaker}] ${entry.text}`).join('\n\n');
    const triggering = chat ? (chat.trigger ? `[user] ${chat.trigger.text}` : '') : prompt;
    const skill = chat?.skill ?? options?.skill;
    const sections = [
      previewSection('instructions', 'Room instructions', rules.join('\n')),
      ...(!excluded?.has('summary') ? [previewSection('summary', 'Room summary', `AGENTS.md\n${scope.summary || '(Room summary is empty.)'}`)] : []),
      ...(!excluded?.has('history') ? [previewSection('history', 'Recent room history',
        `Room messages through ${snapshot.id ?? 'the start of the room'}${chat?.catchUp ? ' as you join or rejoin' : ''}\n${context}`)] : []),
      ...(skill ? [previewSection('skill', 'Enabled skill',
        `Apply the user-enabled skill /${skill.name} for this request. Follow the room’s permissions.\n\n${skill.content}`)] : []),
      ...(triggering ? [previewSection('task', 'Triggering message', `Triggering message\n${triggering}`)] : []),
      ...(chat?.step ? [previewSection('step', 'Ordered step', formatChainStep(chat.step))] : []),
    ];
    return { sections, allowed, snapshot, nativeTools, directory, readOnly, files, canDelegate };
  }

  function roomContext(name, prompt, chat, options) {
    const scope = round;
    const { sections, allowed, snapshot, nativeTools, directory, readOnly, files, canDelegate } =
      options?.prepared ?? roomPrompt(name, prompt, chat, options, scope);
    // Reviewed stages differ only by the predecessor output, which cannot be known locally.
    const formatted = sections.map(({ id, text }) => options?.prepared && id === 'step' && chat.step.previous
      ? formatChainStep(chat.step) : text).join('\n\n');
    const signal = options?.control?.signal ?? options?.signal;
    const turnEnd = canDelegate || askBeforeChanges ? new AbortController() : undefined;
    const turnSignal = turnEnd && AbortSignal.any([turnEnd.signal, ...(signal ? [signal] : [])]);
    const delegatedUsage = {};
    const activity = trackActivity ? collectActivity() : undefined;
    let active = true;
    let outcomeSubmitted = false;
    const finish = options?.control && (result => {
      options.control.finish(result);
      outcomeSubmitted = true;
      turnEnd?.abort();
    });
    function requireActive() {
      if (!active || closed || round !== scope || signal?.aborted) throw new Error('This room turn is no longer active.');
      if (outcomeSubmitted) throw new Error('The task has submitted an outcome. End the turn.');
    }
    function tool(action, args) {
      requireActive();
      validateAction(action, args);
      if (!allowed.includes(action)) throw new Error(`Room action ${action} is unavailable in this turn.`);
      if (options?.answerOnly && action === 'room.answer' && args.reply_to !== options.answerOnly) {
        throw new Error(`This turn can only answer question ${options.answerOnly}.`);
      }
      if (externalMcpActions.includes(action)) return runExternalMcpAction(externalMcp, action, args);
      if (action === 'room.delegate') {
        if (scope.subagents >= subagentLimit) throw new Error(`Round subagent limit (${subagentLimit}) reached.`);
        const parent = options?.member ?? members.get(name);
        const childAllowed = workspaceReadActions.filter(read => allowed.includes(read));
        const stop = AbortSignal.any([shutdown.signal, turnSignal]);
        return runSubagent(name, parent, args.task, directory, childAllowed, tool, stop, delegatedUsage);
      }
      if (action.startsWith('workspace.')) {
        return workspaceOperation(() => {
          if (action === 'workspace.list') return readOnly.list(args.path);
          if (action === 'workspace.read_text') return readOnly.read(args.path);
          const { path, content } = args;
          if (isProtectedPath(resolve(directory, path), protectedPaths)) throw new Error('LOOMS application data is outside workspace tool access.');
          const write = action === 'workspace.write_text';
          const apply = version => write ? files.write(path, content, version, activity?.file) :
            files.remove(path, version, activity?.file);
          if (!askBeforeChanges) return apply();
          const { exists, version } = files.inspect(path);
          if (!write && !exists) return { path, removed: false };
          return approveAction({
            agent: name, taskID: options?.task?.id, action: write ? (exists ? 'replace' : 'create') : 'delete',
            path, ...(write && { content }),
          }, turnSignal).then(() => {
            requireActive();
            return workspaceOperation(() => apply(version));
          });
        });
      }
      return runTool(name, action, args, snapshot, options?.task, finish);
    }
    return {
      snapshot, originalPrompt: prompt, formatted, nativeTools, signal, providerCommand: options?.providerCommand, allowed, delegatedUsage,
      phase: options?.planning ? 'planning' : options?.task ? 'task' : undefined,
      activity,
      recordShellCommand: activity && (() => { requireActive(); activity.command(); }),
      tool: options?.planning && !workspaceTools ? undefined : tool,
      close() { active = false; turnEnd?.abort(); },
    };
  }

  async function runSubagent(name, parent, task, directory, allowed, call, signal, usage) {
    const id = ++round.subagents;
    const { provider, model, effort } = parent;
    const child = { provider, model, effort };
    const adapter = adapters.forTask?.(directory) ?? adapters;
    const label = `@${name} subagent ${id}`;
    const prompt = [
      `You are a read-only subagent for @${name}. Return concise findings to the parent agent.`,
      allowed.length ? `Use workspace paths relative to the root.\n${describeActions(allowed, true)}` : '',
      `Task\n${task}`,
    ].filter(Boolean).join('\n\n');
    report(`${label} started.`, { label: 'subagent' });
    event(`subagent.started ${label}`);
    try {
      const result = await withRoomDeadline(scope => adapter.ask(name, child, prompt, false, {
        allowed, signal: scope, phase: 'subagent',
        tool(action, args) {
          scope.throwIfAborted();
          if (!allowed.includes(action)) throw new Error('This action is unavailable to a read-only subagent.');
          return call(action, args);
        },
      }), signal, 5 * 60_000, label);
      report(`${label} finished.`, { label: 'subagent' });
      event(`subagent.completed ${label}`);
      return { result: String(result ?? '').slice(0, 8000) };
    } catch (error) {
      if (!signal.aborted) {
        report(`${label} failed.`, { label: 'subagent', error: true });
        event(`subagent.failed ${label}`);
      }
      throw error;
    } finally {
      addUsage(usage, child.turnUsage);
      if (adapter !== adapters) adapter.close?.();
    }
  }

  async function ask(name, prompt, chat, options) {
    const member = options?.member ?? members.get(name);
    delete member.turnUsage;
    const context = log ? roomContext(name, prompt, chat, options) : undefined;
    const turnRound = round;
    let reply;
    try {
      const adapter = options?.adapter ?? (options?.planning && planningAdapter || adapters);
      let input = options?.providerCommand ? prompt : context?.formatted ?? prompt;
      const usage = {};
      for (let count = 0; ; count++) {
        delete member.turnUsage;
        reply = await adapter.ask(name, member, input, false, context ?? (options?.providerCommand && { providerCommand: options.providerCommand }));
        addUsage(usage, member.turnUsage);
        if (Object.keys(usage).length) member.turnUsage = { ...usage };
        const action = context?.tool && !options?.providerCommand && !context.nativeTools && typeof reply === 'string' && readTextAction(reply);
        if (!action) break;
        const fileAction = options?.control?.workspace && action.tool.startsWith('workspace.') ||
          options?.planning && workspaceReadActions.includes(action.tool);
        if (fileAction && count >= 63) throw new Error('The task reached the fallback file-tool turn limit.');
        let result;
        try {
          result = await context.tool(action.tool, action.args);
          reply = action.text || 'PASS';
        } catch (error) {
          if (!fileAction) report(`@${name} room action failed: ${error.message}`, { error: true });
          result = { error: error.message };
        }
        if (!fileAction && (action.tool !== 'room.delegate' || result.error)) break;
        context.signal?.throwIfAborted();
        const next = options?.planning ? 'Continue researching or return the structured job plan as JSON.' :
          'Continue the same task and submit a task outcome when ready.';
        input = fileAction ? `Workspace action result: ${JSON.stringify(result)}\n${next}` :
          `Subagent result: ${JSON.stringify(result)}\nUse the result to finish your response.`;
      }
      return reply;
    } finally {
      context?.close();
      if (Object.keys(context?.delegatedUsage ?? {}).length) {
        member.turnUsage ??= {};
        addUsage(member.turnUsage, context.delegatedUsage);
      }
      if (log && round === turnRound && !context?.signal?.aborted) {
        if (round.metricsJob) recordJobUsage(round.metricsJob, name, member.turnUsage);
        const measured = { input_tokens: member.turnUsage?.input, output_tokens: member.turnUsage?.output,
          cost_usd: member.turnUsage?.costUsd };
        const usage = Object.fromEntries(Object.entries(measured).filter(([, value]) => Number.isFinite(value) && value >= 0));
        if (Object.keys(usage).length && typeof reply === 'string' && /^PASS\.?$/i.test(reply.trim())) {
          log.append({ round: round.id, from: name, to: [], kind: 'event', text: 'run.usage', usage });
        } else if (Object.keys(usage).length) usageByMember.set(name, usage);
        else usageByMember.delete(name);
      }
      const activity = context?.activity?.summary();
      if (activity && round === turnRound) {
        if (typeof reply === 'string' && reply.trim() && !/^PASS\.?$/i.test(reply.trim()) && !context.signal?.aborted) {
          activityByMember.set(name, activity);
        } else postActivity(name, activity);
      }
      onTurn?.({ name, provider: member.provider, model: member.model, effort: member.effort,
        actualModel: member.actualModel, actualEffort: member.actualEffort,
        tokens: member.turnUsage, replied: typeof reply === 'string' && !!reply.trim() && !/^PASS\.?$/i.test(reply.trim()) });
    }
  }
  async function askFresh(name, prompt, chat, options) {
    // Both the HTTP history and the Claude Code session are keyed by the member object.
    // Keep the approved run out of the ordinary session and its cursor.
    const { provider, model, effort } = requireMember(name);
    const member = { provider, model, effort };
    try { return await ask(name, prompt, chat, { ...options, member }); }
    finally { adapters.reset?.(member); }
  }

  const newConversation = initial => createChatRoom({
    ask,
    prepare: name => adapters.prepare?.(members.get(name)),
    cwd,
    history: initial,
    append: log && ((from, text, { to = [], kind = 'chat', ...details } = {}) => {
      const usage = kind === 'event' ? undefined : usageByMember.get(from);
      const activity = kind === 'event' ? undefined : activityByMember.get(from);
      if (kind !== 'event') {
        usageByMember.delete(from);
        activityByMember.delete(from);
      }
      const message = log.append({ round: round?.id ?? log.round, from, to, kind, text, ...details,
        ...(usage && { usage }), ...(activity && { activity }) });
      if (round && !round.preview && kind !== 'event') summary.request(round.id);
      return message;
    }),
  });
  let conversation = newConversation(log?.transcriptMessages() ?? history);

  const publish = entry => emit({ type: 'message', entry });
  const report = (text, { label = 'system', error = false, planText } = {}) =>
    emit({ type: 'status', label, text, error, ...(planText && { planText }) });
  const post = (name, text, kind) => conversation.post(name, text, publish, { kind });
  const postActivity = (name, activity) => conversation.post(name, '', publish, { kind: 'event', activity });
  const event = (text, extra) => log?.append({ round: round?.id ?? log.round, from: 'system', to: [], kind: 'event', text, ...extra });
  const contracts = log && createRoomContracts({ log, event });

  function postTool(from, text, details) {
    conversation.post(from, text, publish, details);
    return log.snapshot().id;
  }

  function readLog({ from_id, to_id, filter }, snapshot) {
    const after = from_id ? Math.max(0, sequenceOf(from_id) - 1) : 0;
    const through = Math.min(snapshot.sequence, to_id ? sequenceOf(to_id) : snapshot.sequence);
    const matches = log.records({ after, through }).filter(message => !(message.kind === 'event' && message.activity) &&
      (!filter?.from || message.from === filter.from) && (!filter?.kind || message.kind === filter.kind));
    const messages = [];
    let size = 0;
    for (const { activity, ...message } of matches) {
      size += Buffer.byteLength(JSON.stringify(message));
      if (messages.length && (messages.length >= 50 || size > 64_000)) break;
      messages.push(structuredClone(message));
    }
    return { snapshot_id: snapshot.id, messages, next_from_id: matches[messages.length]?.id };
  }

  function runTool(name, action, args, snapshot, task, finish) {
    switch (action) {
      case 'room.read_log':
        return readLog(args, snapshot);
      case 'room.post': {
        const to = [...new Set(args.to)];
        for (const member of to) if (member !== 'user') requireMember(member);
        return { message_id: postTool(name, args.text, { to }) };
      }
      case 'room.ask': {
        requireMember(args.to);
        if (args.to === name) throw new Error('Ask a different room member.');
        if (round.preview && !round.preview.calls.some(call => call.name === args.to)) {
          throw new Error('Choose a model included in the approved preview.');
        }
        if (args.blocking && !task) throw new Error('Only a scheduled task can ask a blocking question.');
        if (round.hops.length >= hopLimit) throw new Error(`Round hop limit (${hopLimit}) reached.`);
        const id = postTool(name, args.question, { to: [args.to], kind: 'question' });
        round.hops.push({ id, from: name, to: args.to, text: args.question, blocking: args.blocking });
        if (round.metricsJob) round.metricsJob.hops = (round.metricsJob.hops ?? 0) + 1;
        if (args.blocking) finish({ blocked_on: { question: id }, reason: args.question });
        return { question_id: id };
      }
      case 'room.answer': {
        const entries = log.records({ through: snapshot.sequence });
        const question = entries.find(message => message.id === args.reply_to && message.kind === 'question');
        if (!question?.to.includes(name)) throw new Error(`Question ${args.reply_to} is unavailable to @${name}.`);
        if (log.records({ after: sequenceOf(question.id) }).some(message => message.kind === 'answer' && message.reply_to === question.id)) {
          throw new Error(`Question ${question.id} is already answered.`);
        }
        return { message_id: postTool(name, args.text, { kind: 'answer', to: [question.from], reply_to: question.id }) };
      }
      case 'room.decide': {
        const source = postTool(name, args.text, { to: [] });
        const decision = summary.decide(args.text, source, args.supersedes);
        event(`decision.recorded ${decision.id}`, { reply_to: source });
        return decision;
      }
      case 'contract.propose': {
        const result = contracts.propose(name, args, round.planner);
        report(`@${name} proposed ${args.id} (${result.proposal_id}) for @${round.planner} to review.`);
        return result;
      }
      case 'contract.approve': {
        const result = contracts.approve(name, round.planner, args.proposal_id, snapshot.sequence);
        report(`@${name} approved ${result.id} v${result.version}.`);
        return result;
      }
      case 'task.complete':
      case 'task.block': {
        if (args.task_id !== task.id) throw new Error(`This run owns task ${task.id}.`);
        if (action === 'task.complete') finish({ summary: args.summary, artifacts: args.artifacts });
        else {
          const blocker = runningJob.job.tasks.find(item => item.id === args.on);
          if (!blocker || blocker.id === task.id || blocker.state === 'done') throw new Error('Choose a different unfinished task to block on.');
          finish({ blocked_on: { task: blocker.id }, reason: args.reason });
        }
        return { task_id: task.id, accepted: true };
      }
    }
  }

  const hasAnswer = id => log.records({ after: sequenceOf(id) }).some(message => message.kind === 'answer' && message.reply_to === id);

  async function answerQuestions(signal) {
    while (round.hopCursor < round.hops.length) {
      const { id, from, to, text, blocking } = round.hops[round.hopCursor++];
      if (closed || signal?.aborted) return;
      if (hasAnswer(id)) continue;
      try {
        const turn = round.preview ? askFresh : ask;
        const reply = await withRoomDeadline(scope =>
          turn(to, `@${from} asked question ${id}. Answer it with the room answer action using reply_to ${id}.\n\n${text}`,
            undefined, { answerOnly: id, blocking, signal: scope }), signal, 10 * 60_000, `Question ${id}`);
        if (reply?.trim() && !/^PASS\.?$/i.test(reply.trim())) post(to, reply);
      } catch (error) {
        report(`@${to} failed to answer ${id}: ${error.message}`, { error: true });
      }
    }
  }

  function roundState(id, contextSummary, planner, preview) {
    return { id, summary: contextSummary, planner: members.has(planner) ? planner : members.keys().next().value,
      hops: [], hopCursor: 0, subagents: 0, preview };
  }

  async function runRound(action, preview) {
    if (!log) return action();
    if (!preview) await summary.flush();
    if (closed) throw new Error('The room is closed.');
    const id = log.round + 1;
    const planner = preview ? preview.planner : plans.planner();
    const contextSummary = summary.snapshot(id, preview?.summary);
    if (preview && contextSummary !== preview.summary) throw stalePreview();
    round = roundState(id, contextSummary, planner, preview);
    try {
      const result = await action();
      await answerQuestions(preview && shutdown.signal);
      // Leave automatic job resumption to an ordinary round; it can load other context.
      if (!preview && taskExecution && !closed) {
        const job = plans.load();
        if (job?.state === 'stalled' && job.tasks.some(task => task.state === 'blocked' && task.blocked_on?.question &&
            hasAnswer(task.blocked_on.question))) await schedule(job);
      }
      return result;
    } finally {
      try {
        for (const [name, activity] of activityByMember) postActivity(name, activity);
        event('round.complete');
        if (round.metricsJob) plans.saveMetrics(jobMetrics(round.metricsJob));
        // A configured summarizer would send the raw room log to another model.
        if (!preview) summary.request(round.id, true);
      } finally {
        activityByMember.clear();
        usageByMember.clear();
        round = undefined;
      }
    }
  }

  async function providerCommands(target) {
    const { provider } = requireMember(target);
    const discovered = await adapters.discoverCommands?.(provider).catch(() => []);
    return providerCommandCatalog(provider, discovered);
  }

  async function memberCommand(text, { target, command, args }) {
    const member = requireMember(target);
    const label = `@${target}`;
    const catalog = providerCommandCatalog(member.provider);
    if (command === 'help') {
      const commands = await providerCommands(target);
      report(commands.map(({ name, argumentHint, available }) => `/${name}${argumentHint ? ` ${argumentHint}` : ''}${available ? '' : ' · Native CLI'}`).join('\n') ||
        `No room command catalog for ${label}.`, { label });
      return;
    }
    const entry = catalog.find(item => item.name === command);
    if (!entry?.available) {
      const skill = await resolveSkill?.(target, command);
      if (skill) return chat(text, [target], skill);
      const recognized = entry || (await providerCommands(target)).some(item => item.name === command);
      throw new Error(recognized ? `Use /${command} in the ${providerLabels[member.provider]} terminal.` : `Unknown command /${command} for ${label}. Try ${label} /help.`);
    }
    const { action } = entry;
    if (args && (!entry.argumentHint || (action === 'context' && args !== 'all'))) {
      throw new Error(`Usage: ${label} /${command}${entry.argumentHint ? ` ${entry.argumentHint}` : ''}`);
    }
    const model = member.actualModel ?? member.model ?? 'CLI default';
    const effort = member.actualEffort ?? member.effort ?? 'CLI default';
    switch (action) {
      case 'status':
        return report(`${label} · ${model} · effort ${effort} · ${roomAccessLabel(writeEnabled, askBeforeChanges)}`, { label });
      case 'pwd':
        return report(cwd, { label });
      case 'model':
      case 'effort':
        if (!args || action === 'effort' && args === 'status') {
          return report(`${label} · ${model} · effort ${effort}\nUse /model to pick a model or effort, or pass a value to ${label} /${command}.`, { label });
        }
        if (/\s/.test(args)) throw new Error(`Usage: ${label} /${command} ${entry.argumentHint}`);
        return handle(`/${action} ${target} ${args}`);
      case 'usage': {
        const limits = await adapters.accountUsage?.(member.provider);
        return report(limits?.length ? limits.map(limit => `${limit.label} · ${limit.used}% used`).join('\n') :
          `Account limits are unavailable for ${label}.`, { label });
      }
      case 'new': {
        const { provider, model, effort } = member;
        replaceMember(target, member, { provider, model, effort });
        return report(`${label} will start a fresh provider session on the next turn.`, { label });
      }
      default:
        return runRound(async () => {
          postTool('user', text, { to: [target] });
          const reply = await ask(target, `/${command}${args ? ` ${args}` : ''}`, undefined, { providerCommand: { name: action, args } });
          if (reply?.trim()) post(target, reply);
        });
    }
  }

  function addressedCommand(text) {
    const command = parseProviderCommand(text);
    if (command && (members.has(command.target) || providers.includes(command.target))) return command;
  }

  function routeChat(text, targets) {
    const roster = [...members.keys()];
    const chain = !targets && parseRoomChain(text, roster);
    if (chain) return { names: chain.map(step => step.agent), directed: true, roster, chain };
    const mentioned = text.match(/^\s*(?:@[a-z][a-z0-9_-]*(?:[\s,]+|$))+/i)?.[0];
    const selected = [...(mentioned?.matchAll(/@([a-z][a-z0-9_-]*)/gi) ?? [])].map(([, alias]) => {
      const name = alias.toLowerCase();
      return members.has(name) ? name : resolveProvider(name);
    });
    const directed = targets ?? [...new Set(selected.filter(name => members.has(name)))];
    const missing = selected.find(name => providers.includes(name) && !members.has(name));
    if (missing) throw new Error(`@${missing} is not in this room. Use /include @${missing}.`);
    if (!roster.length) throw new Error('The room is empty. Use /add to add a model.');
    return { names: directed.length ? directed : roster, directed: directed.length > 0, roster };
  }

  function chat(text, targets, skill) {
    const command = !targets && addressedCommand(text);
    if (command) return memberCommand(text, command);
    const route = routeChat(text, targets);
    return runRound(() => conversation.send(route.names, text, publish,
      entry => report(entry.text, { error: true }), { ...route, skill }));
  }

  function logVersion() {
    const stat = statSync(log.path, { throwIfNoEntry: false, bigint: true });
    return stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }

  const connectionState = () => [...members.values()].map(({ provider }) => adapters.connected?.(provider)).join(',');

  function requirePreview(approval) {
    const reviewed = previews.get(approval);
    if (!reviewed || reviewed.revision !== rosterRevision || reviewed.snapshot.sequence !== log.length ||
        reviewed.logVersion !== logVersion() || reviewed.connected !== connectionState() ||
        reviewed.summary !== summary.current() || reviewed.planner !== plans.planner()) throw stalePreview();
    return reviewed;
  }

  function preview(text, excluded = [], previous) {
    return submit(() => {
      text = text.trim();
      if (!text) throw new Error('Usage: /preview <task>');
      if (!log) throw new Error('Preview requires a room with a log.');
      if (previous !== undefined) {
        requirePreview(previous);
        if (text !== previous.text) throw stalePreview();
      }
      if (addressedCommand(text)) throw new Error('Preview a chat task, not a provider command.');
      const omitted = new Set(excluded);
      if ([...omitted].some(id => !optionalPreviewSections.includes(id))) throw new Error('Only summary and history can be excluded.');
      const { names, directed, chain } = routeChat(text);
      const priority = directed ? [] : mentionedMembers(text, names);
      const targets = [...priority, ...names.filter(name => !priority.includes(name))];
      const snapshot = log.snapshot();
      const reviewed = { snapshot, summary: summary.current(), planner: plans.planner(), revision: rosterRevision,
        logVersion: logVersion(), connected: connectionState(), excluded: omitted, to: directed ? [...new Set(names)] : [] };
      const scope = roundState(log.round + 1, reviewed.summary, reviewed.planner, reviewed);
      const trigger = { text };
      const updates = conversation.transcript;
      reviewed.calls = targets.map((name, index) => {
        const step = chain && { ...chain[index], number: index + 1, total: chain.length };
        const prepared = roomPrompt(name, undefined, { trigger, step, updates, catchUp: true }, undefined, scope, snapshot);
        const sections = Object.freeze(prepared.sections);
        const pending = step?.number > 1 ? `Output from the previous step (@${chain[index - 1].agent}) will be inserted when it finishes.` : undefined;
        const target = Object.freeze({ name, sections, tokens: estimatePreviewTokens(sections.map(section => section.text).join('\n\n')),
          ...(pending && { pending }) });
        return { name, step, prepared, target };
      });
      const approval = Object.freeze({ text, targets: Object.freeze(reviewed.calls.map(call => call.target)) });
      previews.set(approval, reviewed);
      return approval;
    });
  }

  function sendPreview(approval, validate) {
    return submit(async () => {
      validate?.();
      const reviewed = requirePreview(approval);
      // Let an already scheduled summary finish before advancing the log round. If it
      // changed the snapshot, reject rather than using the new summary or messages.
      await summary.flush();
      validate?.();
      requirePreview(approval);
      previews.delete(approval);
      return runRound(async () => {
        const trigger = conversation.post('user', approval.text, publish, { to: reviewed.to });
        let previous;
        for (const { name, step, prepared } of reviewed.calls) {
          if (closed) break;
          let reply;
          try {
            reply = await askFresh(name, undefined, { trigger, step: step && { ...step, previous } }, { prepared, signal: shutdown.signal });
          } catch (error) {
            if (!closed) report(`@${name} failed: ${error.message}`, { error: true });
            if (step) break;
          }
          if (closed) break;
          const text = String(reply ?? '').trim();
          previous = text && !/^PASS\.?$/i.test(text) ? post(name, text) : undefined;
        }
      }, reviewed);
    });
  }

  function submit(action) {
    const result = pending.then(() => {
      if (closed) throw new Error('The room is closed.');
      return action();
    });
    pending = result.catch(() => {});
    return result;
  }

  function roster() {
    return [...members].map(([name, { provider, model, effort }]) => ({ name, provider, model, effort }));
  }

  function requireMember(name) {
    const member = members.get(name);
    if (!member) throw new Error(`@${name} is not in the room. Use /models to see the roster.`);
    return member;
  }

  function replaceMember(name, member, replacement) {
    rosterRevision++;
    adapters.reset?.(member);
    conversation.forget(name);
    if (replacement) members.set(name, replacement);
    else members.delete(name);
  }

  function configure(nextMembers, nextWriteEnabled, nextAskBeforeChanges = askBeforeChanges) {
    return submit(() => {
      const changedPermission = writeEnabled !== nextWriteEnabled || askBeforeChanges !== nextAskBeforeChanges;
      writeEnabled = nextWriteEnabled;
      askBeforeChanges = nextAskBeforeChanges;
      adapters.setWriteEnabled?.(writeEnabled && !askBeforeChanges);
      const next = new Map(nextMembers.map(({ name, ...member }) => [name, member]));
      for (const [name, current] of members) {
        const replacement = next.get(name);
        if (!replacement || changedPermission || ['provider', 'model', 'effort'].some(key => current[key] !== replacement[key])) {
          replaceMember(name, current, replacement);
        }
      }
      for (const [name, member] of next) if (!members.has(name)) {
        rosterRevision++;
        members.set(name, member);
      }
    });
  }

  async function runJob(job) {
    const participants = job.workers ? [job.lead, ...job.workers.keys()] : [...job.members.keys()];
    if (participants.some(name => members.get(name) !== job.members.get(name))) {
      throw new Error('A participant was removed or reconfigured. Start a new job with the current room members.');
    }
    const label = `job ${job.id}`;
    if (round) round.metricsJob = job;
    try {
      await runRoomJob(job, {
        turn: (name, prompt) => ask(name, prompt),
        report: text => report(text, { label }),
        publish: (name, text) => post(name, text, 'task_update'),
        coordinate: (name, text) => report(`@${name}: ${text}`, { label }),
        shouldStop: () => closed,
      });
    } catch (error) {
      job.state = 'failed';
      report(`${error.message} Use /retry ${job.id} to resume.`, { label });
    }
    if (!closed && job.state !== 'complete') {
      report(`Job ${job.id} ended with status ${job.state}.`, { label, error: true });
    }
  }

  function startJob(task) {
    if (!task) throw new Error('Usage: /job <task>');
    if (!members.size) throw new Error('The room is empty. Use /add to add a model.');
    const job = {
      id: nextJobId++, task, lead: members.keys().next().value, created_at: new Date().toISOString(),
      members: new Map(members), requests: new Set(),
    };
    return runRound(() => {
      post('user', task);
      jobs.set(job.id, job);
      return runJob(job);
    });
  }

  const connectedMember = member => adapters.connected?.(member.provider) !== false;
  const memberSkills = (name, member) => describeMember?.(name, member)?.skills ?? [];

  function assignmentContext() {
    const profiles = [...members].filter(([, member]) => connectedMember(member)).map(([name, member]) => {
      const info = describeMember?.(name, member);
      return { name, ...executionProfile(member, info), skills: info?.skills ?? [],
        nativeRoomTools: adapters.supportsTools?.(member.provider) === true };
    });
    const available = new Set(profiles.map(profile => profile.name));
    const preferences = Object.fromEntries(Object.entries(plans.preferredAgents())
      .filter(([type, name]) => taskTypes.includes(type) && available.has(name)));
    return {
      profiles, preferences, scorecard: assignmentScorecard(log.records(), profiles),
      permissions: roomAccessLabel(writeEnabled, askBeforeChanges),
      plannerReadWorkspace: workspaceTools,
      taskWorkspaceEdits: Boolean(workspaceTools && taskExecution?.open && canChange()),
      taskChecks: Boolean(taskExecution),
      externalMcpForTasks: false,
    };
  }

  function checkPlan(plan) {
    const errors = validateRoomPlan(plan, members.keys());
    if (errors.length) return errors;
    for (const task of plan.tasks) {
      const member = members.get(task.agent);
      if (!connectedMember(member)) errors.push(`Task ${task.id} needs a connected agent. @${task.agent} is disconnected.`);
      if (task.skill && !memberSkills(task.agent, member).includes(task.skill)) {
        errors.push(`Task ${task.id} uses /${task.skill}, which is unavailable for @${task.agent}.`);
      }
    }
    return errors;
  }

  function draftOf({ goal, contracts, tasks }) {
    return { goal, contracts, tasks: tasks.map(({ state, ...task }) => task) };
  }

  function savePlan(job, action) {
    plans.save(job);
    round.metricsJob = job;
    event(`job.${action} ${job.id}`);
  }

  async function schedule(job) {
    if (taskExecution.open && !canChange()) throw new Error('Enable Workspace edits or Ask before changes in the room permissions to run this job.');
    const controller = new AbortController();
    round.metricsJob = job;
    runningJob = { job, controller };
    try {
      const isolation = taskExecution.open && await withRoomDeadline(signal =>
        taskExecution.open({ cwd, directory: log.directory, roomID, job, signal }), controller.signal, 15 * 60_000, 'Workspace setup', true);
      if (isolation) {
        job.isolation = isolation.mode;
        job.integration_branch = isolation.integrationBranch;
        report(isolation.integrationBranch ? `Task worktrees will merge into ${isolation.integrationBranch}.` :
          'Tasks will reserve their owned paths in this workspace.', { label: 'job' });
      }
      await runRoomSchedule(job, {
        signal: controller.signal, snapshot: () => log.snapshot(), currentRound: () => round.id, isolation,
        verify: taskExecution.verify,
        onVerificationCommands: trackActivity ? (task, commands) => postActivity(task.agent, { commands, files: [] }) : undefined,
        approveVerification: askBeforeChanges ? (task, command, signal) =>
          approveAction({ agent: task.agent, taskID: task.id, action: 'verify', command }, signal) : undefined,
        settleQuestions: answerQuestions, hasAnswer,
        change(type, task) {
          plans.save(job);
          const detail = task?.reason ? ` ${task.reason}` : '';
          event(`${type} ${task?.id ?? job.id}${detail}`, task ? { task_id: task.id } : {});
          if (['task.failed', 'task.fixup_created', 'job.budget_warning', 'job.stalled', 'job.paused', 'job.done', 'job.cancelled'].includes(type)) {
            const waiting = type === 'job.stalled' ? `\n${job.tasks.filter(item => ['pending', 'blocked'].includes(item.state))
              .map(item => `${item.id} is waiting on ${JSON.stringify(item.blocked_on ?? item.depends_on.filter(id =>
                job.tasks.some(dep => dep.id === id && dep.state !== 'done')))}`).join('\n')}` : '';
            report(`${type} ${task?.id ?? job.id}${detail}${waiting}`, { label: 'job', error: type === 'task.failed' });
          }
        },
        async run(task, control) {
          const current = requireMember(task.agent);
          const skill = task.skill && await resolveSkill?.(task.agent, task.skill);
          if (task.skill && !skill) throw new Error(`Enable /${task.skill} for @${task.agent} before running task ${task.id}.`);
          const adapter = control.workspace && adapters.forTask?.(control.workspace.cwd);
          const member = adapter ? { provider: current.provider, model: current.model, effort: current.effort } : current;
          const contracts = job.contracts.filter(contract => task.uses_contracts.includes(`${contract.id}@${contract.version}`))
            .map(contract => `${contract.id}@${contract.version}\n${contract.content}`).join('\n\n');
          const dependency = task.resumed_from?.task;
          const question = task.resumed_from?.question;
          const details = [
            `Execute task ${task.id}: ${task.title}\nJob goal: ${job.goal}`,
            contracts && `Contracts\n${contracts}`,
            task.reason && `Previous attempt failed. Fix the verification or run failure within your owned paths.\n${task.reason}`,
            dependency && `Dependency task.done ${dependency} is ready.`,
            question && `The room has answered ${question}. Read the answer from the room log.`,
          ].filter(Boolean).join('\n\n');
          try {
            const reply = await ask(task.agent, details, undefined, { task, control, adapter, member, skill });
            control.signal.throwIfAborted();
            if (reply?.trim() && !/^PASS\.?$/i.test(reply.trim())) post(task.agent, reply, 'task_update');
            return { input_tokens: member.turnUsage?.input, output_tokens: member.turnUsage?.output, cost_usd: member.turnUsage?.costUsd };
          } finally {
            recordTaskProfile(task, executionProfile(member));
            adapter?.close();
          }
        },
      });
      const outcomes = taskOutcomes(job);
      if (outcomes.length) event('job.outcomes', { job_outcomes: { job: job.id, tasks: outcomes } });
    } finally {
      runningJob = undefined;
    }
  }

  function printPlan(job) {
    const instructions = job.state === 'awaiting_approval'
      ? '\n\nUse `/approve`, `/edit <json-patch>`, or `/cancel`.' : '';
    const planText = [instructions.trim(), displayPlan(job, { vertical: true })].filter(Boolean).join('\n\n');
    report(`${displayPlan(job)}${instructions}`, { label: 'plan', planText });
  }

  function approvePlan(job) {
    requireMember(job.planner);
    const errors = checkPlan(draftOf(job));
    if (errors.length) throw new Error(`Plan validation failed.\n${errors.join('\n')}`);
    if (taskExecution?.open && !canChange()) throw new Error('Enable Workspace edits or Ask before changes in the room permissions to run this job.');
    const approved = { ...job, state: 'approved' };
    if (job.state !== 'approved') savePlan(approved, 'approved');
    if (taskExecution) return schedule(approved);
    report('Plan approved. Task execution is pending workspace isolation support.', { label: 'plan' });
  }

  function startPlan(prompt) {
    if (!plans) throw new Error('This room has no planning storage.');
    const match = /^--(?:plan\s+|planner\s+@?([a-z][a-z0-9_-]*)\s+)([\s\S]+)$/.exec(prompt);
    if (!match || match[2].length > 8000) throw new Error('Usage: /job --plan <goal> or /job --planner @agent <goal>');
    const [, requested, goal] = match;
    const previous = plans.load();
    if (['awaiting_approval', 'approved'].includes(previous?.state)) throw new Error('A plan is active. Use /status to see it or /cancel to close it.');
    const planner = requested ?? [...members].find(([, member]) => connectedMember(member))?.[0];
    if (!planner) throw new Error('Connect a room agent before planning a job.');
    const member = requireMember(planner);
    if (!connectedMember(member)) throw new Error(`Connect @${planner} before planning a job.`);
    const planningMember = { provider: member.provider, model: member.model, effort: member.effort };
    return runRound(async () => {
      post('user', goal);
      planningAdapter = adapters.forPlanning?.();
      try {
        let errors;
        const jobID = `job_${round.id}`;
        const draft = { id: jobID, created_at: new Date().toISOString(), state: 'planning', tasks: [] };
        const assignment = assignmentContext();
        round.metricsJob = draft;
        for (let attempt = 0; attempt < 3; attempt++) {
          const reply = await ask(planner, plannerPrompt(goal, assignment.profiles, errors, assignment), undefined,
            { planning: true, member: planningMember });
          if (closed) return;
          const usage = usageByMember.get(planner);
          usageByMember.delete(planner);
          if (typeof reply === 'string' && reply.length <= 250_000) {
            log.append({ round: round.id, from: planner, to: [], kind: 'task_update', text: reply, ...(usage ? { usage } : {}) });
          }
          let plan;
          try {
            if (typeof reply !== 'string' || reply.length > 250_000) throw new Error('Unexpected planner output.');
            plan = JSON.parse(reply);
            errors = checkPlan(plan);
          } catch {
            errors = ['Return only the plan as a JSON object within the room message limit.'];
          }
          if (errors.length) continue;
          const job = { ...draft, version: 1, planner, state: 'awaiting_approval', assignment_context: assignment, ...plan,
            tasks: plan.tasks.map(task => ({ ...task, state: 'pending' })) };
          savePlan(job, 'planned');
          if (plans.autoApprove() && (!taskExecution?.open || canChange())) {
            report(displayPlan(job), { label: 'plan' });
            await approvePlan(job);
          } else printPlan(job);
          return;
        }
        draft.state = 'failed';
        event(`job.plan_failed ${jobID}`);
        report(`Plan validation failed after three attempts.\n${errors.join('\n')}`, { label: 'plan', error: true });
      } finally {
        planningAdapter?.close();
        planningAdapter = undefined;
      }
    });
  }

  function editPlan(job, patch) {
    const updated = patchRoomPlan(draftOf(job), JSON.parse(patch));
    const errors = checkPlan(updated);
    if (errors.length) throw new Error(`Plan validation failed.\n${errors.join('\n')}`);
    const before = new Map(job.tasks.map(task => [task.id, task]));
    const edited = { ...job, ...updated, assignment_context: assignmentContext(), tasks: updated.tasks.map(task => {
      const previous = before.get(task.id);
      const reassigned = previous && ['agent', 'task_type', 'skill'].some(key => previous[key] !== task[key]);
      const reason = reassigned && task.assignment_reason === previous.assignment_reason ? 'Assignment edited by the user.' : task.assignment_reason;
      return { ...task, assignment_reason: reason, state: 'pending' };
    }) };
    savePlan(edited, 'edited');
    printPlan(edited);
  }

  function jobPreference(words) {
    if (!plans) throw new Error('This room has no planning storage.');
    const [, type, target] = words;
    if (!type) {
      const entries = Object.entries(plans.preferredAgents());
      report(entries.map(([taskType, name]) => `${taskType} · @${name}`).join('\n') ||
        'No preferences saved. Set one with /job --prefer <task-type> @agent.', { label: 'plan' });
      return;
    }
    if (words.length !== 3 || !taskTypes.includes(type)) {
      throw new Error(`Use /job --prefer <task-type> @agent or /job --prefer <task-type> default. Task types: ${taskTypes.join(', ')}.`);
    }
    const name = target === 'default' ? undefined : resolveProvider(target.replace(/^@/, '').toLowerCase());
    if (name) requireMember(name);
    return runRound(() => {
      event(`job.preference ${type} ${name ?? 'default'}`);
      plans.setPreferredAgent(type, name);
      report(name ? `@${name} preferred for ${type} tasks in this room.` : `Cleared the ${type} preference.`, { label: 'plan' });
    });
  }

  async function review(task) {
    const defaults = defaultProviders.filter(name => members.get(name)?.provider === name);
    const [author, reviewer] = defaults.length >= 2 ? defaults : members.keys();
    if (!reviewer) throw new Error('/review requires two room members.');
    post('user', task);
    const proposal = await ask(author, `Propose an approach in 150 words or fewer. Include relevant files or tests.\n\nTask:\n${task}`);
    post(author, proposal);
    const feedback = await ask(reviewer, `Review the following proposal for the task below. Give only actionable feedback in 100 words or fewer.\n\nTask:\n${task}\n\nProposal:\n${proposal}`);
    post(reviewer, feedback);
    post(author, await ask(author, `Revise your proposal based on this reviewer feedback. State what changed.\n\n${feedback}`));
  }

  async function handle(line) {
    const [command, ...words] = line.trim().split(/\s+/);
    const prompt = line.trim().slice(command.length).trim();
    switch (command) {
      case '/chat':
        if (!prompt) throw new Error('Usage: /chat <message>');
        return chat(prompt);
      case '/preview':
        throw new Error('Use /preview <task> in the interactive LOOMS terminal.');
      case '/job':
        if (words[0] === '--prefer') return jobPreference(words);
        return /^--(?:plan|planner)(?:\s|$)/.test(prompt) ? startPlan(prompt) : startJob(prompt);
      case '/approve':
      case '/edit':
      case '/cancel': {
        const job = plans?.load();
        const eligible = job?.state === 'awaiting_approval' || command === '/approve' && job?.state === 'approved' ||
          command === '/cancel' && ['approved', 'paused', 'stalled'].includes(job?.state);
        if (!eligible) throw new Error('There is no plan to update. Use /job --plan <goal> to create one.');
        if ((command === '/edit') !== Boolean(prompt)) throw new Error(`Usage: ${command}${command === '/edit' ? ' <json-patch>' : ''}`);
        return runRound(() => {
          if (command === '/approve') return approvePlan(job);
          if (command === '/edit') return editPlan(job, prompt);
          const cancelled = { ...job, state: 'cancelled', tasks: job.tasks.map(task =>
            ['done', 'failed'].includes(task.state) ? task : { ...task, state: 'cancelled' }) };
          savePlan(cancelled, 'cancelled');
          report(`Cancelled plan ${job.id}.`, { label: 'plan' });
        });
      }
      case '/auto-approve': {
        if (!plans || !['on', 'off'].includes(prompt)) throw new Error('Usage: /auto-approve <on|off>');
        return runRound(() => {
          event(`job.auto_approve ${prompt}`);
          plans.setAutoApprove(prompt === 'on');
          report(`Automatic plan approval is ${prompt}.`, { label: 'plan' });
        });
      }
      case '/status': {
        const job = plans?.load();
        if (!job) report('There is no structured job plan in this room.');
        else {
          const isolation = job.integration_branch ? ` · worktree ${job.integration_branch}` : job.isolation ? ' · file locks' : '';
          report(`${job.id} · ${job.state} · planner @${job.planner}${isolation}`, { label: 'plan' });
          printPlan(job);
        }
        return;
      }
      case '/budget': {
        const job = plans?.load();
        const tokens = Number(prompt);
        if (!job || !/^[1-9]\d*$/.test(prompt) || !Number.isSafeInteger(tokens)) throw new Error('Usage: /budget <tokens> for the current job');
        return runRound(() => {
          job.token_budget = tokens;
          savePlan(job, 'budget_updated');
          if (taskExecution && job.state === 'paused') return schedule(job);
          report(`Job token budget set to ${tokens}.`, { label: 'plan' });
        });
      }
      case '/jobs':
        if (!jobs.size) report('No jobs in this room.');
        for (const { id, state, requests } of jobs.values()) {
          const waiting = [...requests].map(({ from, to }) => `@${from} → @${to}`).join(', ');
          report(`Job ${id} · ${state}${waiting ? ` · waiting: ${waiting}` : ''}`);
        }
        return;
      case '/retry': {
        if (taskExecution && memberName.test(prompt)) {
          const planned = plans.load();
          const task = planned?.tasks.find(item => item.id === prompt);
          if (task?.state !== 'failed') throw new Error('Choose a failed task from /status.');
          return runRound(() => {
            task.state = 'ready';
            task.failures = 0;
            savePlan(planned, `retry ${task.id}`);
            return schedule(planned);
          });
        }
        const job = /^\d+$/.test(prompt) && jobs.get(Number(prompt));
        if (!job) throw new Error('Use /jobs to find a job to retry.');
        if (job.state === 'complete') throw new Error(`Job ${job.id} is already complete.`);
        return runRound(() => {
          job.retries = (job.retries ?? 0) + 1;
          return runJob(job);
        });
      }
      case '/models':
        if (!members.size) report('The room is empty.');
        for (const { name, provider, model, effort } of roster()) {
          report(`@${name}  ${provider}  ${model ?? '(default model)'}  effort: ${effort ?? 'default'}`);
        }
        return;
      case '/add': {
        const [name, provider, model] = words;
        if (words.length < 2 || words.length > 3 || !memberName.test(name) || aliases.includes(name) ||
            !providers.includes(provider) || (model && !modelName.test(model))) {
          throw new Error('Usage: /add <name> <provider> [model]');
        }
        if (members.has(name)) throw new Error(`@${name} already exists. Remove it before replacing it.`);
        if (adapters.connected && !adapters.connected(provider)) throw new Error(`Connect ${provider} in /accounts first.`);
        rosterRevision++;
        members.set(name, { provider, model });
        report(`Added @${name}.`);
        return;
      }
      case '/model':
      case '/effort': {
        const [alias, value, level] = words;
        const switchingModel = command === '/model';
        if (words.length < 2 || words.length > (switchingModel ? 3 : 2)) {
          throw new Error(switchingModel ? 'Usage: /model <name> <model|default> [effort|default]' :
            'Usage: /effort <name> <level|default>');
        }
        const name = alias.replace(/^@/, '').toLowerCase();
        const member = requireMember(name);
        const model = switchingModel ? (value === 'default' ? undefined : value) : member.model;
        const effortValue = switchingModel ? level : value;
        const effort = effortValue === 'default' ? undefined : effortValue ?? member.effort;
        if (model && !modelName.test(model)) throw new Error('Invalid model identifier.');
        if (effort && !effortName.test(effort)) throw new Error('Invalid effort level.');
        if (model === member.model && effort === member.effort) {
          report(`@${name} already uses those settings.`);
          return;
        }
        replaceMember(name, member, { provider: member.provider, model, effort });
        report(`@${name} will start a fresh provider session with ${model ?? 'the default model'} and ${effort ?? 'default'} effort.`);
        return;
      }
      case '/remove': {
        const name = prompt.replace(/^@/, '').toLowerCase();
        replaceMember(name, requireMember(name));
        report(`Removed @${name}.`);
        return;
      }
      case '/new':
        await summary?.flush();
        event('conversation.reset');
        summary?.reset();
        for (const member of members.values()) adapters.reset?.(member);
        jobs.clear();
        conversation = newConversation();
        report('Fresh sessions ready.');
        return;
      case '/send': {
        const name = words[0]?.replace(/^@/, '').toLowerCase();
        const message = prompt.slice(words[0]?.length).trim();
        if (!name || !message) throw new Error('Usage: /send <agent> <message>');
        requireMember(name);
        return chat(message, [name]);
      }
      case '/review':
        if (!prompt) throw new Error('Usage: /review <task>');
        return runRound(() => review(prompt));
      case '/summary':
        if (!summary) throw new Error('This room has no summary storage.');
        await summary.flush();
        report(summary.current() || 'The room has no summary yet.');
        return;
      case '/log': {
        const count = prompt ? Number(prompt) : 20;
        if (!log || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('Usage: /log [1–200]');
        const records = log.records({ after: Math.max(0, log.length - count) });
        report(records.map(message => JSON.stringify(message)).join('\n') || 'The room log is empty.', { label: 'log' });
        return;
      }
      case '/decide': {
        if (!summary) throw new Error('This room has no decision storage.');
        if (!prompt) throw new Error('Usage: /decide <text>');
        return runRound(() => {
          post('user', prompt);
          const decision = summary.decide(prompt, log.snapshot().id);
          event(`decision.recorded ${decision.id}`);
          report(`Recorded decision ${decision.id}.`);
        });
      }
      case '/contract': {
        if (!contracts || words.length !== 2 || words[0] !== 'approve' || !/^msg_\d{4,}$/.test(words[1])) {
          throw new Error('Usage: /contract approve <proposal-message-id>');
        }
        return runRound(() => {
          const result = contracts.approve('user', round.planner, words[1]);
          report(`Approved ${result.id} v${result.version}.`);
        });
      }
      default: {
        if (!command.startsWith('/')) return chat(line.trim());
        const target = command.slice(1).toLowerCase();
        if (prompt && (providers.includes(target) || aliases.includes(target))) return chat(`@${target} ${prompt}`);
        throw new Error(`Unknown command ${command}. Use /help to see the available commands.`);
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    shutdown.abort();
    runningJob?.controller.abort(new Error('Room closed.'));
    summary?.close();
    planningAdapter?.close();
    adapters.close?.();
  }

  return {
    cwd, get writeEnabled() { return writeEnabled; }, roster, configure, close, providerCommands, preview, sendPreview,
    transcript: () => [...conversation.transcript],
    checkpoint: historyHash => event('conversation.checkpoint', { history_hash: historyHash }),
    flushSummary: () => summary?.flush(),
    send: text => submit(() => chat(text)),
    command: line => {
      if (line.trim() === '/cancel' && runningJob) {
        runningJob.controller.abort(new Error('Cancelled by the user.'));
        return Promise.resolve();
      }
      return submit(() => handle(line));
    },
  };
}
