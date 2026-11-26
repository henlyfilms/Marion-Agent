#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
installer="Marion Agent Installer"
[[ "$(uname -s)" == Darwin ]] || { printf 'Build the Mac installer on macOS.\n' >&2; exit 1; }

stage="$(mktemp -d "$root/.marion-package.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
source="$stage/Marion Agent"
package="$stage/$installer"
resources="$package/payload/Resources"
runtime="$resources/marion"

mkdir -p "$source/server" "$source/web" "$resources"

cp -p "$installer/Install Marion Agent.command" "$package/"
cp -p "$installer/payload/Info.plist" "$package/payload/"
cp -p "$installer/payload/Resources/MarionAgent.icns" "$resources/"
cp -Rp "$installer/payload/Resources/app" "$resources/"
# <commit>.<time>: lets a running app tell its own build from the server it left running, so an update swaps the
# server only when nothing is running, and lets the server know which commit it was built from (auto-update).
# Only files that ship in the app matter (same exclusions as the app's update check).
if [[ -n "$(git status --porcelain --untracked-files=no -- . ':(exclude)tests' ':(exclude)docs' ':(exclude)*.md' ':(exclude)data' ':(exclude).claude' 2>/dev/null)" ]]; then
  printf 'Warning: uncommitted changes are being packaged under commit %s. Commit first, or the app will offer this same build as an update.\n' "$(git rev-parse --short=7 HEAD 2>/dev/null || echo dev)" >&2
fi
# Read HEAD ONCE: BUILD_ID, the web bundle (via MARION_BUILD_COMMIT) and the warning above must all name the same commit,
# even when another chat commits while this long build runs. Otherwise the app and its own web bundle disagree and
# the update check says "Update available" right after installing.
commit="$(git rev-parse --short=7 HEAD 2>/dev/null || echo dev)"
export MARION_BUILD_COMMIT="$commit"
printf '%s.%s\n' "$commit" "$(date +%s)" > "$resources/BUILD_ID"

cp -p .env.example .gitignore package.json package-lock.json README.md SECURITY.md THIRD_PARTY_NOTICES.md \
  'Launch Marion Agent.command' 'Launch Marion Agent.cmd' "$source/"
cp -Rp assets desktop docs scripts tests "$source/"
cp -Rp server/src server/package.json server/tsconfig.json "$source/server/"
cp -Rp web/src web/public web/package.json web/tsconfig.json web/vite.config.ts web/index.html "$source/web/"
cp -Rp "$package" "$source/"
mkdir -p "$runtime/server" "$runtime/web" "$resources/speech" "$stage/module-cache"

cp -p .env.example package.json package-lock.json THIRD_PARTY_NOTICES.md "$runtime/"
cp -Rp desktop "$runtime/"
cp -p server/package.json "$runtime/server/"
cp -p web/package.json "$runtime/web/"
npm run build -w web -- --emptyOutDir --outDir "$runtime/web/dist"
npm run build -w server -- --sourceMap false --outDir "$runtime/server/dist"
(
  cd "$runtime"
  npm ci --workspace server --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund
)

prebuilds="$runtime/node_modules/better-sqlite3/prebuilds"
for arch in arm64 x64; do
  binary="$prebuilds/darwin-$arch.node"
  [[ -f "$binary" ]] || { printf 'Missing SQLite runtime for %s.\n' "$arch" >&2; exit 1; }
done
find "$prebuilds" -type f ! -name 'darwin-*.node' -delete

for arch in arm64 x86_64; do
  xcrun swiftc -module-cache-path "$stage/module-cache" -parse-as-library -O -target "$arch-apple-macos14.0" \
    scripts/macos/Transcribe.swift -o "$stage/marion-transcribe-$arch"
done
xcrun lipo -create "$stage/marion-transcribe-arm64" "$stage/marion-transcribe-x86_64" \
  -output "$resources/speech/marion-transcribe"

(
  cd "$stage"
  /usr/bin/zip -qry 'Marion Agent.zip' 'Marion Agent' -x '*/.DS_Store' '*/.claude' '*/.claude/*' 'Marion Agent/tests/out/*'
  /usr/bin/zip -qry Marion-Agent-Mac-Installer.zip "$installer" -x '*/.DS_Store' '*/.claude' '*/.claude/*'
  /usr/bin/unzip -tq 'Marion Agent.zip'
  /usr/bin/unzip -tq Marion-Agent-Mac-Installer.zip
)
mkdir -p releases
mv "$stage/Marion Agent.zip" "$stage/Marion-Agent-Mac-Installer.zip" releases/
