# Rebuilding the macOS arm64 image-codec candidate

This is a custom BambooShift build based on `lovell/sharp-libvips` revision
`ebb95f8add54eee8bed840e3fb587e4cbec857d7`, using libvips 8.18.7. It is a candidate,
not the official `@img/sharp-libvips` npm artifact. The production dependency lock
and managed-runtime release gate remain unchanged. The third-party libraries
retain their original licenses, including the applicable LGPL terms; the
repository's MIT license does not replace those terms.

## Inputs and changes

`SOURCE-INPUTS-CANDIDATE.json` pins all 27 source archives, four upstream patches,
the upstream recipe, platform files, version list, license and notice by SHA-256
and byte length. The corresponding-source archive includes these exact inputs
in `source-cache/`; it does not depend on a private cache or a moving branch.

Changes dated 2026-11-13 are recorded in `candidate-recipe.patch` and the three
files under `candidate-patches/`:

- Disable SVG loading with the official libvips `-Drsvg=disabled` option and omit
  the now-unused librsvg/Rust build. Preserve the other codec and font options.
- Set GLib/GIO, Pango and libvips fallback directories to neutral paths under
  `/bambooshift-native-runtime`. Installation prefixes and environment overrides
  retain their upstream behavior.
- Use libheif's supported `-DPLUGIN_DIRECTORY=/bambooshift-native-runtime/lib/libheif`
  together with the existing `-DENABLE_PLUGIN_LOADING=0` in a clean CMake build.
- Map source/debug paths with Clang prefix-map options, cap compilation at two
  jobs and read sources only from the verified cache during compilation.
- Normalize artifact ownership and timestamps. Keep diagnostic logs outside
  distributed artifacts. Apply an ad-hoc signature after relocation; this is
  not Developer ID signing or notarization.

GLib's verified source archive includes the `gvdb` subproject. The upstream
Meson cross-file uses `wrap_mode=nofallback`; no separate gvdb fetch is required.
The recipe's network fetches are replaced by an offline checksum-bound reader.

## Build tools

Use a native macOS arm64 host, Node.js 24, Python 3.14.7, Apple Clang 21.0.0
(`clang-2100.1.1.101`), its matching macOS SDK, and `pkg-config` 2.5.1. The SDK and
system toolchain are supplied by Apple, not redistributed in the source archive.
The deployment target is macOS 11.0. The isolated C++ wrapper selects the SDK's
`usr/include/c++/v1`, addressing CLT installations without adjacent libc++ headers.

Create a build-only tool environment; do not install these into the application:

```sh
python3.14 -m venv /tmp/bambooshift-codec-tools
/tmp/bambooshift-codec-tools/bin/python -m pip install --require-hashes \
  -r legal/third-party/sharp-libvips-1.3.4/BUILD-TOOLS.txt
```

The pinned Ninja wheel reports `1.13.2.git.kitware.jobserver-pipe-1`; its wheel
hash, rather than an unversioned executable name, identifies this build input.
Python and the three wheel packages are build tools only. They are not new
runtime requirements for desktop, Web or mobile users.

## Clean rebuild

Extract the corresponding-source archive into a directory without spaces, then
run from its root. Choose a new output path; the entry point refuses existing
outputs and never deletes an earlier build. Allow at least 2 GiB of free space.

```sh
node scripts/desktop/native-codecs/build.mjs build \
  --output /tmp/bambooshift-native-build \
  --cache ./source-cache \
  --tools /tmp/bambooshift-codec-tools --jobs 2
```

When starting from a repository checkout without the corresponding-source
archive, `--fetch` explicitly permits downloading missing inputs from the pinned
public HTTPS URLs. Every download must match the published digest and size.
Compilation itself remains offline. Logs under the output's `logs/` directory
are private diagnostics and may contain local toolchain paths.

The raw candidate archive is produced at the output root. After compilation,
the `package` command adds complete notice files, signs the relocated library,
creates normalized binary and corresponding-source archives, and records their
hashes in an external distribution manifest:

```sh
node scripts/desktop/native-codecs/build.mjs package \
  --output /tmp/bambooshift-native-build \
  --cache ./source-cache \
  --tools /tmp/bambooshift-codec-tools
```

The packaging command also requires the notice collector and catalog shipped
with the source archive. It refuses existing package output directories. Source
archives remain byte-identical upstream downloads; build output and local
machine information are not included. Review and pin the distribution-manifest
hash independently before consuming these artifacts.

## Replacing the shared library and validating behavior

Keep an independent copy of a managed runtime for testing. Stop that copy before
replacing its library. Never overwrite the development checkout's Sharp package
or a running application's files. With Sharp 0.35.5 for macOS arm64, the unchanged
addon loads `@rpath/libvips-cpp.8.18.7.dylib` from its sibling library package.
Replace only that library and its associated version/notice files inside the
test runtime's `node_modules/@img/sharp-libvips-darwin-arm64/` directory. Preserve
the custom artifact's identity and notices; do not describe the substituted
bytes as the original npm package integrity.

Users can rebuild a modified libvips and replace this shared library using the
same process. The application must not require a vendor-only signature or hide
the shared library inside an inaccessible executable. An ad-hoc signature can
be regenerated locally after modification. Re-sign and validate the outer test
application when changing files inside a signed app bundle. These instructions
do not waive platform policy or imply a notarized distribution has been tested.

Verify the addon dependency with `otool -L`, inspect Node's
`process.report.getReport().sharedObjects`, and compare the actual loaded file's
hash with the distribution manifest. Then run the repository's real image
contract against the isolated runtime:

```sh
OPENBOT_IMAGE_CONTRACT_RUNTIME=/tmp/isolated-runtime \
OPENBOT_IMAGE_CONTRACT_NODE=/path/to/node24 \
TSX_DISABLE_CACHE=1 node --import tsx --test \
  server/workers/document-worker/tests/image-contract.test.ts
```

The 27 checks cover PNG/JPEG/WebP orientation, embedded P3/CMYK profiles,
transparency, first-frame behavior and input/output limits. Explicitly verify
SVG decoding is unavailable. Production SVG attachments are text, while GIF is
an unsupported attachment; neither requires Sharp rasterization. Development
branding/avatar exports continue using the original complete Sharp build.

Full desktop packaging, other platforms, public distribution approval, Developer
ID signing and notarization remain separate acceptance steps.
