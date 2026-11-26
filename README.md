# Marion Agent

Chat with local models or your Codex, Gemini, and Claude subscriptions. Give each bot a persistent Linux desktop, review its actions, and download its files from the Library.

## Install on macOS

Extract **Marion-Agent-Mac-Installer.zip** and open **Install Marion Agent.command**. For an update, quit Marion Agent first. The installer verifies the downloaded runtimes and opens the app. The workspace lives in **Library → Application Support → Marion Agent**.

Install Docker Desktop or configure Colima to use the bot desktops. Marion builds the desktop image on first wake and can start an already-configured Colima context on demand.

## Run from source on Windows, macOS, or Linux

Use Node.js 24 and install Docker if you need bot desktops. On Windows, enable the WSL 2 backend and Linux containers in Docker Desktop. Run these commands from the repository or the extracted **Marion Agent.zip**.

```powershell
npm.cmd ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run build
npm.cmd start
```

On macOS or Linux, use `npm` in place of `npm.cmd` and `test -f .env || cp .env.example .env` to create the local configuration. To build the desktop image ahead of time, run `docker build -t marion-agent-desktop:local desktop`.

Open http://127.0.0.1:8787 and sign in with a local email address. Choose a bot, open **Bot's computer**, and click **Wake computer**. The launchers in the source folder can start the app after building. The Mac launcher opens the native app when installed. You can also install the browser version from Chrome or Edge, or use **File → Add to Dock** in Safari on macOS Sonoma or later.

## Models and connected apps

Use the picker above the composer to set a chat's provider, model, and reasoning effort. Set defaults under **Settings → Models**. Groups and background memory tasks use the local model.

- **Local models** use an OpenAI-compatible streaming Responses endpoint. Set the address and exact model ID in the app's configuration. See [Local models and speech](docs/LOCAL-MODELS.md).
- **Codex** uses the signed-in CLI bundled with the ChatGPT Mac app or a standalone CLI in your PATH. See [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli).
- **Gemini** uses the Antigravity CLI. Run `agy acp --login` and select the personal Google account with your plan. See [Antigravity authentication](https://antigravity.google/docs/ide/extensions/acp/#authentication).
- **Claude Code** uses the installed CLI. Run `claude auth login --claudeai` and choose **Claude Code · Claude plan** in Marion. See [Claude Code authentication](https://code.claude.com/docs/en/authentication).
- **Connected apps** use a Composio project key. In **Settings → Connected apps**, verify and save the key, then choose **Link an app**. For hosted setups, `COMPOSIO_API_KEY` also enables Google sign-in. See [Composio's toolkit catalog](https://docs.composio.dev/toolkits).
- **xAI** is optional. `XAI_API_KEY` enables the approval-gated Grok tool and hosted speech and realtime voice.

## Project actions on macOS

- **Usage-limit handoff:** When a relayed Claude, Codex, or Gemini run hits its limit, Marion saves a private JSON handoff in the app data’s `handoffs/` directory and offers to continue in chat. Save a preferred fallback under **Settings → Models**. **Auto-handoff** is off by default; enable it there to run the fallback without asking. A fallback that also hits a limit needs a manual switch.
- **Claude Cloud:** In a bot chat, open **Sessions → Start Claude Cloud…**. Use a recent Claude Code CLI signed in to a Claude account with Cloud and headless connected sessions enabled. Marion tracks the run and links to it in both Sessions views. If Marion disconnects, check Claude for the remote session's current status.
- **GitHub:** In the workspace account menu, choose **Create GitHub repository…**. Install `gh` and sign in with `gh auth login`. You can create an empty repository or review and publish a local folder’s current branch and history. Bots can request approval to create an empty repository, but publishing a local folder requires the form.

## Workspace controls

- Open **+ → Start from a template** to create a bot with ready-made instructions, skills, and routines. Template routines start paused. Bot profiles export as `.marionbot.json` for importing elsewhere.
- Use **Executive** in a bot's settings for bot-to-bot coordination. Use **Team** next to the model picker when one chat should delegate to several models. See [Team mode](docs/ORCHESTRATION.md).
- Choose **Teach by screen recording** or type `/teach` to turn a demonstration into a skill. Use **Learn from chat** to save lessons, and **Compact now** to summarize older context.
- Open **Settings → Audio** to choose a microphone or enable interface sounds. Tap the composer mic or use **Command+Shift+D** (Windows key+Shift+D on Windows) to dictate. Configure the shortcut under **Settings → Shortcuts**. Dictation keeps running when you switch to another chat; the words go into the chat you switched to. Leaving chat (for example, opening Tasks or Sessions) stops dictation and keeps the text already in your draft.
- In the Mac app, press **Command+Shift+S** (Ctrl+Shift+S elsewhere) to open your three most recent screenshots from the Mac's Screenshot folder and attach one to the current chat with a click (or press 1, 2, 3). **Browse all screenshots** shows the full history. The `/screenshots` command and the **+** menu open the same picker.
- Use **Share** to copy or download a transcript. Sort or reorder chats from the sidebar. Manage reply, approval, and routine alerts under **Settings → Notifications**.

## iPhone and browser access

The Mac must stay awake and run Marion Agent. Open its workspace through an authenticated private HTTPS proxy. For iPhone, add it to your Home Screen from Safari and enable push in **Settings → Notifications**. Pair with the address and passphrase under **Settings → General → iPhone access**.

To configure iPhone access, set `MARION_MOBILE_ORIGIN` to the exact HTTPS origin and `MARION_MOBILE_PASSPHRASE` to a random passphrase of at least 24 characters in the configuration under **Open App Data Folder**, then restart the app. Point the proxy at `http://127.0.0.1:8789`, preserve the HTTPS hostname in the forwarded Host header, set `X-Forwarded-Proto: https`, and forward event streams and WebSocket upgrades. See [Browser access from another laptop](docs/BROWSER-ACCESS.md) and [Desktop hosting](docs/DESKTOP-HOSTING.md).

## Marion Life

In Marion Life, go to **Settings → Connections → Marion Agent** and create a link key. Paste it into **Settings → Marion Life** in Marion Agent and connect. Changed chats sync through the Marion Life API for Second Brain search. If you previously used a Supabase service key, reconnect with a Marion Life key.

## Development

- `server/src/` contains the Hono API, SQLite storage, model integrations, and agent loop. `web/src/` contains the React UI. `desktop/` builds the Linux workspaces. See [Architecture](docs/ARCHITECTURE.md).
- Run `npm run typecheck` and `npm run build`. For hot reload, set `APP_URL=http://127.0.0.1:5173` in the local configuration, then run `npm run dev -w server` and `npm run dev -w web -- --host 127.0.0.1` in separate terminals.
- After building, run `node tests/features.mjs`, `node tests/local-model.mjs`, and `node tests/desktop-workspace.mjs` for isolated checks. Install Playwright browsers for the UI tests. `node tests/local-desktop.mjs` needs Docker and a running server with a disposable `DB_PATH`; set `CLEANUP_TEST_DESKTOPS=1` to remove its test containers, volumes, and networks.
- On macOS with a working Swift toolchain, run `scripts/package-distributions.sh` after `npm ci`. In a Git checkout it builds the committed snapshot at HEAD (not uncommitted edits). It writes the source and installer ZIPs under `releases/`. The installer directory holds the launcher, Electron wrapper, plist, and app icon.

See [Security](SECURITY.md) before exposing a workspace and [Third-party notices](THIRD_PARTY_NOTICES.md) for attribution.
