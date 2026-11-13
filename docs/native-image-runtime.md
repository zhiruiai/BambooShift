# Native image runtime candidates

The macOS arm64 managed desktop candidate can bundle the source-built image
library without treating its bytes as an official npm publication. The ordinary
client build and automated releases are unchanged.

## Build a reviewed candidate

The input directory must contain the three exact artifacts pinned by
[`CANDIDATE-DARWIN-ARM64.json`](../legal/third-party/sharp-libvips-1.3.4/CANDIDATE-DARWIN-ARM64.json):
`distribution.json`, its binary archive and its complete corresponding-source
archive. Obtain them from a reviewed build; the packager does not download an
unreviewed replacement or accept a caller-provided checksum.

```sh
npm run client:package -- --with-runtime \
  --native-image-candidate /path/to/reviewed-distribution
```

This option requires a native macOS arm64 build. Use `--dry-run` to inspect the
plan without building or starting the client. The artifact directory is a local
build input and is not written into the output manifest. The resulting package
is explicitly marked `releaseApproval: false`.

## Package structure and provenance

The generated production npm lock is installed normally. Before substitution,
the packager checks the original addon, library, retained package files and
locked publication identity. Only the library and version metadata are replaced
with contained relative links into `runtime/native-image-runtime/`.

That directory contains the custom library, complete original notices, the
upstream wrapper license, both verified archives and an overlay inventory. The
inventory records original and replacement hashes; the npm lock continues to
describe installation inputs. It does not claim to identify substituted bytes.
Unexpected files, escaping links, changed legal texts or incomplete source
archives fail verification. If replacement fails, the original library and
metadata are restored.

`runtime-notices/index.json` covers the ordinary installed dependencies.
`runtime-notices/native-image.json` identifies the separately verified root
libvips package. A nested dependency with the same name remains subject to the
ordinary strict collector. The original npm binary audit is not waived.

Code signing can change native binary hashes. Overlay hashes are explicitly
**before-signing provenance**. Acceptance separately records the signed library
hash, checks the file actually loaded by the packaged Node process and verifies
the outer app signature. Library replacement by recipients remains supported;
see the [source and replacement instructions](../legal/third-party/sharp-libvips-1.3.4/REBUILD.md).

## Verified scope

After packaging, run the repository's repeatable personal-workspace check against
the unpacked application:

```sh
npm run client:check -- --resources '/path/to/BambooShift.app/Contents/Resources'
```

The check extracts the actual packaged supervisor and runs it with the packaged
Node, backend and Pi. It creates its own temporary profile, keeps host control off,
and uses a loopback synthetic model to exercise real file writes and delivery.
It checks process shutdown, restored data and a second task after restart. The
JSON report identifies the checked package by key-file hashes, without recording
local addresses, profile paths or session credentials. It does not automate the
Electron interface or qualify an untested newer package for release.

The [repeatable-check record](evidence/personal-package-check-20261113.json)
identifies the retained macOS arm64 candidate that passed this command. It does
not imply that the current source tree has been rebuilt or publicly released.

The [macOS arm64 acceptance record](evidence/desktop-native-runtime-20261113.json)
covers the complete isolated app: strict notice collection, source inclusion,
ad-hoc signing, personal-space entry without account login, model configuration
through the interface, real bundled Pi file delivery, Markdown preview, quit
cleanup and a second task after restart. The model endpoint returned controlled
synthetic responses; this does not assess an external model's reasoning quality.

The actual packaged image worker passed all 27 image contract checks. A separate
process using the same signed Node and computer worker verified active shell
cancellation, background-child cleanup, no delayed writes and executor reuse.
That worker-level check does not substitute for approval-interface acceptance.

This candidate is still local. Public delivery of the archives, other operating
systems, Developer ID signing/notarization, and real desktop screenshot and
keyboard/mouse acceptance remain separate requirements. Automatic releases
continue to ship the connection client.
