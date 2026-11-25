![LOOMS pixel wordmark](docs/assets/looms.png)

# LOOMS

LOOMS puts Claude, Codex, and Gemini in a shared terminal room. Choose who plans, builds, or reviews, then let the room carry the goal, decisions, and results between them. You can start with one connected agent and add others when the work calls for them.

## Install

You'll need Node.js 22 or newer, npm, and Git. These commands install LOOMS from this repository.

```sh
git clone https://github.com/thiendangnn63/LOOMS.git
cd LOOMS
npm ci
npm pack
npm install -g ./looms-rooms-0.2.16.tgz
looms --version
```

Open a project folder and type `looms`. You can also pass the project path to `looms`. Try `looms --demo` for a simulated room with no provider sign-in.

## Connect and start a room

1. Open **Provider accounts** in the room picker or type `/accounts`.
2. Connect the providers you want to use.
   - **Codex** uses **Sign in with ChatGPT** and requests permission to use your plan.
   - **Claude** uses the installed Claude Code CLI. Install Claude Code 2.1.248 or newer, make sure it's on your PATH, and complete its browser sign-in from LOOMS.
   - **Gemini** uses a Google AI Studio API key.
3. Select **New room** or type `/room @codex @claude` to pick the participants directly.

Use `/rooms` to reopen a room, `/include @gemini` to add an agent, and `/model` to set each agent’s model and effort. `/usage` shows room token counts and provider limits where available.

## Work effectively

**Direct work to the right agent.** Start with `@claude` to ask just Claude. Use `@codex @claude` to request both perspectives. This prompt makes the handoff explicit.

```text
@codex fix the pagination bug and add a regression test, then ask @claude to review the patch
```

**Preview the context.** Use `/preview @codex <task>` to inspect the prompt and estimated room-context tokens before sending. You can exclude the shared summary or recent history for that send. The estimate covers the room text shown in the preview.

**Review edits.** Rooms start in **Read-only**. Use `/permissions` to select **Ask before changes** or **Workspace edits**. Click **View diff** after a file change or type `/diff` to browse saved patches. In a multi-agent reply, use the response tabs to switch speakers.

### Plan a job

```text
/job --prefer review @claude
/job --plan Fix the pagination regression and verify that later pages load correctly
```

The planner inspects the project and proposes tasks, owners, dependencies, and verification commands. The plan shows each assignment’s rationale and comparable results recorded in the room. Use `/edit` to adjust the plan, set the room access you want in `/permissions`, and type `/approve` to run it. Use `/status` to follow progress. Plain `/job <goal>` uses immediate delegation.

Structured jobs use committed Git history to create task worktrees and merge into a room integration branch shown in `/status`. In a folder without Git, they use file locks. Review the integration branch before bringing the result into your working branch.

## Skills and tools

Use `@claude /skills` or `@codex /skills` to manage that agent’s skills in the current room. You can import a local `SKILL.md` or choose **Install from marketplace**. These commands install a documentation skill for Claude and run it.

```text
/skills marketplace add anthropics/skills
@claude /skills install doc-coauthoring@anthropic-agent-skills
@claude /doc-coauthoring Draft a contributor guide from the project docs
```

A marketplace install uses a pinned public GitHub revision and copies the portable Markdown instructions. Assignments are per agent and room. A second agent can reuse the downloaded copy.

Use `/mcp` to find the profile’s `mcp.json` path. Configured servers go under `mcpServers`. A local server takes `command` and optional `args` or `env`. A Streamable HTTP server takes `url` and optional `headers`. Remote endpoints use HTTPS. Then run `/mcp enable <server>` and `/mcp test <server>`. Enabled external MCP tools are available to agents in ordinary chat with **Workspace edits**.

## Good to know

- Type `/` or `@agent /` for command suggestions. Keep typing to filter, use Tab to complete, or Backspace over the slash to dismiss. Commands labeled **Native CLI** run in the provider’s own terminal.
- Room logs, decisions, and shared context live under `.room/` in the workspace. LOOMS sends task context to the agents handling the turn. Tool results can be included in that context when an agent uses an enabled MCP server.
- Account connections and skill downloads are stored in your local LOOMS profile. Keep that profile and `.room/` out of shared repositories.

## Development

The CLI entry point is in `bin/`, with the app, terminal UI, provider connections, room engine, and skills in `src/`. Run `npm test` from the checkout to run the tests in `test/`.
