#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="$ROOT_DIR/scripts/build-macos-app.sh"
APP_DIR="$ROOT_DIR/dist/MacMirror.app"
INSTALL_DIR="${MACMIRROR_INSTALL_DIR:-/Applications}"
INSTALL_APP_DIR="$INSTALL_DIR/MacMirror.app"
CODESIGN_IDENTITY="${MACMIRROR_CODESIGN_IDENTITY:--}"

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 was not found."
  fi
}

run_install_command() {
  if [[ "${INSTALL_WITH_SUDO:-0}" == "1" ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

sign_app_bundle() {
  local app_dir="$1"
  local identity="$2"
  local executable

  while IFS= read -r executable; do
    codesign --force --sign "$identity" "$executable"
  done < <(find "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources/bin" -type f -perm -111)

  codesign --force --sign "$identity" "$app_dir"
  codesign --verify --deep --strict "$app_dir"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS app installation is only supported on macOS."
fi

require_command codesign
require_command ditto

if [[ ! -x "$BUILD_SCRIPT" ]]; then
  fail "Build script is missing or not executable: $BUILD_SCRIPT"
fi

echo "Building MacMirror.app..."
"$BUILD_SCRIPT"

if [[ ! -d "$APP_DIR" ]]; then
  fail "Build output is missing: $APP_DIR"
fi

echo "Signing build output with identity: $CODESIGN_IDENTITY"
sign_app_bundle "$APP_DIR" "$CODESIGN_IDENTITY"

INSTALL_WITH_SUDO=0
if [[ -d "$INSTALL_DIR" ]]; then
  if [[ ! -w "$INSTALL_DIR" ]]; then
    INSTALL_WITH_SUDO=1
  fi
else
  INSTALL_PARENT_DIR="$(dirname "$INSTALL_DIR")"
  if [[ -w "$INSTALL_PARENT_DIR" ]]; then
    mkdir -p "$INSTALL_DIR"
  else
    INSTALL_WITH_SUDO=1
    require_command sudo
    sudo mkdir -p "$INSTALL_DIR"
  fi
fi

if [[ "$INSTALL_WITH_SUDO" == "1" ]]; then
  require_command sudo
fi

echo "Installing $APP_DIR to $INSTALL_APP_DIR..."
run_install_command rm -rf "$INSTALL_APP_DIR"
run_install_command ditto "$APP_DIR" "$INSTALL_APP_DIR"

if [[ ! -x "$INSTALL_APP_DIR/Contents/MacOS/MacMirror" ]]; then
  fail "Installed app executable is missing: $INSTALL_APP_DIR/Contents/MacOS/MacMirror"
fi

codesign --verify --deep --strict "$INSTALL_APP_DIR"

echo "Installed $INSTALL_APP_DIR"
