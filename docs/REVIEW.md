# Marion Agent feature review

This review covers the native Mac app, the source it packages, the installation files, and the separate `from scratch` prototype. It leaves feature-removal decisions open.

## Main workspace

| Feature | What is in the code | Recommendation |
| --- | --- | --- |
| Native Mac window | Finder and Dock launch, one set of macOS window controls, and a local workspace opened automatically | Keep. |
| Bot chats and sidebar | Create and pin bots, find them by name or role, view past chats, send messages, stop a reply, and start a fresh chat | Keep. |
| Appearance and navigation | Light and dark modes, bot avatars, collapsible sidebar, details panel, and keyboard shortcuts | Keep. |
| Bot identity and history | Editable role and instructions, stored transcripts and message history, and local SQLite storage | Keep. |
| Provider choice | Local inference with Marion tools, or text chat through the installed Codex, Gemini, or Claude Code CLI. | Keep. |
| Approval controls | Marion asks for approval for actions as configured. User responses and tool outcomes appear in the transcript. | Keep with any feature that can take actions. |

## Decisions

| Feature | What it adds | Suggested decision |
| --- | --- | --- |
| Docker desktop and live viewer | A persistent Linux workspace per bot, a live screen, watch or take-control mode, and idle hibernation. Requires Docker and the Marion desktop image. | Keep if a bot should use a browser or manage files. This is the biggest operational dependency. |
| Bot Library | Downloads, folders, and files produced in each bot’s Linux workspace | Keep with the Docker desktop. |
| Bot memory and skills | Saved facts, a background consolidation job, transcript compaction, and reusable instructions per bot | Keep saved memories and instructions. Consider removing background consolidation if you prefer manual memory. |
| Groups, delegation, and subagents | Bot group chats, direct bot-to-bot handoffs, and child bots that do focused work | Remove first if you mostly use one bot. The individual bot chats are independent. |
| Tasks | A task view and status tracking that bots can update | Keep if you use Marion to track work across chats. |
| Routines and proactive check-ins | Scheduled prompts, automatic briefings, and a scheduler that runs when Marion is open | Remove if you want Marion to act only when prompted. |
| Composio and event triggers | Connect external accounts, call app tools, and start routines from events such as incoming messages. Requires a Composio project key. | Keep only if you want operator-level app integrations. Google account login for the hosted Marion site is a separate flow. |
| Voice | Microphone selection, dictation, and push-to-talk through local speech software. Optional realtime calling uses xAI. | Keep dictation if useful. Realtime calls are a separate removal candidate. |
| Ask Grok | Sends an approved prompt to xAI using a configured API key | Remove if the plan is to avoid metered provider calls. |
| Web login, PWA, Windows launcher, and hosting | The browser version, email sign-in for local development, Google sign-in for the hosted path, installation in a browser, and deployment instructions | Remove if Marion will stay Mac-only. The installed Mac app uses its local workspace automatically. |
| `from scratch` prototype | A second UI and server with a separate SQLite database, its own model adapters and routines, and a private iPhone bridge | Archive after checking whether it has chats or settings you want to keep. It runs separately from the installed app. |

## Folder cleanup candidates

- The native installer ZIP, its extracted folder, the source ZIP, and the source browser launcher are distinct pieces of distribution. The two launchers share the same display name. Keep the native installer ZIP for reinstalling and the source tree for development. Archive old release copies once you have a working replacement.
- The installer carries compiled JavaScript and dependencies. Rebuild its payload from the checked source before publishing a new ZIP.
- The root `LICENSE` file contains no usable license terms. Decide which terms you want before distributing the source.
- Older architecture and xAI cost notes cover historical configurations. Keep them for reference if you plan to revisit those setups.

The folder review found no Docker installation on this Mac, so the live Linux desktop and its Library workflow need a Docker-enabled test. Local model and speech integration were exercised with test endpoints. The separate prototype’s four automated tests passed.
