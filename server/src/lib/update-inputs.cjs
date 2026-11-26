// Shared by packaging and the installed server. Hash Git's canonical blob IDs, paths and
// modes, not generated bundles, mtimes, ZIP metadata, dependencies on disk, or commit IDs.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const inputs = [
  '.env.example', 'package.json', 'package-lock.json', 'desktop',
  'server/package.json', 'server/tsconfig.json', 'server/src',
  'web/package.json', 'web/tsconfig.json', 'web/vite.config.ts', 'web/index.html', 'web/src', 'web/public',
  'scripts/package-distributions.sh', 'scripts/macos/Transcribe.swift',
  'Marion Agent Installer/Install Marion Agent.command', 'Marion Agent Installer/payload/Info.plist',
  'Marion Agent Installer/payload/Resources/MarionAgent.icns', 'Marion Agent Installer/payload/Resources/app',
];
// These extra inputs ship only in the source distribution, not the installed app.
const sourceOnly = ['.gitignore', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'Launch Marion Agent.command', 'Launch Marion Agent.cmd',
  'assets', 'docs', 'scripts', 'tests'];
const excluded = ['.DS_Store', '.claude/**', '**/.claude/**', 'tests/out/**',
  'Marion Agent Installer/payload/Resources/BUILD_ID'];
const pathspec = [...inputs, ...excluded.map(name => ':(exclude)' + name)];

/** @param {string} dir @param {string[]} args */
function gitBuffer(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
}

/** @param {string} dir @param {string} revision @param {string[]} paths */
function appEntries(dir, revision, paths = inputs) {
  return gitBuffer(dir, 'ls-tree', '-r', '-z', revision, '--', ...paths).toString('utf8')
    .split('\0').filter(entry => {
      const name = entry.slice(entry.indexOf('\t') + 1);
      return name && !/(^|\/)(?:\.DS_Store|\.claude)(?:\/|$)/.test(name)
        && !name.startsWith('tests/out/') && name !== 'Marion Agent Installer/payload/Resources/BUILD_ID';
    });
}

/** @param {string} dir @param {string} revision */
function fingerprint(dir, revision) {
  return createHash('sha256').update('marion-inputs-v1\0').update(appEntries(dir, revision).join('\0')).digest('hex');
}

module.exports = { fingerprint, pathspec };

// Packaging passes a pinned commit. List exact tracked files so ignored/generated
// files in the checkout cannot be included in the snapshot.
if (require.main === module) {
  const [, , command, revision] = process.argv;
  if (command === 'fingerprint') process.stdout.write(fingerprint(process.cwd(), revision));
  else if (command === 'files') {
    const files = appEntries(process.cwd(), revision, [...inputs, ...sourceOnly]);
    process.stdout.write(files.map(entry => entry.slice(entry.indexOf('\t') + 1) + '\0').join(''));
  } else process.exit(2);
}
