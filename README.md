# Marion Agent

Marion Agent gives each bot a private, persistent Linux desktop. From the web app you can watch or take control of a desktop, organize bots, and download files from their Libraries.

This folder is the canonical Marion Agent source. The Mac installer, Windows launcher, and responsive web app use its `server` and `web` builds. `from scratch` is a historical prototype with its own database and is excluded from both distributions.

In **Settings → General**, choose System, Porcelain, Obsidian, Moss, Parchment, Fig, or Slate. When creating or editing a bot, choose a berry avatar and its body color. Turn **Show stem** on or off and use **Stem color** to customize it.

## Run on Windows

Install [Node.js 24 LTS](https://nodejs.org/) and [Docker Desktop with the WSL 2 backend](https://docs.docker.com/desktop/setup/install/windows-install/). Open Docker Desktop and enable Linux containers. Docker Desktop has [eligibility rules for free use](https://docs.docker.com/subscription/desktop-license/).

Extract the project ZIP into a folder named `Marion Agent` on your Desktop. Open PowerShell in that folder, then run:

```powershell
npm.cmd ci
docker build -t marion-agent-desktop:local desktop
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run build
npm.cmd start
```

On Linux or macOS, run the same npm and Docker commands using `npm` and use `test -f .env || cp .env.example .env`.

Open http://127.0.0.1:8787 on the same machine. Sign in with your email using local sign-in, select Barry or create a bot, open **Bot's computer**, and click **Wake computer**. **Take control** allows you to use the desktop directly. Keep the terminal and Docker running while you use the app.

Each desktop uses a separate Docker container, network, and workspace volume. Browser profiles and Library files under `/workspace` persist when the desktop stops. PowerShell commands remain on the host. Commands issued by a bot run as an unprivileged user inside that bot's container. The default limit is 2 GiB of RAM and 2 CPUs per running desktop.

## Install the app or use the launcher

On macOS, extract **Marion-Agent-Mac-Installer.zip** and open **Install Marion Agent.command** inside the extracted installer folder. The installer downloads and verifies the native runtimes, installs **Marion Agent.app**, and opens the local workspace directly. Marion keeps its database in **Library → Application Support → Marion Agent**. Use Docker Desktop or Colima to run the Linux desktops on the Mac. Marion builds the default image on the first wake if it is missing and can start an already-configured Colima context on demand. The desktop window authorizes the loopback server, so the workspace needs no email or name.

For Mac updates, quit Marion Agent and run the installer. It updates the existing app at the same path and uses your existing workspace.

The source ZIP includes **Launch Marion Agent.command** on macOS. It opens the installed app when available. For the browser fallback, keep the command alongside `scripts`, `server`, and `web`, then run `npm ci` and `npm run build`. On Windows, double-click **Launch Marion Agent.cmd** after building. Leave its window running while you use Marion Agent.

For a standalone app window, start the server and install Marion Agent from the browser's app menu in Chrome or Edge, or select **File → Add to Dock** in Safari on macOS Sonoma or later. The installed window needs the local server to be running. Press **Ctrl+R** or **⌘R** to reload it. After updating source files, run `npm run build` first. Restart the server for backend changes.

## iPhone

Open the same Mac workspace through a private HTTPS reverse proxy and add it to your Home Screen from Safari. Keep Marion Agent running on the Mac. If **Settings → General → iPhone access** shows an address, use it and reveal the pairing passphrase there.

To set up a private address, configure `MARION_MOBILE_ORIGIN` with the exact HTTPS origin and `MARION_MOBILE_PASSPHRASE` with a randomly generated passphrase of at least 24 characters in the Mac app’s existing configuration in **Open App Data Folder**. Quit and reopen Marion Agent to load the configuration.

Point the authenticated, private HTTPS proxy at `http://127.0.0.1:8789`. Preserve the HTTPS hostname in the upstream `Host` header, set `X-Forwarded-Proto: https`, and forward event streams and WebSocket upgrades. Keep the loopback port private. Open the HTTPS address on the iPhone and pair it with the workspace passphrase. The phone uses the same chats, models and database as the Mac. Swipe right to star a chat and left to reveal its delete action.

## Another laptop

Use a browser over an approved HTTPS connection. The Mac serves the same workspace and stays responsible for SQLite, models, and connected apps. A browser is sufficient on the second laptop, and Supabase is unnecessary. See [Set up browser access](docs/BROWSER-ACCESS.md) for the Mac configuration and an identity-gated Cloudflare Tunnel.

## Use a subscription for chat

Use the model and effort menus above the message box. Marion saves your provider, model, and reasoning effort per chat. Chats without a model override follow the default provider, model, and reasoning effort in Settings. A chat override stays selected until you change it. Local models come from the configured inference server.

Use **Sort chats** to switch between recent activity, name, and custom order. Hold and drag a row to set a custom order, or use **Move up** and **Move down** from a chat’s context menu. Starred chats appear first and return to their saved position when unstarred.

In the native Mac app, open **Settings → Models → Default chat provider**.

- For **Codex**, sign in to ChatGPT. Marion uses the Codex CLI bundled with the ChatGPT app when it is installed in Applications. The standalone CLI is also supported. The signed-in account and installed client determine the model list. [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli)
- For **Gemini**, install Google's Antigravity CLI and run `agy acp --login` in Terminal. Choose your personal Google account for Google AI plan usage. If the command is outside Terminal's PATH, run `~/.local/bin/agy acp --login`. Give the one-time code directly to the CLI prompt. [Antigravity authentication](https://antigravity.google/docs/ide/extensions/acp/#authentication)
- For **Claude Code**, run `claude auth login --claudeai` in Terminal and sign into your Claude subscription. Then choose **Claude Code · Claude plan**. Marion invokes the installed Claude Code CLI from the native Mac app and checks that it reports a subscription before submitting a message. [Claude Code authentication](https://code.claude.com/docs/en/authentication)

The selected model handles the individual bot’s chat, push-to-talk replies, and tool requests. Marion runs desktop actions on the bot’s own Linux workspace and handles approvals for connected apps or delegation to Claude Code, Codex, or Gemini. Each subscription uses its signed-in CLI. Group chats and background memory jobs use the local model.

Use **Share** in a chat to copy or download the current conversation as text. In **Recent activity** order, a bot moves up when it finishes and Marion shows a completion notice.

## Templates, teams and teaching

- **Templates.** Choose **+ → Start from a template** for a ready-made Bot: **Bot Builder** (asks a few questions, then creates a focused Bot for you), **Executive**, **Researcher**, **Inbox Helper** or **Code Liaison**. Each template page shows its Instructions, Memories, Skills, Routines and Integrations; **Import Bot** adds it to your team. Template routines start paused.
- **Profiles.** Click a Bot's name in the details panel (or right-click a chat → **View profile**) to see the same page for any Bot. The share button exports it as a `.marionbot.json` file that **Import file** on the template page turns back into a Bot.
- **Teams.** Turn on **Executive** in a Bot's settings to make it coordinate the others. Bots message each other with `send_to_bot`; the answer goes back to the asker automatically. A chain of hand-offs stops after 8 steps and two Bots can exchange at most 30 messages in 10 minutes, so Bots can't loop forever.
- **Teach by screen recording.** Choose **+ → Teach by screen recording** (or `/teach`), do the task once while talking it through, and press Stop. Marion keeps up to 12 key moments and your narration, sends them to the Bot, and the Bot saves the process as a skill. The Mac asks once for Screen Recording permission.
- **Self-improvement.** After a chat goes quiet, each Bot turns corrections and lessons from it into its **Lessons learned** skill and updates its other skills. **Learn from chat** in the details panel does it right away.
- **Context.** Each chat shows how many tokens it sends per reply (0 to 1M) in the chat list and the details panel. **Compact now** summarizes older messages; **Auto-compacts at** sets the size per Bot (or Never).
- **Computer sleep.** The switch under **Bot's computer** puts that Bot's Linux desktop to sleep or wakes it. A sleeping desktop wakes by itself when the Bot needs it.

## Notifications

**Settings → Notifications** turns on Mac banners (shown while Marion Agent is in the background) and chooses which events notify: replies, approvals, questions, problems, routines, Bot hand-offs and self-improvement. For iPhone, open Marion Agent from its Home Screen icon over your private HTTPS address, go to **Settings → Notifications** and choose **Turn on**. Quiet hours pause phone notifications.

## Marion Life

Chats can be copied into the Marion Life database so its Second Brain can find them. Run `docs/marion-life-agent-chats.sql` once in Supabase → SQL Editor, then fill in **Settings → Marion Life** with the project URL, the service role key (it stays on this Mac) and your Marion Life email. Changed chats are copied about a minute after each reply.

## Connect apps and audio

- Open **Settings → Connected apps**. Paste a Composio project key, choose **Verify and save**, then **Link an app** and approve the provider's authorization form. Composio needs a project key once. Individual OAuth apps are then linked without pasting each app's token into Marion Agent. Hosted deployments configure `COMPOSIO_API_KEY` on the server.
- Open **Settings → Models** to see models advertised by your configured local server and select one for your account. Start the runtime on the same PC or Mac first. The runtime must support streaming Responses and the selected model must support the tools you need.
- Open **Settings → Audio**, choose the microphone and select **Test microphone**. Dictation and calls share the selected input. Changing the selection applies on the next recording or call.
- On supported Macs with macOS 26 or later, the desktop app includes on-device dictation and system voice playback. The first recording can take longer while macOS prepares its language files. To use a different speech backend, set `MARION_STT_URL` to a Whisper-compatible multipart transcription endpoint. Dictation inserts text in your draft. Local voice chat records one message at a time, sends the transcript to the selected model, and plays its reply with an installed system voice. If automatic playback is blocked, choose **Play reply**. If no system voice is available to your browser, the text reply remains in chat.

Tap the composer mic or press **Control+Shift+D** in a text field to dictate. On Mac, press the shortcut again to transcribe the recording into the field. Right-click the mic to choose an input, or manage it and toggle **Enable interface sounds** in **Settings → Audio**. Change or reset the shortcut in **Settings → Shortcuts**.
- For continuous realtime voice, configure `XAI_API_KEY`. Your browser requests microphone permission and connects directly to xAI using a short-lived session credential. Audio goes to xAI and can incur charges.

### Local speech example

With Docker already running, start a CPU-only [Speaches](https://github.com/speaches-ai/speaches) server. The first request may download model weights. This example uses an English model.

```sh
docker run --rm -p 127.0.0.1:8001:8000 -v marion-speech-models:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu
```

Add these lines to `.env` and restart Marion Agent:

```dotenv
MARION_STT_URL=http://127.0.0.1:8001/v1/audio/transcriptions
MARION_STT_MODEL=Systran/faster-distil-whisper-small.en
```

Keep the speech server running whenever you dictate or use local push-to-talk. The local model runtime also needs to be running for voice replies.

## Run chat with a local model

Marion Agent routes chat and memory to your local model server. In `.env`, set `MARION_LOCAL_MODEL_URL` to the server's OpenAI-compatible base URL ending in `/v1`, and set `MARION_LOCAL_MODEL` to the exact ID it serves. The default targets Ollama on port 11434 and uses the name `qwen3.8:27b`. Use the model ID reported by your own runtime. See [local model and connector setup](docs/LOCAL-MODELS.md) and [performance and cost estimates](docs/MODEL-COSTS.md) for a verified Qwen release and serving options. After building, run `node tests/local-model.mjs` and `node tests/local-model.mjs --grok` to verify the local API integration against a test endpoint and the optional Grok approval flow.

`XAI_API_KEY` enables an optional Grok tool that asks for approval before sending its prompt, plus the existing xAI voice and transcription features. Chat and memory use your local model even when the xAI key is set. `COMPOSIO_API_KEY` is optional and enables connected apps and Google sign-in. Keep keys in `.env` on the machine that runs the API.

## Development

Run `scripts/package-distributions.sh` on macOS to regenerate both distribution archives from the canonical source and the installer’s pinned runtime dependencies.

Run `npm run typecheck` and `npm run build` from the project directory. For hot reload, set `APP_URL=http://127.0.0.1:5173` in `.env`, then run `npm run dev -w server` and `npm run dev -w web -- --host 127.0.0.1` in separate terminals. Open http://127.0.0.1:5173. Run `node tests/features.mjs` for templates, Bot coordination, attachments, teaching, compaction, notifications and the Marion Life link; `node tests/ui-sweep.mjs` and `node tests/live-dictation.mjs` need Chrome (`BROWSER_EXECUTABLE`). The browser smoke test uses a disposable database, creates two bot desktops, and checks sign-in, viewer input, file downloads, and restart persistence. Start the built app with `DB_PATH` pointing to a temporary database, run `npx playwright install chromium`, then run `node tests/local-desktop.mjs`. Set `CLEANUP_TEST_DESKTOPS=1` to remove the test-created containers, volumes, and networks after the run.

For an existing install, back up the SQLite database and set `DB_PATH` to its absolute path before starting. Your accounts, bots, and chat history remain in that database. Sign in again to receive the new session cookie. Export files from any prior remote desktops separately if you still need them.

See [desktop hosting options](docs/DESKTOP-HOSTING.md) for Oracle Cloud, other local hosts, and mobile workspaces. Keep the default loopback binding for personal use. See [Security](SECURITY.md) before deploying elsewhere.
