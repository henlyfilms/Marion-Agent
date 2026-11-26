// Real-window zoom check (owner, Nov 25: "when you zoom in and zoom out with the UI, it kind of glitches it out").
// Runs the built app in Electron at several page zooms (View → Zoom In/Out), collapses the sidebar, and checks in
// screen points that the rail stays clear of the macOS window buttons (x 15–68, y 14–26) with the toggle centred
// under them. Saves a capture per zoom with the window buttons drawn in.
// Usage: npm run build && <Electron binary> tests/electron-zoom.cjs <outDir>
//   (any Electron without an app inside, e.g. a copy of Marion Agent.app with Contents/Resources/app moved away)
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const out = path.resolve(process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'tests/out/zoom');
mkdirSync(out, { recursive: true });
const port = process.env.MARION_TEST_PORT ?? '8863';
const url = `http://127.0.0.1:${port}`;
const work = mkdtempSync(path.join(tmpdir(), 'marion-zoom-'));
const server = spawn(process.env.NODE_BIN ?? 'node', ['dist/index.js'], {
  cwd: path.join(__dirname, '..', 'server'),
  env: { ...process.env, DB_PATH: path.join(work, 'z.db'), PORT: port, HOST: '127.0.0.1', APP_URL: url, SERVER_URL: url, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  let failed = 0;
  try {
    for (let i = 0; i < 100; i++) { if (await fetch(url + '/api/health').then(r => r.ok, () => false)) break; await wait(100); }
    const win = new BrowserWindow({ show: false, width: 1320, height: 880, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 14 }, backgroundColor: '#09070b' });
    const js = code => win.webContents.executeJavaScript(code);
    await win.loadURL(url);
    await js(`(async () => {
      await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'zoom@example.com' }) });
      for (const [name, color] of [['Barry', 'purple'], ['Moose', 'orange'], ['Bot Builder', 'orange']])
        await fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, avatarColor: color }) });
    })()`);
    await win.loadURL(url);
    await wait(1500);
    await js(`document.querySelector('.bot-list .bot-row')?.click()`);
    await wait(500);
    for (const zoom of (process.env.ZOOMS ?? '0.8,0.9,1,1.1,1.25').split(',').map(Number)) {
      win.webContents.setZoomFactor(zoom);
      await wait(400);
      for (const collapsed of [true, false]) {
        await js(`(() => { const s = document.querySelector('.sidebar'); if (s.classList.contains('is-collapsed') !== ${collapsed}) document.querySelector('.sidebar-toggle').click(); })()`);
        await wait(700);
        const m = await js(`(() => {
          const z = ${zoom}, r = e => e.getBoundingClientRect();
          const side = r(document.querySelector('.sidebar')), t = r(document.querySelector('.sidebar-toggle'));
          const avatar = [...document.querySelectorAll('.bot-list .bot-row__avatar')].find(e => r(e).width > 0), a = avatar && r(avatar);
          return { cssZoom: getComputedStyle(document.documentElement).getPropertyValue('--window-zoom').trim(),
            rail: side.width * z, toggleTop: t.top * z, toggleCentre: (t.left + t.width / 2) * z, railCentre: side.width * z / 2,
            avatarCentre: a ? (a.left + a.width / 2) * z : null };
        })()`);
        const issues = [];
        if (Math.abs(Number(m.cssZoom) - zoom) > 0.011) issues.push(`zoom seen as ${m.cssZoom}`);
        if (m.toggleTop < 30) issues.push(`toggle starts ${m.toggleTop.toFixed(1)}pt down, inside the window-button row`);
        if (collapsed) {
          if (m.rail < 76) issues.push(`rail ${m.rail.toFixed(1)}pt: too narrow for the window buttons (x 15–68)`);
          if (Math.abs(m.toggleCentre - m.railCentre) > 1) issues.push(`toggle ${(m.toggleCentre - m.railCentre).toFixed(1)}pt off the rail centre`);
          if (m.avatarCentre != null && Math.abs(m.avatarCentre - m.railCentre) > 1.5) issues.push(`avatars ${(m.avatarCentre - m.railCentre).toFixed(1)}pt off the rail centre`);
        }
        console.log(`zoom ${zoom} ${collapsed ? 'collapsed' : 'open     '} rail ${m.rail.toFixed(1)}pt toggle top ${m.toggleTop.toFixed(1)}pt centre ${m.toggleCentre.toFixed(1)}/${m.railCentre.toFixed(1)} avatar ${m.avatarCentre?.toFixed(1)}  ${issues.length ? 'PROBLEM: ' + issues.join('; ') : 'ok'}`);
        failed += issues.length;
        const img = await win.webContents.capturePage({ x: 0, y: 0, width: Math.round(360 / zoom), height: Math.round(240 / zoom) });
        writeFileSync(path.join(out, `zoom-${zoom}-${collapsed ? 'collapsed' : 'open'}.png`), img.toPNG());
      }
    }
    win.destroy();
  } catch (error) {
    console.error(error); failed++;
  } finally {
    server.kill();
    console.log(failed ? `${failed} problem(s)` : 'every zoom ok');
    app.exit(failed ? 1 : 0);
  }
});
