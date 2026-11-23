# Marion Agent

Marion Agent gives each bot a private, persistent Linux desktop. From the web app you can watch or take control of a desktop, organize bots, and download files from their Libraries.

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

Open http://127.0.0.1:8787 on the same machine. Sign in with your email using local sign-in, select Quinn or create a bot, open **Bot's computer**, and click **Wake computer**. **Take control** allows you to use the desktop directly. Keep the terminal and Docker running while you use the app.

Each desktop uses a separate Docker container, network, and workspace volume. Browser profiles and Library files under `/workspace` persist when the desktop stops. PowerShell commands remain on the host. Commands issued by a bot run as an unprivileged user inside that bot's container. The default limit is 2 GiB of RAM and 2 CPUs per running desktop.

## Install the app or use the launcher

After completing the build above, macOS users can double-click **Marion Agent.app** and keep it in the Dock. Keep the launcher in the extracted folder alongside `scripts`, `server`, and `web`. This serves a local app and opens your default browser. On Windows, double-click **Launch Marion Agent.cmd**. Leave its window running while you use Marion Agent.

For a standalone app window, start the server and install Marion Agent from the browser's app menu in Chrome or Edge, or select **File → Add to Dock** in Safari on macOS Sonoma or later. The installed window needs the local server to be running. Press **Ctrl+R** or **⌘R** to reload it. After updating source files, run `npm run build` first. Restart the server for backend changes.

## Connect apps and audio

- Open **Settings → Connected apps**. Paste a Composio project key, choose **Verify and save**, then **Link an app** and approve the provider's authorization form. Composio needs a project key once. Individual OAuth apps are then linked without pasting each app's token into Marion Agent. Hosted deployments configure `COMPOSIO_API_KEY` on the server.
- Open **Settings → Models** to see models advertised by your configured local server and select one for your account. Start the runtime on the same PC or Mac first. The runtime must support streaming Responses and the selected model must support the tools you need.
- Open **Settings → Audio**, choose the microphone and select **Test microphone**. Dictation and calls share the selected input. Changing the selection applies on the next recording or call.
- For local speech, run a Whisper-compatible transcription server and set `MARION_STT_URL` to its multipart transcription endpoint. Dictation inserts text in your draft. Local voice chat records one message at a time, sends the transcript to the selected model, and plays its reply with an installed system voice. If automatic playback is blocked, choose **Play reply**. If no system voice is available to your browser, the text reply remains in chat.
- If you want continuous realtime voice, configure `XAI_API_KEY` and leave `MARION_STT_URL` empty. Your browser requests microphone permission and connects directly to xAI using a short-lived session credential. Audio goes to xAI and can incur charges.

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

Run `npm run typecheck` and `npm run build` from the project directory. For hot reload, set `APP_URL=http://127.0.0.1:5173` in `.env`, then run `npm run dev -w server` and `npm run dev -w web -- --host 127.0.0.1` in separate terminals. Open http://127.0.0.1:5173. The browser smoke test uses a disposable database, creates two bot desktops, and checks sign-in, viewer input, file downloads, and restart persistence. Start the built app with `DB_PATH` pointing to a temporary database, run `npx playwright install chromium`, then run `node tests/local-desktop.mjs`. Set `CLEANUP_TEST_DESKTOPS=1` to remove the test-created containers, volumes, and networks after the run.

For an existing install, back up the SQLite database and set `DB_PATH` to its absolute path before starting. Your accounts, bots, and chat history remain in that database. Sign in again to receive the new session cookie. Export files from any prior remote desktops separately if you still need them.

See [desktop hosting options](docs/DESKTOP-HOSTING.md) for Oracle Cloud, other local hosts, and mobile workspaces. Keep the default loopback binding for personal use. See [Security](SECURITY.md) before deploying elsewhere.
