#!/bin/bash
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
for installed in "/Applications/Marion Agent.app" "$HOME/Applications/Marion Agent.app"; do
  if [[ -x "$installed/Contents/MacOS/Electron" ]] && [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$installed/Contents/Info.plist" 2>/dev/null)" == com.henlyfilms.marion-agent ]]; then
    exec /usr/bin/open "$installed"
  fi
done
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  /usr/bin/osascript -e 'display alert "Marion Agent needs Node.js 24" message "Install Node.js and complete the setup in README.md."'
  exit 1
fi
if ! node scripts/launch.mjs; then
  /usr/bin/osascript -e 'display alert "Marion Agent could not start" message "Use Install Marion Agent.command, or run npm ci and npm run build in the source folder before using the browser launcher."'
  exit 1
fi
