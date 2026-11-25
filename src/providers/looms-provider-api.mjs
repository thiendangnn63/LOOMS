import { serviceRequest } from './looms-accounts.mjs';
import { createClaudeRoomAdapter } from './looms-claude.mjs';
import { mcpTools, runMcpTool } from '../room/room-tools.mjs';
import { roomServices } from './room-services.mjs';

const maxToolRounds = 24;

async function readResponsesStream(response) {
  if (!response.body) throw new Error('ChatGPT returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainder = '';
  function event(record) {
    const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = JSON.parse(data);
    if (value.type === 'response.completed') return value.response;
    if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw new Error('ChatGPT did not complete the response.');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      remainder += decoder.decode(value, { stream: !done });
      const records = remainder.split(/\r?\n\r?\n/);
      remainder = records.pop();
      for (const record of records) {
        const result = event(record);
        if (result) return result;
      }
      if (done) {
        const result = event(remainder);
        if (result) return result;
        throw new Error('ChatGPT’s stream ended before completion.');
      }
      if (remainder.length > 5_000_000) throw new Error('ChatGPT returned an oversized stream event.');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function toolResult(context, name, input) {
  try {
    return { value: await runMcpTool(context.tool, name, typeof input === 'string' ? JSON.parse(input) : input) };
  } catch (error) {
    return { error: error.message };
  }
}

const textBlocks = blocks => blocks.filter(block => block.type === 'text' || block.type === 'output_text').map(block => block.text).join('\n');

async function chatGPT(request, member, messages, tools, context) {
  const data = await readResponsesStream(await request('/responses', {
    model: member.actualModel, input: messages, store: false, stream: true,
    ...(member.effort && { reasoning: { effort: member.effort } }),
    ...(tools.length && { include: ['reasoning.encrypted_content'], tools: tools.map(({ name, description, inputSchema }) =>
      ({ type: 'function', name, description, parameters: inputSchema, strict: false })) }),
  }));
  const items = data.output ?? [];
  const calls = items.filter(item => item.type === 'function_call');
  const results = await Promise.all(calls.map(async call => ({
    type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(await toolResult(context, call.name, call.arguments)),
  })));
  return { model: data.model, input: data.usage?.input_tokens, output: data.usage?.output_tokens,
    text: textBlocks(items.flatMap(item => item.content ?? [])), next: [...items, ...results], called: calls.length > 0 };
}

async function gemini(request, member, messages, tools, context) {
  const reply = await (await request(`/models/${encodeURIComponent(member.actualModel)}:generateContent`, {
    contents: messages,
    ...(member.effort && { generationConfig: { thinkingConfig: { thinkingLevel: member.effort.toUpperCase() } } }),
    ...(tools.length && { tools: [{ functionDeclarations: tools.map(({ name, description, inputSchema }) =>
      ({ name, description, parametersJsonSchema: inputSchema })) }] }),
  })).json();
  const content = reply.candidates?.[0]?.content;
  const parts = content?.parts ?? [];
  const calls = parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
  const results = await Promise.all(calls.map(async call => ({ functionResponse: {
    name: call.name, ...(call.id && { id: call.id }), response: await toolResult(context, call.name, call.args),
  } })));
  return { model: reply.modelVersion, input: reply.usageMetadata?.promptTokenCount,
    output: reply.usageMetadata ? (reply.usageMetadata.candidatesTokenCount ?? 0) + (reply.usageMetadata.thoughtsTokenCount ?? 0) : undefined,
    text: parts.filter(part => !part.thought).map(part => part.text ?? '').join('\n'), called: calls.length > 0,
    next: content ? [content, ...(calls.length ? [{ role: 'user', parts: results }] : [])] : [] };
}

const httpProviders = {
  codex: {
    url: 'https://api.openai.com/v1',
    headers: credential => ({ authorization: `Bearer ${credential}` }),
    message: text => ({ role: 'user', content: text }),
    run: chatGPT,
    models: data => (data.models ?? []).filter(item => item.visibility === 'list' && item.slug)
      .map(item => ({ id: item.slug, label: item.display_name, efforts: (item.supported_reasoning_efforts ?? [])
        .map(value => typeof value === 'string' ? value : value.effort ?? value.reasoning_effort).filter(Boolean) })),
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    headers: credential => ({ 'x-goog-api-key': credential }),
    message: text => ({ role: 'user', parts: [{ text }] }),
    run: gemini,
    models: data => (data.models ?? []).filter(item => item.name?.startsWith('models/') && item.supportedGenerationMethods?.includes('generateContent') &&
        !/embedding|tts|image|robot|computer-use/i.test(item.name))
      .map(item => ({ id: item.name.slice(7), label: item.displayName, efforts: [] })),
  },
};
const nativeProviders = { claude: createClaudeRoomAdapter };

export function createLoomsAdapters({ accounts, fetcher = fetch, catalogs = new Map() }) {
  const sessionAbort = new AbortController();
  const native = new Map(Object.entries(nativeProviders).map(([id, create]) => [id, create(accounts, sessionAbort.signal)]));
  const spawned = new Set();
  let closed = false;
  function http(provider) {
    if (!Object.hasOwn(httpProviders, provider)) throw new Error(`No transport registered for ${provider}.`);
    return httpProviders[provider];
  }
  async function catalog(provider, credential) {
    if (native.has(provider)) return native.get(provider).catalog();
    const service = http(provider);
    credential ??= await accounts.credential(provider);
    const cached = catalogs.get(provider);
    if (cached?.credential === credential && cached.until > Date.now()) return cached.pending;
    const pending = serviceRequest(fetcher, `${service.url}/models`, { headers: service.headers(credential) })
      .then(response => response.json()).then(data => {
        const choices = service.models(data);
        if (!choices.length) throw new Error('This connection did not report any compatible models.');
        return choices.map((model, index) => ({ ...model, default: index === 0 }));
      }).catch(error => { if (catalogs.get(provider)?.pending === pending) catalogs.delete(provider); throw error; });
    catalogs.set(provider, { credential, until: Date.now() + 5 * 60_000, pending });
    return pending;
  }

  function reset(member) {
    if (native.has(member.provider)) native.get(member.provider).reset(member);
    else delete member.session;
  }

  async function ask(_name, member, prompt, _showReply, context) {
    if (closed) throw new Error('The provider connection is closed.');
    const { provider } = member;
    const cli = native.get(provider);
    const scope = context?.signal ? AbortSignal.any([context.signal, sessionAbort.signal]) : sessionAbort.signal;
    const previous = member.session ?? [];
    if (context?.providerCommand) {
      const { name, args } = context.providerCommand;
      if (name === 'context') return `${cli?.turns?.(member) ?? previous.length} prior provider turn(s) in memory. The room persists its shared log and summary.`;
      if (name === 'compact') { reset(member); return 'Provider context reset. The next turn will receive shared room context.'; }
      if (name === 'mcp') return cli ? `${roomServices[provider].label} connects to the LOOMS room tools over local MCP.` :
        'LOOMS serves workspace and room tools directly through the connected provider API.';
      if (name !== 'review') throw new Error('This command requires its native terminal.');
      prompt = `Review the current workspace changes. Report actionable findings without editing files. ${args}`;
    }

    if (cli) return cli.ask(member, prompt, context, scope);
    const service = http(provider);
    const credential = await accounts.credential(provider);
    member.actualModel = member.model ?? (await catalog(provider, credential))[0].id;
    member.actualEffort = member.effort;
    const tools = mcpTools.filter(tool => context?.allowed?.some(action => action.replace('.', '_') === tool.name));
    const request = (path, payload) => serviceRequest(fetcher, `${service.url}${path}`, {
      method: 'POST', headers: { ...service.headers(credential), 'content-type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.any([scope, AbortSignal.timeout(180_000)]),
    });
    const messages = previous.flat();
    const start = messages.length;
    messages.push(service.message(prompt));
    const usage = {};
    for (let round = 0; round < maxToolRounds; round++) {
      const result = await service.run(request, member, messages, tools, context);
      for (const key of ['input', 'output']) if (Number.isFinite(result[key])) usage[key] = (usage[key] ?? 0) + result[key];
      if (Object.keys(usage).length) member.turnUsage = { ...usage };
      messages.push(...result.next);
      if (result.called) continue;
      if (!result.text.trim() && round === 0) throw new Error('The provider returned no usable reply.');
      const turn = messages.slice(start);
      const next = [...previous, turn].slice(-8);
      while (next.length > 1 && JSON.stringify(next).length > 350_000) next.shift();
      // Keep the model ID requested by the user for follow-ups within this turn.
      member.actualModel = result.model ?? member.actualModel;
      member.session = next;
      return result.text || 'PASS';
    }
    throw new Error('The provider reached the room’s tool-call limit.');
  }

  function child() {
    const adapter = createLoomsAdapters({ accounts, fetcher, catalogs });
    spawned.add(adapter);
    const close = adapter.close;
    adapter.close = () => { close(); spawned.delete(adapter); };
    return adapter;
  }

  return { ask, catalog, accountUsage: async provider => await native.get(provider)?.accountUsage?.() ?? [],
    discoverCommands: async provider => await native.get(provider)?.discoverCommands?.() ?? [],
    supportsTools: provider => native.has(provider) || Object.hasOwn(httpProviders, provider),
    prepare: member => native.get(member.provider)?.prepare?.(member) ?? Boolean(member.session),
    connected: provider => accounts.list().some(account => account.provider === provider && account.connected),
    reset, forPlanning: child, forTask: child,
    invalidate(provider) {
      catalogs.delete(provider);
      native.get(provider)?.invalidate?.();
    },
    close() {
      closed = true;
      sessionAbort.abort();
      for (const adapter of native.values()) adapter.close();
      for (const adapter of spawned) adapter.close();
    } };
}
