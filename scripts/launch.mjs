import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const origin = 'http://127.0.0.1:8787';
const checkOnly = process.argv.includes('--check');

async function ready() {
  try {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(750) });
    const health = await response.json();
    return response.ok && health.ok && health.provider === 'local';
  } catch {
    return false;
  }
}

function openApp() {
  const launch = {
    darwin: ['open', [origin]],
    win32: ['rundll32.exe', ['url.dll,FileProtocolHandler', origin]],
    linux: ['xdg-open', [origin]],
  }[process.platform];
  if (!launch) throw new Error('Open ' + origin + ' in your browser');
  return new Promise((resolve, reject) => {
    const process = spawn(...launch, { stdio: 'ignore', windowsHide: true });
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve() : reject(new Error('Could not open ' + origin)));
  });
}

if (await ready()) {
  if (!checkOnly) await openApp();
  else console.log('Marion Agent is running at ' + origin);
} else if (checkOnly) {
  console.error('Marion Agent is not responding on port 8787');
  process.exitCode = 1;
} else {
  if (!existsSync(new URL('../server/dist/index.js', import.meta.url)) || !existsSync(new URL('../.env', import.meta.url))) {
    throw new Error('Complete setup in README.md before launching Marion Agent');
  }
  const server = spawn(process.execPath, ['--env-file=../.env', 'dist/index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '8787', SERVER_URL: origin, APP_URL: origin },
    stdio: 'inherit', windowsHide: true,
  });
  let stopped = false;
  server.once('exit', () => { stopped = true; });
  server.once('error', error => { stopped = true; console.error(error.message); });
  const handle = () => server.kill();
  process.once('SIGINT', handle);
  process.once('SIGTERM', handle);
  try {
    for (let attempt = 0; attempt < 40 && !stopped && !await ready(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!await ready()) throw new Error('Marion Agent could not start on port 8787');
    await openApp();
  } catch (error) {
    server.kill();
    throw error;
  }
}
