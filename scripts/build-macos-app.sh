#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/MacMirror.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/App"
BIN_DIR="$RESOURCES_DIR/bin"
MODULE_CACHE_DIR="$ROOT_DIR/.macmirror/module-cache"
ICON_SOURCE="$ROOT_DIR/assets/MacMirrorLogo.png"
ICONSET_DIR="$ROOT_DIR/.macmirror/MacMirror.iconset"
ICON_TOOL="$ROOT_DIR/.macmirror/CreateIconSet"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc was not found. Install Xcode command line tools first." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "node_modules is missing. Run npm install before building the macOS app." >&2
  exit 1
fi

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "App icon source is missing: $ICON_SOURCE" >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RUNTIME_DIR" "$BIN_DIR" "$MODULE_CACHE_DIR"
export CLANG_MODULE_CACHE_PATH="$MODULE_CACHE_DIR"

swiftc -O -parse-as-library \
  "$ROOT_DIR/macos/MacMirrorApp.swift" \
  -o "$MACOS_DIR/MacMirror" \
  -framework AppKit \
  -framework CoreImage

swiftc -O "$ROOT_DIR/native/MacMirrorH264Capture.swift" -o "$BIN_DIR/MacMirrorH264Capture"
swiftc -O "$ROOT_DIR/native/MacMirrorInput.swift" -o "$BIN_DIR/MacMirrorInput"
swiftc -O "$ROOT_DIR/macos/CreateIconSet.swift" -o "$ICON_TOOL" -framework AppKit

cp "$ROOT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"

rm -rf "$ICONSET_DIR"
"$ICON_TOOL" "$ICON_SOURCE" "$ICONSET_DIR"
iconutil -c icns -o "$RESOURCES_DIR/MacMirror.icns" "$ICONSET_DIR"

ditto "$ROOT_DIR/src" "$RUNTIME_DIR/src"
ditto "$ROOT_DIR/public" "$RUNTIME_DIR/public"
ditto "$ROOT_DIR/native" "$RUNTIME_DIR/native"
ditto "$ROOT_DIR/node_modules" "$RUNTIME_DIR/node_modules"
cp "$ROOT_DIR/package.json" "$RUNTIME_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$RUNTIME_DIR/package-lock.json"

chmod +x "$MACOS_DIR/MacMirror" "$BIN_DIR/MacMirrorH264Capture" "$BIN_DIR/MacMirrorInput"

echo "Built $APP_DIR"
