# Build spec conflicts

| Spec | Existing behavior retained |
| --- | --- |
| §3.1, §4.1–4.4 | Ordinary room chat uses a bounded, sequential round. Leading handles direct a message to the named members. Within an ordinary round, a peer mention may influence turn order. Parallel job workers use one snapshot per run start. |
| §3.2 | Warm provider sessions receive unread messages and skip their own prior replies. The prompt uses a bounded window of the unread messages. A fresh session receives recent context from the room. |
| §3, OpenCode history | OpenCode's undo, fork, and history changes can change the active context. The room records a conversation rebase and appends the replacement transcript while retaining every earlier record. The line-oriented `/new` starts a fresh active conversation with a logged reset. |
| §6–7, §10–11 | The existing `/job <goal>` delegates work immediately and uses JSON worker responses and delivery checks. `/retry` takes a numeric job ID. `/job --plan <goal>` and `/job --planner @agent <goal>` use the new validated planning flow. |
| §12 | The room launches each vendor's CLI with its existing login. Codex and Claude keep conversation processes warm, with Claude resume on an idle exit. Missing provider usage and costs are omitted from log records. |

The handoff describes an existing summarizer. This checkout had a prompt builder and persisted room settings. M2 added the room-scoped `AGENTS.md` writer.

## Summary behavior

- A round's snapshot is the input its runs consumed. It is copied at the start of that round and retained. The output from summarizing a completed round updates the live `AGENTS.md` and becomes the next round's input.
- The byte cap is conservative for byte-based tokenizers. If pinned sections alone exceed the cap, the prior summary is retained. Decisions remain verbatim in `decisions.jsonl`.
- The model summarizer is opt-in through `CCGPT_ROOM_SUMMARIZER=provider:model`. Without that setting, the room uses log-backed progress and code-generated sections. A default model and vendor policy are still open.

## Contract approval

- The room's planner may approve contract changes. The human can also approve one with `/contract approve <proposal-message-id>`. The default planner is the first room member, consistent with the existing job lead. A structured job can name a different planner.
- Approved proposals produce a versioned contract file and a `contract.updated` event. Scheduler behavior for tasks affected by a contract update belongs to the task scheduling work.

## Structured execution

- The scheduler uses file locks in folders without Git and separate worktrees in Git repos. The room's **Workspace edits** mode enables structured execution. Worktrees fork from committed history and merge into a job-specific room integration branch.
- Branch names include room, job, and task IDs so repeated plans with the same task IDs can coexist. Verification in lock mode pauses other structured task writes in that folder while the approved command runs.
