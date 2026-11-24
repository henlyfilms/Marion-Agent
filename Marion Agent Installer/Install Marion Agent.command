#!/bin/bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

here="$(cd "$(dirname "$0")" && pwd)"
[[ "$(uname -s)" == Darwin ]] || fail "Run this installer on your Mac."
major="$(/usr/bin/sw_vers -productVersion | cut -d. -f1)"
[[ "$major" -ge 13 ]] || fail "Marion Agent requires macOS 13 or later."
[[ -f "$here/payload/Resources/app/main.cjs" ]] || fail "Unzip the whole installer and keep the payload folder next to this file."

if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then
  arch=arm64
  electron_sha=d080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4
  node_sha=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
else
  [[ "$(uname -m)" == x86_64 ]] || fail "This Mac architecture is unsupported."
  arch=x64
  electron_sha=1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79
  node_sha=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7
fi

if [[ ${1:-} == --app-dir && $# -eq 2 ]]; then
  apps="$2"
  mkdir -p "$apps"
  apps="$(cd "$apps" && pwd)"
elif [[ $# -ne 0 ]]; then
  fail "Usage: $0 [--app-dir directory]"
elif [[ -e '/Applications/Marion Agent.app' ]]; then
  apps=/Applications
elif [[ -e "$HOME/Applications/Marion Agent.app" ]]; then
  apps="$HOME/Applications"
elif [[ -w /Applications ]]; then
  apps=/Applications
else
  apps="$HOME/Applications"
  mkdir -p "$apps"
fi
destination="$apps/Marion Agent.app"
[[ -w "$apps" ]] || fail "You need write access to $apps to update Marion Agent there."
existing_inode=
if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]] || fail "An unrelated item already exists at $destination."
  identifier="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$identifier" == com.henlyfilms.marion-agent ]] || fail "An unrelated app already exists at $destination."
  existing_inode="$(/usr/bin/stat -f %i "$destination")"
fi

require_closed_app() {
  if [[ -n "$existing_inode" ]] && /bin/ps -axo comm= | /usr/bin/grep -Fx "$destination/Contents/MacOS/Electron" >/dev/null; then
    fail "Quit Marion Agent, then run this installer to update the existing app."
  fi
}
require_closed_app

work="$(/usr/bin/mktemp -d "$apps/.marion-install.XXXXXXXX")"
previous="$work/previous.app"
installed=0
cleanup() {
  if [[ -d "$previous" && "$installed" == 0 ]]; then
    if [[ -e "$destination" || -L "$destination" ]] || ! /bin/mv "$previous" "$destination"; then
      printf 'The previous app is available at %s\n' "$previous" >&2
      return
    fi
  fi
  /bin/rm -rf "$work"
}
trap cleanup EXIT
download() {
  local url="$1" path="$2" checksum="$3"
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 20 --output "$path" "$url"
  printf '%s  %s\n' "$checksum" "$path" | /usr/bin/shasum -a 256 -c -
}

printf 'Downloading the app runtime for %s…\n' "$arch"
download "https://github.com/electron/electron/releases/download/v45.4.1/electron-v45.4.1-darwin-$arch.zip" "$work/electron.zip" "$electron_sha"
download "https://nodejs.org/dist/v24.22.3/node-v24.22.3-darwin-$arch.tar.gz" "$work/node.tar.gz" "$node_sha"

printf 'Preparing Marion Agent…\n'
/usr/bin/unzip -q "$work/electron.zip" -d "$work"
/usr/bin/tar -xzf "$work/node.tar.gz" -C "$work" "node-v24.22.3-darwin-$arch/bin/node" "node-v24.22.3-darwin-$arch/LICENSE"
/bin/mv "$work/Electron.app" "$work/Marion Agent.app"
bundle="$work/Marion Agent.app"
resources="$bundle/Contents/Resources"
/bin/cp "$here/payload/Info-$arch.plist" "$bundle/Contents/Info.plist"
/usr/bin/ditto "$here/payload/Resources" "$resources"
mkdir "$resources/runtime"
/bin/cp "$work/node-v24.22.3-darwin-$arch/bin/node" "$resources/runtime/node"
/bin/cp "$work/node-v24.22.3-darwin-$arch/LICENSE" "$resources/runtime/LICENSE"
/bin/chmod 755 "$resources/runtime/node"
prebuilds="$resources/marion/node_modules/better-sqlite3/prebuilds"
[[ -f "$prebuilds/darwin-$arch.node" ]] || fail "The SQLite runtime is missing."
for binary in "$prebuilds"/darwin-*.node; do
  [[ "$binary" == "$prebuilds/darwin-$arch.node" ]] || /bin/rm "$binary"
done

printf 'Signing and checking the app…\n'
/usr/bin/codesign --force --sign - "$prebuilds/darwin-$arch.node"
/usr/bin/codesign --force --sign - "$resources/runtime/node"
if [[ -f "$resources/speech/marion-transcribe" ]]; then
  /usr/bin/codesign --force --sign - "$resources/speech/marion-transcribe"
fi
/usr/bin/codesign --force --deep --sign - "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"
require_closed_app
if [[ -n "$existing_inode" ]]; then
  [[ ! -L "$destination" && "$(/usr/bin/stat -f %i "$destination")" == "$existing_inode" ]] || fail "Marion Agent changed while this update was preparing."
  /bin/mv "$destination" "$previous"
else
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail "Another copy of Marion Agent was installed at the same time."
fi
/bin/mv "$bundle" "$destination"
installed=1
if [[ -n "$existing_inode" ]]; then
  printf 'Updated Marion Agent at %s\n' "$destination"
else
  printf 'Installed at %s\n' "$destination"
fi
/usr/bin/open "$destination"
