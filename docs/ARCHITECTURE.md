# Marion Agent architecture

- `web/src/` renders chat, settings, routines, and the workspace viewer. The Hono server serves the production build and delivers live updates over server-sent events.
- `server/src/agent/` runs model turns using a local Responses endpoint or a signed-in provider CLI. It also handles compaction, memory, bot delegation, and Team mode. `server/src/features/` holds templates, teaching, notifications, and Marion Life sync.
- SQLite stores accounts, sessions, bots, transcripts, routines, and desktop assignments. Source launches default to `data/marion-agent.db`. The installed Mac app stores its workspace under **Library → Application Support → Marion Agent**.
- `desktop/` builds the XFCE, Chromium, and TigerVNC image. Each bot gets a container, network, and persistent volume. Libraries live under `/workspace/files/<bot id>`. The authenticated noVNC proxy forwards input only after the user takes control.
- `Marion Agent Installer/` supplies the Electron wrapper, which launches the same server on loopback. The packaging script builds the server and web app, installs the locked server dependencies, and compiles the macOS speech helper into the installer ZIP.
- `server/src/features/life-link.ts` copies completed chats to Marion Life through its API using a revocable link key. The migration path clears the old stored Supabase service key and prompts the owner to reconnect.
