#!/usr/bin/env bash
#
# Build, sign and install the Android app.
#
#   scripts/android.sh              build a signed release APK
#   scripts/android.sh install      … and push it to the running device
#   scripts/android.sh logs         follow the app's log, web console included
#
# Signing lives here rather than in `gen/android/app/build.gradle.kts` because
# that directory is generated: `tauri android init` rewrites it, and a signing
# config left there goes missing on the next machine that checks the repo out.
# The keystore itself is deliberately outside the repo.
set -euo pipefail

cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"

# Whichever NDK is installed, newest first. Pinning a version here only means
# the script breaks on a machine that has a different one.
if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME="$(find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
export NDK_HOME

# Same, for the build tools that hold zipalign and apksigner.
BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1)"

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

# The default keystore here is a local one with a throwaway password, good for
# putting a build on a device you own and nothing else. An Android app's signing
# key *is* its identity — publish with this one and anyone who reads this file
# can sign an update that phones will accept as yours. Generate a real keystore
# and point these at it before distributing anything.
KEYSTORE="${MANGALIZE_KEYSTORE:-$HOME/.mangalize/android-release.jks}"
KEY_ALIAS="${MANGALIZE_KEY_ALIAS:-mangalize}"
STORE_PASS="${MANGALIZE_KEYSTORE_PASSWORD:-mangalize}"

UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
SIGNED="target/mangalize-release.apk"
PACKAGE="dev.mangalize.app"

require() {
  [ -n "${!1:-}" ] && [ -e "${!1}" ] || { echo "missing $1 (${!1:-unset})" >&2; exit 1; }
}

case "${1:-build}" in
  logs)
    # Tauri routes the webview console through here, so a frontend error on a
    # phone is reachable without attaching a debugger.
    exec adb logcat --pid="$(adb shell pidof "$PACKAGE")" \
      RustStdoutStderr:V chromium:V "$PACKAGE":V '*:S'
    ;;
esac

require ANDROID_HOME
require NDK_HOME
require JAVA_HOME

[ -d src-tauri/gen/android ] || bun run tauri android init

# Tauri wraps a Gradle failure in a single unreadable line with every
# environment variable in it. The actual cause is always an `ERROR:` or `e:`
# line further up, so it gets pulled back out here.
if ! bun run tauri android build --apk --target aarch64 2>&1 | tee /tmp/mangalize-android-build.log; then
  echo
  echo "--- the part of that worth reading ---" >&2
  grep -E "^(ERROR|e):|error:" /tmp/mangalize-android-build.log >&2 || true
  exit 1
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "No keystore at $KEYSTORE. Create one with:" >&2
  echo "  keytool -genkeypair -v -keystore $KEYSTORE -alias $KEY_ALIAS \\" >&2
  echo "    -keyalg RSA -keysize 4096 -validity 10000" >&2
  exit 1
fi

"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" "$SIGNED"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$STORE_PASS" --key-pass "pass:$STORE_PASS" \
  "$SIGNED"
"$BUILD_TOOLS/apksigner" verify "$SIGNED"

echo "signed: $SIGNED"

if [ "${1:-build}" = "install" ]; then
  adb install -r "$SIGNED"
  adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
  echo "launched on $(adb shell getprop ro.product.model | tr -d '\r')"
fi
