const { app, BrowserWindow, Menu, desktopCapturer, dialog, nativeTheme, session, shell, webContents } = require('electron');
const { mkdirSync, copyFileSync, chmodSync, constants, existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { createServerHost } = require('./server-host.cjs');

app.setName('Marion Agent');

const host = '127.0.0.1';
const port = '8789';
const origin = `http://${host}:${port}`;
const accessHeader = 'x-marion-desktop-session';
// The server outlives this app (see server-host.cjs), so its token is read from the running server's session file
// on relaunch instead of being made fresh each time.
let accessToken = '';
const callbackPaths = new Set(['/api/apps/callback']);
const popups = new Set();
let serverHost;
let mainWindow;
let appSession;
let ready = false;
let quitting = false;

const windowOptions = () => ({
  webPreferences: {
    session: appSession,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    spellcheck: false,
  },
});

function configureSession() {
  appSession = session.fromPartition('persist:marion-agent');
  // Local pages may use the microphone (dictation, calls), show notifications, copy text, and record the
  // screen for "Teach by screen recording". Nothing else, and nothing for other origins.
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requesting = details.requestingUrl || contents?.getURL();
    if (!isLocal(requesting)) return callback(false);
    if (permission === 'notifications' || permission === 'display-capture' || permission === 'clipboard-sanitized-write') return callback(true);
    callback(permission === 'media' && Boolean(details.mediaTypes?.length)
      && details.mediaTypes.every(type => type === 'audio' || type === 'video'));
  });
  appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (requestingOrigin !== origin) return false;
    // "Copy message" and the other Copy actions write plain text to the clipboard.
    if (permission === 'notifications' || permission === 'clipboard-sanitized-write') return true;
    return permission === 'media' && (details.mediaType === 'audio' || details.mediaType === 'video');
  });
  // getDisplayMedia(): use the macOS screen picker when available, else share the main screen.
  appSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isLocal(request.securityOrigin || request.frame?.url || '')) return callback({});
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => callback(sources[0] ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  }, { useSystemPicker: true });

  appSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] },
    (details, callback) => {
      const target = new URL(details.url);
      if (target.port !== port) return callback({});
      const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
      const from = details.frame?.url || contents?.getURL();
      const primary = contents && contents === mainWindow?.webContents;
      const popup = contents && popups.has(contents.id);
      const navigation = details.resourceType === 'mainFrame' && details.method === 'GET';
      const localRequest = (primary || popup) && isLocal(from);
      const initial = primary && navigation && (!from || from === 'about:blank') && target.pathname === '/';
      const callbackRequest = popup && navigation && callbackPaths.has(target.pathname);
      if (!localRequest && !initial && !callbackRequest) return callback({ cancel: true });
      callback({ requestHeaders: { ...details.requestHeaders, [accessHeader]: accessToken } });
    },
  );
}

function isLocal(url) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function isSecureWeb(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

function createWindow() {
  if (!ready || quitting || mainWindow) return;
  mainWindow = new BrowserWindow({
    ...windowOptions(),
    title: 'Marion Agent',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 14 },
    width: 1320,
    height: 880,
    minWidth: 840,
    minHeight: 580,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09070b' : '#faf8fa',
  });
  const win = mainWindow;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Keep the main desktop window on our server. OAuth popup windows share its cookie session.
  const stayLocal = (event, url) => { if (!isLocal(url)) event.preventDefault(); };
  win.webContents.on('will-navigate', stayLocal);
  win.webContents.on('will-redirect', stayLocal);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { ...windowOptions(), width: 680, height: 780 } };
    }
    if (isSecureWeb(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', popup => {
    const contents = popup.webContents;
    const id = contents.id;
    popups.add(id);
    popup.on('closed', () => popups.delete(id));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const stayInFlow = (event, url) => {
      if (url === 'about:blank' || isSecureWeb(url)) return;
      if (isLocal(url) && callbackPaths.has(new URL(url).pathname)) return;
      event.preventDefault();
    };
    contents.on('will-navigate', stayInFlow);
    contents.on('will-redirect', stayInFlow);
  });
  void win.loadURL(origin).catch(() => {
    if (!quitting) dialog.showErrorBox('Could not open Marion Agent', 'Quit the app and open it again to reconnect.');
  });
}

function applicationMenu(dataDir) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Marion Agent', submenu: [
      { role: 'about' },
      { label: 'Open App Data Folder', click: () => { void shell.openPath(dataDir); } },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit', label: 'Quit Marion Agent (bots keep running)' },
      { label: 'Quit and Stop Background Work', accelerator: 'Alt+CommandOrControl+Q', click: () => {
        const busy = dialog.showMessageBoxSync({
          type: 'warning', buttons: ['Stop Everything and Quit', 'Cancel'], defaultId: 1, cancelId: 1,
          message: 'Stop running bots and assistants?',
          detail: 'Anything a bot or a relayed Claude, Codex or Gemini is working on right now will be interrupted.',
        }) === 0;
        if (!busy) return;
        quitting = true;
        void (serverHost ? serverHost.stop() : Promise.resolve()).finally(() => app.quit());
      } },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Reload Marion Agent', accelerator: 'CommandOrControl+R', click: () => mainWindow?.reload() },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}

function pairingEnvironment(dataDir, kind) {
  try {
    const config = JSON.parse(readFileSync(path.join(dataDir, `${kind}-pairing.json`), 'utf8'));
    if (typeof config.origin === 'string' && typeof config.passphrase === 'string') {
      const prefix = `MARION_${kind.toUpperCase()}`;
      return { [`${prefix}_ORIGIN`]: config.origin, [`${prefix}_PASSPHRASE`]: config.passphrase };
    }
  } catch { /* Pairing remains disabled when the file is missing or invalid. */ }
  return {};
}

/** Which build this app is, so a server left running by an older build is swapped out (only once it is idle). */
function buildIdentity(resources) {
  try { return readFileSync(path.join(resources, 'BUILD_ID'), 'utf8').trim() || 'unknown'; } catch { /* older packages have none */ }
  try {
    const version = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    return `${version}-${Math.round(statSync(path.join(resources, 'marion', 'server', 'dist', 'index.js')).mtimeMs)}`;
  } catch { return 'unknown'; }
}

async function start() {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const config = path.join(dataDir, '.env');
  const resources = process.resourcesPath;
  try {
    copyFileSync(path.join(resources, 'marion', '.env.example'), config, constants.COPYFILE_EXCL);
    chmodSync(config, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const transcriber = path.join(resources, 'speech', 'marion-transcribe');
  const nativeSpeech = process.platform === 'darwin' && Number(process.getSystemVersion().split('.')[0]) >= 26 && existsSync(transcriber);
  serverHost = createServerHost({
    dataDir, resources, appDir: __dirname, host, port, origin, accessHeader,
    buildId: buildIdentity(resources),
    ownerPid: process.pid,
    baseEnvironment: () => ({ ...pairingEnvironment(dataDir, 'mobile'), ...pairingEnvironment(dataDir, 'browser') }),
    environment: () => ({
      PATH: `${path.join(app.getPath('home'), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH || ''}`,
      ...(nativeSpeech ? { MARION_NATIVE_TRANSCRIBER: transcriber } : {}),
    }),
  });
  // Re-adopts the server that kept running (bots and relays never noticed the app was gone), or starts one.
  const running = await serverHost.ensure();
  if (quitting) return;
  accessToken = running.token;
  ready = true;
  configureSession();
  applicationMenu(dataDir);
  createWindow();
  // A new build's server is swapped in only while nothing is running; the window then reloads onto it and the
  // web app restores the chat, view and draft you were on.
  serverHost.watch(() => {
    accessToken = serverHost.state.token;
    if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    if (mainWindow) mainWindow.focus();
    else createWindow();
  });
  app.on('activate', createWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Quitting (or crashing, or being replaced by an update) leaves the server running: bots and relays finish their
  // work. It stops by itself a minute after the work is done. "Quit and Stop Background Work" ends it right away.
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Could not start Marion Agent', error.message);
    app.quit();
  });
}
