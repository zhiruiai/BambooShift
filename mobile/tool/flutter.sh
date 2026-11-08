#!/bin/sh
set -eu
mobile_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$mobile_root/.." && pwd)
export PUB_CACHE="${PUB_CACHE:-$repo_root/.tools/pub-cache}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$repo_root/.tools/flutter-config}"
export DART_TOOLING_HOME="$repo_root/.tools/dart-tooling"
export ANALYZER_STATE_LOCATION_OVERRIDE="$repo_root/.tools/dart-analyzer"
export FLUTTER_SUPPRESS_ANALYTICS=true
export CI=true
export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.googleapis.com}"
export PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.dev}"
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$repo_root/.tools/android-sdk" ]; then
  export ANDROID_HOME="$repo_root/.tools/android-sdk"
fi
export ANDROID_USER_HOME="$repo_root/.tools/android-user"
export GRADLE_USER_HOME="$repo_root/.tools/gradle-cache"
if [ -z "${JAVA_HOME:-}" ] && [ -d "$repo_root/.tools/jdk21/Contents/Home" ]; then
  export JAVA_HOME="$repo_root/.tools/jdk21/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
flutter_executable="${OPENBOT_FLUTTER:-}"
if [ -z "$flutter_executable" ]; then
  if [ -x "$repo_root/.tools/flutter/bin/flutter" ]; then
    flutter_executable="$repo_root/.tools/flutter/bin/flutter"
  else
    flutter_executable=$(command -v flutter || true)
  fi
fi
if [ -z "$flutter_executable" ] || [ ! -x "$flutter_executable" ]; then
  echo 'Install a compatible Flutter SDK or set OPENBOT_FLUTTER to its executable.' >&2
  exit 1
fi
if [ "${1:-}" = dart ]; then
  shift
  dart_executable="$(dirname -- "$flutter_executable")/cache/dart-sdk/bin/dart"
  if [ ! -x "$dart_executable" ]; then dart_executable=$(command -v dart || true); fi
  if [ -z "$dart_executable" ]; then echo 'Dart SDK not found.' >&2; exit 1; fi
  exec "$dart_executable" "$@"
fi
exec "$flutter_executable" --no-version-check --suppress-analytics "$@"
