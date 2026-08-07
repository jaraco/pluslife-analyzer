#!/bin/bash
# Lets the *dev* Electron binary use Web Bluetooth without crashing.
#
# macOS aborts (SIGABRT, TCC privacy violation) any process that touches
# Bluetooth unless its code-signed bundle's Info.plist contains
# NSBluetoothAlwaysUsageDescription. Editing Info.plist breaks the signature
# seal, so macOS then ignores the edited plist entirely — we must re-sign the
# bundle ad-hoc afterward for the new key to be honored.
#
# The packaged app gets the key from package.json build.mac.extendInfo and is
# signed by electron-builder, so it does not need any of this.
set -euo pipefail

APP="node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
DESC="Pluslife Analyzer connects to your Pluslife test dock over Bluetooth to run tests."

if [[ ! -f "$PLIST" ]]; then
  echo "Electron not installed at $APP — run 'npm install' first." >&2
  exit 1
fi

for key in NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription; do
  /usr/libexec/PlistBuddy -c "Add :$key string $DESC" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :$key $DESC" "$PLIST"
done

# Re-seal the bundle so macOS trusts (and reads) the edited Info.plist.
codesign --force --deep --sign - "$APP" 2>/dev/null

echo "Patched and re-signed $APP with Bluetooth usage descriptions."
echo "First Bluetooth use prompts for permission — grant it (System Settings →"
echo "Privacy & Security → Bluetooth → enable 'Electron' if needed)."
