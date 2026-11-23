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

## Why the xAI API key is needed

You can sign in locally, create bots, and use their desktops without provider keys. `XAI_API_KEY` authenticates requests to Grok. The model reads chat, decides which tools to call, interprets screenshots, and writes replies. The same key enables automated memory consolidation, voice, and transcription. Model and voice usage can incur charges even when desktops run on your PC. To enable these features, add the key to `.env` and restart Marion Agent.

`COMPOSIO_API_KEY` enables Google sign-in and connected apps. It is optional for local use. Keep keys in `.env` on the machine that runs the API.

## Development

Run `npm run typecheck` and `npm run build` from the project directory. For hot reload, set `APP_URL=http://127.0.0.1:5173` in `.env`, then run `npm run dev -w server` and `npm run dev -w web -- --host 127.0.0.1` in separate terminals. Open http://127.0.0.1:5173. The browser smoke test uses a disposable database, creates two bot desktops, and checks sign-in, viewer input, file downloads, and restart persistence. Start the built app with `DB_PATH` pointing to a temporary database, run `npx playwright install chromium`, then run `node tests/local-desktop.mjs`. Set `CLEANUP_TEST_DESKTOPS=1` to remove the test-created containers, volumes, and networks after the run.

For an existing install, back up the SQLite database and set `DB_PATH` to its absolute path before starting. Your accounts, bots, and chat history remain in that database. Sign in again to receive the new session cookie. Export files from any prior remote desktops separately if you still need them.

See [desktop hosting options](docs/DESKTOP-HOSTING.md) for Oracle Cloud, other local hosts, and mobile workspaces. Keep the default loopback binding for personal use. See [Security](SECURITY.md) before deploying elsewhere.
