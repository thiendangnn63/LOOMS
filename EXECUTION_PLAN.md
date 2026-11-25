# LOOMS execution plan

LOOMS (LLM Rooms) puts ChatGPT, Claude, Gemini, and the user in a shared terminal room. The npm package contains the room engine and its terminal interface. The OpenCode fork, its adapter, and the earlier Windows desktop prototype remain in the source tree as historical references.

## Terminal entry point

- Run `npm pack` from this checkout, install the tarball with `npm install -g ./looms-rooms-0.2.15.tgz`, then type `looms` in the project directory. Choose a saved room or **New room** from the launcher. `looms --demo` opens a separate simulated room.
- Open `/accounts` and authorize ChatGPT plan usage in the browser. Select Claude, allow LOOMS to send room context to Claude Code, and complete the official Claude Code browser sign-in. Claude Code v2.1.248 or newer must be installed and on PATH. If you previously connected Claude Console, select Claude again to switch to your subscription. Claude Code manages sign-in in a dedicated local profile and executes room turns against the signed-in subscription. Gemini uses a Google AI Studio API key. Windows protects the LOOMS account vault with DPAPI. Other platforms use a file readable by the current account.
- Start a room with connected providers using `/room @codex @claude`. Use `/rooms` to reopen a saved room, `/include` to choose another connected provider, or `/include @gemini` to name one. `@chatgpt` is an alias for `@codex`.
- Type `/` for room commands or `@claude /` and `@codex /` for provider suggestions. Keep typing to filter, use Backspace to dismiss by deleting the slash, or use the arrow keys and Tab to complete a command. Claude Code contributes the catalog reported by the LOOMS session. Commands marked **Native CLI** run in the provider terminal.
- Use `@claude /skills` or `@codex /skills` to manage that agent’s skills in the current room. `/skills` shows assignments by agent. **Import local skill** accepts a folder containing `SKILL.md` or the file itself. For example, use `@claude /skills add "./skills/checkpoint-review"`. LOOMS saves a local copy of the Markdown, which you can enable for other agents from their pickers.
- Invoke an assigned skill with `@claude /checkpoint-review <task>` or select it from `@claude /`. The instructions are added to that agent’s turn under the current room permissions. The initial implementation supports portable Markdown instructions. Native provider skills and copying linked assets remain follow-up work.
- To install from a marketplace, run `/skills marketplace add anthropics/skills` then `@claude /skills install doc-coauthoring@anthropic-agent-skills`. You can also select **Install from marketplace** from `@claude /skills`. LOOMS pins the public GitHub source to a commit and downloads the selected `SKILL.md`. `@codex /skills install doc-coauthoring@anthropic-agent-skills` reuses that copy and enables it for Codex in the current room.
- Marketplace sources can be public GitHub repositories with `skills/<name>/SKILL.md` or compatible Claude manifests pointing to skills in the same repository. Use `owner/repo#ref` to choose a revision when registering. The installer handles Markdown instructions. Full plugin installs with hooks, MCP servers, or linked assets remain separate.
- A message starting with a room member's handle calls only that member. Multiple leading handles give each named member one turn. All replies remain visible in the shared transcript.
- A prompt's replies share a response box. When multiple agents reply, its tabs pin while you scroll within the box. Click a tab or use Tab and Shift+Tab to filter that box. Click **↑ Prompt** to return to the prompt.
- Use `@codex build the frontend, then ask Claude to review it` to order a handoff. LOOMS passes the previous step's output to the next model. A request like `Claude critique the website that Codex will build` starts with Codex.
- Use `/preview <task>` to see each model's initial prompt and estimated tokens locally. Add mentions to choose recipients. Summary and history can be trimmed for this send. **Send** starts fresh provider sessions, and ordered steps receive the prior reply once it is available. Choose **Edit** to revise the draft or **Cancel** to close.
- Scroll with the mouse wheel or Page Up and Page Down. Ctrl+Home and Ctrl+End jump to the start and end. The transcript renders Markdown headings, emphasis, lists, and inline code. Model code blocks are hidden in chat.
- Responses show file changes and shell command counts. Click **View diff** or use `/diff` to browse saved local diffs. Large text changes keep a clipped preview. Files with unavailable or private contents show the change without a diff.
- Ask a model to delegate a focused task to a subagent. Subagents return their findings to the calling model, use its model and effort, and have read-only workspace access. A round can launch up to two subagents.
- `/usage` shows Claude subscription limits and a link to ChatGPT's usage settings before the room's turn and token counts. `/model` chooses a model from the connected account's catalog. `/permissions` controls workspace access and starts in read-only mode.
- Choose **Ask before changes** in `/permissions` to review each proposed file write, deletion, and job verification command. Use the arrow keys to select **Allow once** or **Deny**, then press Enter. Esc denies the request. Piped sessions deny requests that require approval.
- Rooms persist an append-only log, shared `AGENTS.md` snapshots, and approved contract versions under `.room/<id>/`. The LOOMS room list can reopen existing workspace logs.
- Use `/job --plan <goal>` or `/job --planner @agent <goal>` to draft a structured plan. `/edit` applies a JSON Patch. In **Workspace edits** or **Ask before changes**, `/approve` starts the job and `/status` shows its progress. Structured jobs enforce the assigned paths on each task's file actions.
- Structured planners can read the project and see available agents, model and effort settings, enabled skills, room permissions, and past results from matching configurations in the current room. The plan pane shows the planner's reason and the recorded verification counts. A task can use an assigned skill under the job's existing permissions.
- Use `/job --prefer review @claude` to save a fallback assignment for a task type. `/job --prefer` lists preferences, and `/job --prefer review default` clears this one. The room records new outcomes after structured jobs run. Tasks completed without verification are marked unscored.
- Structured jobs in folders without Git use file locks for the task's owned paths. Approved verification commands take an exclusive workspace lock while they run. Git repos use per-task worktrees based on committed changes and merge into a room integration branch. `/status` shows the branch so you can inspect the result.

## Room MCP connections

Run `/mcp` in a room to see the configuration path. Create `mcp.json` there with an `mcpServers` object. Add a local stdio server with `command`, optional `args`, and optional `env`. Add a Streamable HTTP server with `url` and optional `headers`. Remote endpoints use HTTPS. Local loopback endpoints can use HTTP. Use configured headers for servers that accept a token.

Use `/mcp enable <server>` to give that room access to the named configuration. Choose **Workspace edits** in `/permissions`. `/mcp test <server>` opens the connection and lists its tools without calling one. Use `/mcp disable <server>` to revoke room access. Changing a server's definition requires enabling it again. `/mcp`, `@codex /mcp`, and `@claude /mcp` show room connection status.

Both agents can discover a server's tools and call them in ordinary room chat. Tools from a connected server can change external state and send their results to the provider servicing the turn. Use ordered prompts when both agents will edit the same project. **Read-only** and **Ask before changes** pause model access to external MCP tools. Model and provider sign-ins are managed in `/accounts`.

For Roblox Studio on Windows, enable Studio as an MCP server from Assistant settings, open the place you want to work on, and add this definition. See the [Roblox Studio MCP documentation](https://create.roblox.com/docs/studio/mcp) for the macOS launcher.

```json
{
  "mcpServers": {
    "Roblox_Studio": {
      "command": "cmd.exe",
      "args": ["/d", "/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]
    }
  }
}
```

Enable and test `Roblox_Studio` in the room. For example, ask `@codex inspect the current place and implement the change, then ask @claude to review it in the same place`.

## 1. Current code and migration

Add provider metadata in `room-services.mjs` and a transport entry in `looms-provider-api.mjs`. The room picker, target aliases, authentication UI, usage display, and response tabs use the registered provider. A native transport can report a shell launch through `context.recordShellCommand()`. Workspace tools capture edits for every transport.

| File | Current role | Planned change |
| --- | --- | --- |
| `agent-terminal.mjs` | CLI, provider processes, roster, command handling, and JSON-lines bridge | Extract room commands and provider adapters. Keep terminal input, rendering, and provider login/status commands at the CLI boundary. |
| `chat-room.mjs` | In-memory transcript and bounded round-robin turns | Run turns against the host's room state. Build prompts from the shared log and track cursors by provider session. |
| `room-job.mjs` | Delegated jobs, worker handoffs, and retry | Use the host to publish public results and keep coordination in job details. Preserve retry behavior while moving ownership into the host. |
| `Start-CCGPT.ps1` | WPF desktop that spawns its own chat backend | Attach to the workspace host and render its events. |
| `desktop-demo.mjs` | Simulated desktop replies | Keep the demo launch and drive its simulation through the same room protocol as live mode. |
| `chat-room.test.mjs`, `room-job.test.mjs` | Turn and job behavior tests | Keep both suites running as the host extraction proceeds. |

The in-process host owns the roster, provider sessions, chat and job transcript, and job state. It serializes incoming operations. The desktop and line-oriented terminal still start separate host instances until the local transport milestone.

## 2. Shared room host and transport

1. Add a Node room-host entry point and extract reusable Codex and Claude adapters from `agent-terminal.mjs`. The host owns the workspace path, room roster, transcript, provider sessions, active round, and pending inputs. Start with one room per canonical workspace path.
2. Listen on a local named pipe scoped to the workspace and current user. Both clients try to attach before launching a host. Ensure a second launch attaches to the existing instance, including simultaneous starts. Check the workspace identity during connection and restrict access to the current user.
3. Use UTF-8 JSON lines. Negotiate a protocol version before accepting commands. Carry a request ID on requests and acknowledgments so clients can match responses. Validate message types, text length, room identity, and command arguments in the host.
4. Serialize room mutations. Queue simultaneous sends in acceptance order and attribute each to its originating client. Closing a client leaves the room running. A user-issued stop cancels queued turns for the active round and interrupts the active provider call where supported. Preserve completed messages and publish the round's stopped status.
5. Preserve the existing `--chat-json` entry point as a compatibility bridge during migration. Keep diagnostics on stderr. Editing stays disabled by default. The workspace host's explicit write setting governs both clients, and attaching a client cannot elevate it. Display the active mode in each interface.

| Protocol operation | Behavior |
| --- | --- |
| Connect and subscribe | Return room ID, roster, permission mode, and active round status. Replay events after the client's last sequence number, then stream live events without a gap. |
| Send message | Acknowledge acceptance or rejection. Publish the user entry from the host and associate it with the round ID once scheduled. |
| Room event | Include room ID, monotonically increasing sequence number, type, and payload. Public transcript entries use `{id, speaker, text, ts}` with consecutive message IDs and ISO timestamps. Keep the entry shape consistent in callbacks and JSON output. |
| Turn and round status | Publish whose turn is active and when a round completes, stops, or encounters a failure. |
| Run command | Route roster changes, model settings, jobs, and room reset through the host so both clients see the same state. |

Render the host's copy of each message once. If a send is retried after a disconnect, reuse the request ID and deduplicate it at the host.

## 3. Persistence and recovery

- Store a versioned, append-only room log under a workspace-local state directory excluded from version control. Record public messages, roster changes, and round lifecycle events. Keep session IDs and provider credentials out of the shared transcript. Provider authentication stays with the provider tools.
- Append events before acknowledging durable changes or broadcasting them. On startup, replay valid events, restore sequence numbers and roster, and handle an incomplete trailing record explicitly. Surface errors reading earlier records so recovery cannot silently discard history.
- Mark rounds interrupted by host shutdown as interrupted. Preserve the transcript and leave automatic re-execution off. Deduplicate acknowledged sends across restarts using their logged request IDs.
- Define `/new` as starting a fresh conversation and provider sessions, while retaining the previous conversation in storage. Keep the active room's event sequence monotonic across the reset so connected or reconnecting clients can apply it in order.
- Initially keep job retry state for the lifetime of the host. Show that state in job status and distinguish jobs interrupted by a host restart from jobs that can still be retried in place.

## 4. Shared model context and turn scheduling

1. **Build the prompt from the room.** Extract `buildPrompt(name, names, updates, {catchUp})` into `chat-room.mjs`. Include the model's handle, other room members, workspace path, the current request, and relevant peer messages. Keep speaker attribution and distinct sections for instructions and transcript. Ask for a short reply or `PASS` when a model has nothing to add.
2. **Track a cursor per provider session.** While a session is healthy, send new transcript entries since its last successful turn and skip its own prior replies. Capture the sequence number of the last entry included and only advance the cursor to that point after success. A failed turn leaves the cursor unchanged.
3. **Rebuild context after recreation.** Call `forget(name)` before rebuilding the prompt when `ask()` replaces a failed Codex session, when Claude resume fails and clears its session ID, and from `resetMember()`. Apply the same catch-up logic to new members, configuration changes, and host restarts. Send the summary and recent entries, including the model's own earlier replies, under a header identifying it as joining or rejoining.
4. **Bound the context.** Start with about 8,000 estimated tokens per turn using characters divided by four as a rough estimate. Select newest entries first, preserve the current request, then render in chronological order. For entries over about 2,000 tokens, keep up to 40 lines from each end and a truncation marker. Apply a character cap as well for unusually long lines. Once unsummarized history exceeds about 40,000 estimated tokens or 200 entries, have the first room member summarize the older prefix while preserving the latest 20 entries. Record the result as a system summary with the sequence number it covers and retain the full log on disk. Advance the summarized boundary so the same prefix is processed once. On provider context overflow, reset that session and retry once with a smaller catch-up packet.
5. **Run one model at a time.** Parse case-insensitive mentions at handle boundaries and accept handles present in the room. User mentions take priority in the order written, followed by an eligible peer mentioned in the latest reply, then room order after the last speaker. Ignore unknown handles and let `@all` and `@both` keep the default order. Prevent consecutive turns by the same model. Use the existing six-turn default as the round budget.
6. **End the round predictably.** Stop after a full lap of passes or skips following the last reply, when the turn budget runs out, or when the user stops the round. Skip calls when a model has no new context. Publish attributed provider failure notices as status events outside the transcript used in prompts. After two consecutive failures from a model in one round, skip it for the rest of that round.
7. **Support cancellation.** Pass an `AbortSignal` to the turn loop. On abort, start no further turns, discard late provider output, and resolve the round once. If an in-flight provider call might have advanced private session state, reset that session before its next turn. The interactive CLI uses Ctrl+C to stop the active round while keeping the room open. The legacy `--chat-json` bridge accepts `{"cancel":true}` and treats a second `{text}` received mid-round as a replacement. Read input while the round runs and emit exactly one ordered `{"done":true}` per round. The shared host queues regular sends and uses a separate stop request so one client can send without interrupting another.

Example acceptance scenario. The user asks how `/clear` should work. Codex proposes clearing the visible conversation. Claude receives the request and Codex's reply, then suggests resetting model context too. Codex receives Claude's feedback and revises its proposal. Both models pass or have no new context, and the host closes the round.

## 5. Client changes

- **Terminal.** Use OpenCode's TUI, composer, slash completion, command palette, and keyboard navigation. Register `/room` and `/room-new` as native entry points. Room commands such as `/job` can be passed as `/room /job <task>`. Use `@name` in room prompts to prioritize a model. Move the room model onto the shared transport and add roster and turn details. Keep the line-oriented mode for pipes, login and status commands, and smoke tests.
- **Desktop.** Update `Start-CCGPT.ps1` to attach before replaying the room. Render user and model messages from the stream, preserve multiline input, and show queued, active, and stopped states. Keep the composer text when delivery fails. Reconnect using the last rendered sequence number and show the live roster from the host.
- **Demo.** Start a room with deterministic simulated Codex and Claude adapters. Script the second model to reference the first reply so a demo proves that context reaches peers. Use this mode for both interfaces without requiring provider installs or accounts.

## 6. Delivery milestones

| Milestone | Work | Exit criteria |
| --- | --- | --- |
| 1. Extract one room | Move state and provider adapters behind a host interface. Consolidate public messages. | With simulated models, chat, mentions, and public job results appear in one ordered history. Existing job and chat tests pass. |
| 2. Share it across clients | Add local transport, replay, sequential event IDs, queued sends, and durable storage. | Terminal and desktop see identical events, reconnect without duplicates, and restore history after a host restart. |
| 3. Make turns and sessions reliable | Add mention priority, session-aware cursors, replay after session loss, bounded context, and stop behavior. | Models react to peer replies, recovery restores relevant context, and rounds end within the budget. |
| 4. Finish the client experience | Add the terminal UI and polish desktop status, error, and reconnect behavior. | Both interfaces can send, follow turn progress, and rejoin the same room. The line-oriented demo remains usable. |
| 5. Verify live providers | Check provider commands and login, then run a short live round with both models. | Both respond, at least one references the other's reply, and the round ends on its own. |

## 7. End-to-end acceptance checks

- Run `node --test chat-room.test.mjs room-job.test.mjs`. Add host integration coverage for the scenarios below as each milestone lands.
- Connect a terminal and a desktop client to the same workspace using simulated providers. Send from each interface. Assert that both receive the same IDs, speaker labels, text, and order. Open a different workspace and verify its room is independent.
- Send concurrently from both clients. Check acceptance order, one user event per request, one active round at a time, and deduplication after retrying an acknowledged send.
- Disconnect a client during a round and reconnect. Confirm it receives missed events in order. Restart the host and confirm transcript and roster replay, monotonic sequence numbers, and interrupted rounds that remain stopped.
- Capture model prompts in the simulator. Assert that the second model sees the user and first model, that mention priority works within the turn budget, and that a fresh session receives the summary and recent context. Force a provider error and an overflow, then check failure attribution, recovery, and continued progress by the peer.
- Stub `ask()` in `chat-room.test.mjs`. With `[a,b,c]`, verify that `@c hi` starts with `c`, a reply asking `@c` moves it ahead of `b`, unknown mentions have no effect, and turns never repeat a model consecutively. Assert consecutive entry IDs and that the header lists peers. Compare warm-session prompts with catch-up prompts for forgotten and newly added models, including how each treats the model's own replies.
- Feed 100 large entries into the prompt builder and verify that the newest entry survives within budget and long lines are truncated. Cross the summary threshold and verify one summary for that prefix. Simulate one context overflow and expect one retry and one posted reply. Simulate persistent failure and expect at most two notices for that model while peers finish.
- Stop a round during an active turn and verify that no additional turn starts for it. Confirm the transcript remains usable and another message can run.
- For the legacy bridge, send a second `{text}` mid-round. Verify that the first round drops late output and each round emits exactly one `done` in order. For the desktop, verify speaker labels, Send disabled until completion in compatibility mode, and diagnostic stderr kept out of chat.
- Launch the live room with provider authentication and read-only mode. Send a prompt asking both models to greet each other and reference the previous reply where applicable. Verify the two replies and terminal round status in both clients.
- In the live CLI, run `/chat @claude ask codex for a one-line haiku` and verify Claude goes first and the round ends within six turns. Restart the Codex app-server during a conversation, then ask what the room just discussed and verify that the recreated session uses the catch-up history.

Previous Windows smoke tests reached the chat backend and reported that `codex` and `claude` were unavailable on the command path. Treat provider availability and login as prerequisites for the live milestone. The simulator covers the shared-room flow while those prerequisites are resolved.
