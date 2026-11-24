# Team mode (multi-model orchestration)

Team mode lets one chat use several models together. Open it from the **Team** button next to the model picker (or `/team`).

- **Orchestrator**: the chat's own model. It talks to you, runs Marion's tools (computer, apps, files), splits the work and checks the results. Any model works: local, Codex, Gemini or Claude.
- **Team members**: up to 6 models of any kind, each with a name and a role (Coder, Reviewer, …). Members are text-only: the vendor CLIs stay in their restricted chat modes and only the orchestrator can run tools.

## How they work together

- `team_delegate` hands out tasks. `parallel` runs independent pieces at once; `chain` runs them in order, and each member sees the previous one's work (write → review → fix).
- `team_discuss` makes members take turns on one problem for 1–3 rounds and end with a shared recommendation.
- Every member sees the user's goal and a shared **team board** (what teammates already said in this chat), so they build on each other's work. Their replies appear in the chat as "Name · team member".

## Making plans last longer

- With **Balance plan usage** on, tasks for member `auto` go to whoever has the most plan left (from the same readings as the usage window). Local models count as unlimited.
- When a member hits a usage limit or fails, its task moves to another member automatically (preferring a different provider), and that member rests for 30 minutes (3 minutes after other errors).
- If the orchestrator itself runs out, a team member takes over orchestrating for the rest of the turn.

## Backup: T3 Code

T3 Code runs coding agents side by side in separate worktrees, but it doesn't make them talk to each other. If it's installed, the Team window has an **Open** button for the jobs Team mode can't do.

## Privacy

Claude Code runs with `--no-session-persistence`, and Codex threads are `ephemeral`, so neither keeps a local copy of Marion chats. Antigravity (Gemini) has no such switch, so after each reply Marion deletes the conversation Antigravity saved for Marion's temporary folder. Provider-side retention still follows each provider's own account terms.
