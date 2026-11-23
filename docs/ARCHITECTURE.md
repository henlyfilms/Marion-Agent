# Marion Agent architecture

- The React/Vite UI uses the Hono API for sessions, bot settings, chat, routines, Library downloads, screenshots and the desktop viewer. The built API also serves the web bundle. Server-sent events deliver live changes.
- SQLite holds accounts, sessions, bots, schedules, messages, memories, and desktop assignments. The default database is `data/marion-agent.db`.
- The agent loop sends model requests to a local Responses endpoint and runs tool calls on the server. Desktop tools use the Docker CLI and operate only inside the assigned container. The desktop image uses XFCE, TigerVNC, Chromium and X11 input tools. Each bot has its own workspace volume and private Docker network.
- noVNC connects to the API over an authenticated, bot-scoped WebSocket. The API reaches the private desktop listener through `docker exec` and drops keyboard, pointer and clipboard messages in watch mode.
- Libraries are files under `/workspace/files/<bot id>` in the desktop volume. The API checks ownership and serves bounded downloads directly from the workspace.
- The local model powers chat, screenshot interpretation, and memory. xAI is available as an optional Grok tool and voice provider. Composio handles connected apps and Google sign-in.

## Marion Life integration checkpoints

1. Verify local sign-in, desktop lifecycle, Library downloads and local chat on the target desktop.
2. Review the Marion Life repository and agree on identity, session ownership, navigation, secret management and deployment boundaries.
3. Decide whether to integrate via the Marion Agent API or fold the modules into a shared deployment. Keep the Docker daemon available only to the workspace service. Plan the SQLite data migration and test an isolated integration before switching over.
