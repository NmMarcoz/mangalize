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

# Signing credentials come from a file outside the repo, or from the
# environment when CI supplies them. There is deliberately no default password
# here: one committed next to the script it unlocks is not a password, and an
# Android signing key *is* the app's identity — anyone holding it can sign an
# update that phones will accept as yours.
KEYSTORE_PROPERTIES="${MANGALIZE_KEYSTORE_PROPERTIES:-$HOME/.mangalize/android-keystore.properties}"
if [ -f "$KEYSTORE_PROPERTIES" ]; then
  # Only the three keys we expect, so a stray line cannot set anything else.
  while IFS='=' read -r key value; do
    case "$key" in
      MANGALIZE_KEYSTORE|MANGALIZE_KEY_ALIAS|MANGALIZE_KEYSTORE_PASSWORD)
        # Already set in the environment wins, so CI can override the file.
        [ -n "${!key:-}" ] || export "$key=$value"
        ;;
    esac
  done < "$KEYSTORE_PROPERTIES"
fi

KEYSTORE="${MANGALIZE_KEYSTORE:-$HOME/.mangalize/android-release.jks}"
KEY_ALIAS="${MANGALIZE_KEY_ALIAS:-mangalize}"
STORE_PASS="${MANGALIZE_KEYSTORE_PASSWORD:-}"

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

# The Android project is committed, but the parts of it Tauri derives from
# tauri.conf.json are not — `settings.gradle` applies a `tauri.settings.gradle`
# that only `init` writes, so a fresh checkout has a project Gradle cannot load.
# Re-running init fills those back in and leaves every committed file alone,
# which is what makes committing the project safe in the first place.
[ -f src-tauri/gen/android/tauri.settings.gradle ] || bun run tauri android init

# Tauri wraps a Gradle failure in a single unreadable line with every
# environment variable in it. The actual cause is always an `ERROR:` or `e:`
# line further up, so it gets pulled back out here.
if ! bun run tauri android build --apk --target aarch64 2>&1 | tee /tmp/mangalize-android-build.log; then
  echo
  echo "--- the part of that worth reading ---" >&2
  grep -E "^(ERROR|e):|error:" /tmp/mangalize-android-build.log >&2 || true
  exit 1
fi

if [ ! -f "$KEYSTORE" ] || [ -z "$STORE_PASS" ]; then
  echo "No signing key. Create one and record where it is:" >&2
  echo >&2
  echo "  keytool -genkeypair -v -keystore $KEYSTORE -alias $KEY_ALIAS \\" >&2
  echo "    -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12" >&2
  echo >&2
  echo "  cat > $KEYSTORE_PROPERTIES <<EOF" >&2
  echo "  MANGALIZE_KEYSTORE=$KEYSTORE" >&2
  echo "  MANGALIZE_KEY_ALIAS=$KEY_ALIAS" >&2
  echo "  MANGALIZE_KEYSTORE_PASSWORD=..." >&2
  echo "  EOF" >&2
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
  # A signing key *is* the app's identity, so a build signed with a different
  # one cannot update an installed copy. Say so rather than letting adb's
  # INSTALL_FAILED_UPDATE_INCOMPATIBLE be the explanation, and do not uninstall
  # automatically — that throws away the library on the device.
  if ! adb install -r "$SIGNED"; then
    echo >&2
    echo "If that was a signature mismatch, the installed copy was signed with" >&2
    echo "a different key. Remove it and install fresh — this deletes the" >&2
    echo "library and settings on the device:" >&2
    echo >&2
    echo "  adb uninstall $PACKAGE" >&2
    exit 1
  fi
  adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
  echo "launched on $(adb shell getprop ro.product.model | tr -d '\r')"
fi
