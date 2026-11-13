# Native redistribution audit

The native `@img/sharp-libvips-*` packages contain a shared library assembled
from many statically linked libraries. Their upstream `THIRD-PARTY-NOTICES.md`
is a license summary, not the complete permission texts or corresponding source.
It must not, by itself, clear the managed desktop runtime release check.

`DISTRIBUTION.json` binds this audit to the exact npm publication integrities
and upstream sharp-libvips commit. The audit downloaded the 28 source archives
and five patches named by that commit's POSIX build recipe. It also verified
all 357 registry archives against librsvg 2.63.2's original `Cargo.lock`.
The registry list includes optional, platform and development dependencies;
it is a source superset, not a claim that 357 crates are linked into the binary.
Large source archives and extracted legal texts belong in source-distribution
artifacts, not in this repository's code tree.

Four published crates on the declared macOS dependency path
`librsvg → locale_config → objc-foundation` still lack the full MIT permission
and copyright notice: `block 0.1.6`, `malloc_buf 0.0.6`,
`objc-foundation 0.1.1`, and `objc_id 0.1.1`. The audit checked their complete
published archives and matched their Rust sources to exact release trees.
The manifest records those primary locations and hashes. An SPDX declaration
does not supply the missing notice. A later `malloc_buf` license accompanies
a substantially rewritten implementation and was not substituted.

Before enabling redistribution:

1. Recover the exact missing notices from an authoritative source, or adopt a
   separately verified compatible implementation with complete legal materials.
2. Preserve the original archives, the sharp-libvips build recipe, its patches
   and the final target-specific lockfile. The recipe removes image GIF/WebP
   and Cairo PDF/PostScript features before `cargo update --workspace`, then
   applies the librsvg embedded-image memory-limit patch. Verify the resolved
   target graph rather than guessing which dependencies can be omitted.
3. Produce a corresponding-source artifact with all applicable legal texts,
   patches, build instructions and instructions for replacing the shared library.
   A link to an upstream repository or a list of package names is insufficient.
4. Validate the actual desktop artifact, including native image formats, limits
   and cancellation. The audit does not claim that a native rebuild or complete
   managed desktop package has already passed.

Managed-runtime release packaging remains disabled. This audit records the
requirements for redistribution; it does not prevent authorized, isolated local
package acceptance. Such local acceptance is separate from release readiness.
The four notice gaps describe the declared macOS path and must not be presented
as proof of missing dependencies on every other platform. No image-processing
capability was removed to avoid completing the audit.
