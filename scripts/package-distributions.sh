#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
installer="Marion Agent Installer"
payload="$installer/payload/Resources/marion"
if ! cmp -s package-lock.json "$payload/package-lock.json"; then
  printf 'Refresh the installer production dependencies before packaging a changed lockfile.\n' >&2
  exit 1
fi

npm run build
stage="$(mktemp -d "$root/.marion-package.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
if [[ "$(uname -s)" == Darwin ]]; then
  mkdir -p "$stage/module-cache" "$stage/speech"
  for arch in arm64 x86_64; do
    xcrun swiftc -module-cache-path "$stage/module-cache" -parse-as-library -O -target "$arch-apple-macos14.0" \
      scripts/macos/Transcribe.swift -o "$stage/marion-transcribe-$arch"
  done
  xcrun lipo -create "$stage"/marion-transcribe-* -output "$stage/speech/marion-transcribe"
fi
mkdir -p "$stage/Marion Agent/server" "$stage/Marion Agent/web"
cp -p .env.example .gitignore package.json package-lock.json README.md SECURITY.md THIRD_PARTY_NOTICES.md LICENSE \
  'Launch Marion Agent.command' 'Launch Marion Agent.cmd' "$stage/Marion Agent/"
cp -Rp assets desktop docs scripts tests "$stage/Marion Agent/"
cp -Rp server/src server/package.json server/tsconfig.json "$stage/Marion Agent/server/"
cp -Rp web/src web/public web/package.json web/tsconfig.json web/vite.config.ts web/index.html "$stage/Marion Agent/web/"

cp -Rp "$installer" "$stage/"
staged_payload="$stage/$payload"
if [[ -f "$stage/speech/marion-transcribe" ]]; then
  mkdir -p "$stage/$installer/payload/Resources/speech"
  cp -p "$stage/speech/marion-transcribe" "$stage/$installer/payload/Resources/speech/"
fi
for component in server web; do
  rm -rf "$staged_payload/$component/dist"
  cp -Rp "$component/dist" "$staged_payload/$component/"
  cp -p "$component/package.json" "$staged_payload/$component/"
done
cp -p .env.example package.json THIRD_PARTY_NOTICES.md "$staged_payload/"
cp -Rp desktop "$staged_payload/"
(
  cd "$stage"
  /usr/bin/zip -qry 'Marion Agent.zip' 'Marion Agent' -x '*/.DS_Store'
  /usr/bin/zip -qry Marion-Agent-Mac-Installer.zip "$installer" -x '*/.DS_Store'
  /usr/bin/unzip -tq 'Marion Agent.zip'
  /usr/bin/unzip -tq Marion-Agent-Mac-Installer.zip
)

# The production dependency tree and both native SQLite prebuilds are reused above.
# Replace just the rebuilt payload files and the two verified archives.
for component in server web; do
  mv "$payload/$component/dist" "$stage/previous-$component-dist"
  if ! mv "$staged_payload/$component/dist" "$payload/$component/dist"; then
    mv "$stage/previous-$component-dist" "$payload/$component/dist"
    exit 1
  fi
  cp -p "$staged_payload/$component/package.json" "$payload/$component/"
done
cp -p "$staged_payload/.env.example" "$staged_payload/package.json" "$staged_payload/THIRD_PARTY_NOTICES.md" "$payload/"
cp -Rp desktop "$payload/"
if [[ -f "$stage/speech/marion-transcribe" ]]; then
  mkdir -p "$installer/payload/Resources/speech"
  cp -p "$stage/speech/marion-transcribe" "$installer/payload/Resources/speech/"
fi
mv "$stage/Marion Agent.zip" "$stage/Marion-Agent-Mac-Installer.zip" "$root/"
