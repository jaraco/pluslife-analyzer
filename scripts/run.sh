#!/bin/bash
# Launch the dev app the way Finder/launchd would, via `open`, so it is its own
# TCC "responsible process" and can read its Info.plist Bluetooth usage key.
#
# Launching Electron as a child of the shell (plain `electron .`) makes macOS
# attribute Bluetooth permission to the parent terminal instead, which has no
# usage string, and the process is hard-killed (SIGABRT) the moment it touches
# Bluetooth. `open` avoids that. The packaged app launched from Finder is never
# affected. Extra args after the app path are forwarded to our main process.
set -euo pipefail

APP="node_modules/electron/dist/Electron.app"
bash scripts/patch-dev-plist.sh
open -n "$APP" --args "$(pwd)" "$@"

echo "Launched. Debug log (with --pluslife-debug): \"$HOME/Library/Application Support/pluslife-analyzer/pluslife-debug.log\""
