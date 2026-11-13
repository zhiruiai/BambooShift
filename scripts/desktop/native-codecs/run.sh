#!/usr/bin/env bash
set -e
set -o pipefail

# Invoked only by build.mjs after the source inputs and empty output are checked.
cd "${BAMBOOSHIFT_BUILD_OUTPUT:?}"
export PATH="$PWD/bin:${BAMBOOSHIFT_BUILD_TOOLS:?}/bin:$PATH"
export NINJA="$PWD/bin/ninja"
export SDKROOT="$(xcrun --show-sdk-path)"
export CC=clang CXX=clang++ PLATFORM=darwin-arm64v8
export PKG_CONFIG="$(command -v pkg-config) --static"
export MACOSX_DEPLOYMENT_TARGET=11.0
export FLAGS="-fno-stack-check -Werror=unguarded-availability-new -ffile-prefix-map=$PWD=/bambooshift-native-build -fdebug-prefix-map=$PWD=/bambooshift-native-build"
export MESON="--cross-file=$PWD/platforms/$PLATFORM/meson.ini"
export CMAKE_BUILD_PARALLEL_LEVEL="${BAMBOOSHIFT_BUILD_JOBS:?}"
export XDG_CACHE_HOME="$PWD/cache"
export TMPDIR="$PWD/tmp"
export SOURCE_DATE_EPOCH=0

# Toolchain details are local diagnostics, never copied into public artifacts.
{
  clang --version
  meson --version
  ninja --version
  cmake --version
  pkg-config --version
  python3 --version
} >logs/toolchain.txt 2>&1
source ./versions.properties
source ./build/posix.sh
