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
payload="$here/payload/Resources"
[[ -f "$payload/app/main.cjs" ]] || fail "Unzip the whole installer and keep the payload folder next to this file."
build="$(cat "$payload/BUILD_ID" 2>/dev/null)" || fail "The installer is missing its build identity."
[[ "$build" =~ ^(dev|[0-9a-f]{7,64})\.[0-9a-z-]+(\.[0-9a-f]{64})?$ ]] || fail "The installer has an invalid build identity."

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

# --replace-running (used by "Install update" inside the app): prepare everything while the app keeps
# running, then quit it just before the swap and reopen the new one, so it is only closed for seconds.
replace_running=0
if [[ ${1:-} == --replace-running ]]; then
  replace_running=1
  shift
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

# Match only this bundle's Electron binary, not another copy with the same bundle ID
# and never the detached server. The process path can contain spaces.
app_pids() {
  /bin/ps -axww -o pid=,comm= | MARION_INSTALL_EXE="$destination/Contents/MacOS/Electron" /usr/bin/awk '
    { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0 == ENVIRON["MARION_INSTALL_EXE"]) print pid }'
}
app_running() { [[ -n "$(app_pids)" ]]; }
closed_for_swap=0
require_closed_app() {
  [[ -n "$existing_inode" ]] && app_running || return 0
  if [[ "$replace_running" == 1 ]]; then
    printf 'Restarting Marion Agent…\n'
    closed_for_swap=1
    # Give this exact bundle a normal quit before falling back to its verified PID.
    /usr/bin/osascript - "$destination" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  set bundlePath to (POSIX file (item 1 of argv)) as text
  tell application bundlePath to quit
end run
APPLESCRIPT
    for _ in $(seq 1 60); do app_running || return 0; sleep 0.5; done
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true # this bundle's /Contents/MacOS/Electron only
    done < <(app_pids)
    for _ in $(seq 1 20); do app_running || return 0; sleep 0.5; done
  fi
  fail "Quit Marion Agent, then run this installer to update the existing app."
}
[[ "$replace_running" == 1 ]] || require_closed_app

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
  if [[ "$installed" == 0 && "$closed_for_swap" == 1 && -d "$destination" ]] && ! app_running; then
    /usr/bin/open "$destination" || true
  fi
  /bin/rm -rf "$work"
}
trap cleanup EXIT
# The runtime downloads (~165 MB) are kept in ~/Library/Caches by checksum, so updates after the
# first one skip them and take seconds instead of minutes.
cache="$HOME/Library/Caches/Marion Agent/runtime"
download() {
  local url="$1" path="$2" checksum="$3" cached="$cache/$3"
  if [[ -f "$cached" ]] && printf '%s  %s\n' "$checksum" "$cached" | /usr/bin/shasum -a 256 -c - >/dev/null 2>&1; then
    /bin/cp "$cached" "$path"
    return
  fi
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 20 --output "$path" "$url"
  printf '%s  %s\n' "$checksum" "$path" | /usr/bin/shasum -a 256 -c -
  mkdir -p "$cache" && /bin/cp "$path" "$cached" 2>/dev/null || true
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
/bin/cp "$here/payload/Info.plist" "$bundle/Contents/Info.plist"
/usr/bin/ditto "$payload" "$resources"
cmp -s "$payload/BUILD_ID" "$resources/BUILD_ID" || fail "The app’s build identity was not copied."
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
# Sign with the Mac's own "Marion Agent Local Signing" certificate when it exists (made once by
# scripts/macos/make-signing-identity.sh). Every build then has the same signature, so macOS keeps
# the file and microphone permissions you already gave instead of asking again after each update.
signer=-
if /usr/bin/security find-certificate -c "Marion Agent Local Signing" >/dev/null 2>&1; then
  signer="Marion Agent Local Signing"
fi
sign() {
  /usr/bin/codesign --force --sign "$signer" "$@" 2>/dev/null || { signer=-; /usr/bin/codesign --force --sign - "$@"; }
}
sign "$prebuilds/darwin-$arch.node"
sign "$resources/runtime/node"
if [[ -f "$resources/speech/marion-transcribe" ]]; then
  sign "$resources/speech/marion-transcribe"
fi
sign --deep "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"
same_destination() {
  [[ ! -L "$destination" && "$(/usr/bin/stat -f %i "$destination" 2>/dev/null)" == "$existing_inode" ]]
}
if [[ -n "$existing_inode" ]]; then
  same_destination || fail "Marion Agent changed while this update was preparing."
fi
require_closed_app
if [[ -n "$existing_inode" ]]; then
  same_destination || fail "Marion Agent changed while this update was preparing."
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
