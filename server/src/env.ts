import { fileURLToPath } from 'node:url';

export const appEnv = (name: string) => process.env[`MARION_${name}`];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopbackUrl = (u: string) => {
  try { return LOOPBACK_HOSTS.has(new URL(u).hostname); } catch { return false; }
};

/** Interface to listen on. Loopback by default; set HOST=0.0.0.0 only behind auth (see SECURITY.md). */
const host = process.env.HOST ?? '127.0.0.1';
const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  host,
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl,
  xaiKey: process.env.XAI_API_KEY?.trim() ?? '',
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  composioKey: process.env.COMPOSIO_API_KEY?.trim() ?? '',
  desktopImage: appEnv('DESKTOP_IMAGE') ?? 'marion-agent-desktop:local',
  /**
   * Passwordless email sign-in for local testing. It lets anyone sign in as any email, so it only
   * turns on when the server listens on loopback and SERVER_URL is a localhost URL.
   */
  devLogin: process.env.DEV_LOGIN === '1' && LOOPBACK_HOSTS.has(host) && isLoopbackUrl(serverUrl),
  devLoginRequested: process.env.DEV_LOGIN === '1',
  /** Origins allowed to send state-changing requests and open the screen relay (the web app and this server). */
  trustedOrigins: [...new Set([process.env.APP_URL ?? 'http://localhost:5173', serverUrl].map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean))],
  /**
   * Who may create an account: comma-separated emails and/or @domains. Unset means anyone, but only
   * while SERVER_URL is a localhost URL; a public server with no list accepts no new sign-ups, because
   * every account spends the owner's xAI and Composio credits and host resources.
   */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  openSignup: isLoopbackUrl(serverUrl),
  /** Mark cookies Secure when the server is reached over HTTPS. */
  secureCookies: serverUrl.startsWith('https://'),
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../../data/marion-agent.db', import.meta.url)),
};
