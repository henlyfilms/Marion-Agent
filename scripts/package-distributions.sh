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

output=
if [[ ${1:-} == --installer-output && $# == 2 && "$2" == /* ]]; then
  output="$2"
elif [[ $# != 0 ]]; then
  printf 'Usage: %s [--installer-output /absolute/path.zip]\n' "$0" >&2
  exit 2
fi

# Snapshot exactly one commit before compiling. Builds cannot silently pick up untracked files,
# unfinished edits, or half of a concurrent checkout. Source ZIPs can also build without Git.
helper=server/src/lib/update-inputs.cjs
mkdir -p "$source" "$package/payload"
commit=dev
fingerprint=
if [[ -e .git ]]; then
  commit="$(git rev-parse --verify HEAD)"
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    printf 'Packaging committed files at %s; uncommitted changes are not included.\n' "$commit" >&2
  fi
  node "$helper" files "$commit" > "$stage/inputs"
  paths=()
  while IFS= read -r -d '' file; do paths+=("$file"); done < "$stage/inputs"
  [[ ${#paths[@]} -gt 0 ]]
  git --literal-pathspecs archive "$commit" -- "${paths[@]}" | tar -xf - -C "$source"
  fingerprint="$(node "$helper" fingerprint "$commit")"
else
  mkdir -p "$source/server" "$source/web"
  cp -p .env.example .gitignore package.json package-lock.json README.md SECURITY.md THIRD_PARTY_NOTICES.md \
    'Launch Marion Agent.command' 'Launch Marion Agent.cmd' "$source/"
  cp -Rp assets desktop docs scripts tests "$source/"
  cp -Rp server/src server/package.json server/tsconfig.json "$source/server/"
  cp -Rp web/src web/public web/package.json web/tsconfig.json web/vite.config.ts web/index.html "$source/web/"
  mkdir -p "$source/$installer/payload/Resources"
  cp -p "$installer/Install Marion Agent.command" "$source/$installer/"
  cp -p "$installer/payload/Info.plist" "$source/$installer/payload/"
  cp -Rp "$installer/payload/Resources/app" "$installer/payload/Resources/MarionAgent.icns" "$source/$installer/payload/Resources/"
fi
cp -Rp "$source/$installer/." "$package/"
export MARION_BUILD_COMMIT="$commit"
# Unique even for two builds of the same revision in the same second (runtime cache key).
serial="$(node -p 'require("node:crypto").randomUUID()')"
printf '%s.%s%s\n' "$commit" "$serial" "${fingerprint:+.$fingerprint}" > "$resources/BUILD_ID"
cp -p "$resources/BUILD_ID" "$source/$installer/payload/Resources/"

mkdir -p "$runtime/server" "$runtime/web" "$resources/speech" "$stage/module-cache"

(
  cd "$source"
  cp -p .env.example package.json package-lock.json THIRD_PARTY_NOTICES.md "$runtime/"
  cp -Rp desktop "$runtime/"
  cp -p server/package.json "$runtime/server/"
  cp -p web/package.json "$runtime/web/"
  # Use the snapshot’s lockfile for build tools, not node_modules from the live checkout.
  npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
  npm run build -w web -- --emptyOutDir --outDir "$runtime/web/dist"
  npm run build -w server -- --sourceMap false --outDir "$runtime/server/dist"
  rm -rf node_modules web/node_modules server/node_modules
)
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
    "$source/scripts/macos/Transcribe.swift" -o "$stage/marion-transcribe-$arch"
done
xcrun lipo -create "$stage/marion-transcribe-arm64" "$stage/marion-transcribe-x86_64" \
  -output "$resources/speech/marion-transcribe"

(
  cd "$stage"
  if [[ -z "$output" ]]; then
    /usr/bin/zip -qry 'Marion Agent.zip' 'Marion Agent' -x '*/.DS_Store' '*/.claude' '*/.claude/*' 'Marion Agent/tests/out/*'
    /usr/bin/unzip -tq 'Marion Agent.zip'
  fi
  /usr/bin/zip -qry Marion-Agent-Mac-Installer.zip "$installer" -x '*/.DS_Store' '*/.claude' '*/.claude/*'
  /usr/bin/unzip -tq Marion-Agent-Mac-Installer.zip
)
if [[ -n "$output" ]]; then
  mv "$stage/Marion-Agent-Mac-Installer.zip" "$output"
else
  mkdir -p releases
  mv "$stage/Marion Agent.zip" "$stage/Marion-Agent-Mac-Installer.zip" releases/
fi
