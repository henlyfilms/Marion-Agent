// Exercise the real snapshot and ZIP pipeline. Stub only toolchain/dependency work,
// and never run the installer or start Electron.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../server/src/lib/update-inputs.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(root, '.marion-package.test-'));
const repo = join(work, 'repo');
const bin = join(work, 'bin');
const pack = 'scripts/package-distributions.sh';
const helper = 'server/src/lib/update-inputs.cjs';
const installer = 'Marion Agent Installer';
const prefix = `${installer}/payload/Resources`;
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' }).trim();
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

try {
  mkdirSync(repo);
  git('init', '-q');
  for (const file of [pack, helper, `${installer}/Install Marion Agent.command`]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(root, file), join(repo, file));
  }
  for (const file of ['.env.example', 'package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md',
    'server/package.json', 'web/package.json', 'desktop/Dockerfile', 'scripts/macos/Transcribe.swift',
    `${installer}/payload/Info.plist`, `${prefix}/MarionAgent.icns`, `${prefix}/app/main.cjs`, 'web/src/input.txt']) {
    put(join(repo, file), 'pinned');
  }
  git('add', '.');
  git('commit', '-qm', 'initial snapshot');
  const commit = git('rev-parse', 'HEAD');
  const digest = fingerprint(repo, commit);
  put(join(repo, 'web/src/input.txt'), 'edited in the working copy');
  put(join(repo, 'web/src/untracked.txt'), 'not shipped');
  put(join(repo, 'releases/Marion-Agent-Mac-Installer.zip'), 'old public artifact');
  put(join(bin, 'uname'), '#!/bin/bash\necho Darwin\n');
  put(join(bin, 'npm'), `#!/bin/bash
set -eu
if [[ "$1" == ci ]]; then
  if [[ -f web/src/input.txt ]]; then
    [[ ! -e web/src/untracked.txt ]]
    git -C "$FIXTURE" -c user.name=fixture -c user.email=test@example.test commit -qm advanced -a
  else
    mkdir -p node_modules/better-sqlite3/prebuilds
    touch node_modules/better-sqlite3/prebuilds/darwin-{arm64,x64}.node
  fi
else
  for arg; do out="$arg"; done
  mkdir -p "$out"
  printf '%s:%s' "$MARION_BUILD_COMMIT" "$(cat web/src/input.txt)" > "$out/snapshot"
fi
`);
  put(join(bin, 'xcrun'), '#!/bin/bash\nfor arg; do out="$arg"; done\n: > "$out"\n');
  for (const file of ['uname', 'npm', 'xcrun']) chmodSync(join(bin, file), 0o755);
  const output = join(work, 'private update.zip');
  execFileSync('/bin/bash', [pack, '--installer-output', output], {
    cwd: repo, env: { ...process.env, FIXTURE: repo, PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extract = file => execFileSync('/usr/bin/unzip', ['-p', output, `${prefix}/${file}`], { encoding: 'utf8' }).trim();
  const [revision, serial, stamped] = extract('BUILD_ID').split('.');
  assert.equal(revision, commit);
  assert.match(serial, /^[0-9a-f-]{36}$/);
  assert.equal(stamped, digest);
  assert.notEqual(git('rev-parse', 'HEAD'), commit, 'HEAD advanced while the build was running');
  assert.equal(extract('marion/web/dist/snapshot'), `${commit}:pinned`);
  assert.equal(extract('marion/server/dist/snapshot'), `${commit}:pinned`);
  assert.equal(readFileSync(join(repo, 'releases', 'Marion-Agent-Mac-Installer.zip'), 'utf8'), 'old public artifact');
  console.log(`PASS: ${basename(output)} contains the pinned tree and fingerprint, independent of edits, moving HEAD or stale releases.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
