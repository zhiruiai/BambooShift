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

Four published crates on the resolved macOS dependency paths through
`librsvg → locale_config → objc` / `objc-foundation` still lack the full MIT permission
and copyright notice: `block 0.1.6`, `malloc_buf 0.0.6`,
`objc-foundation 0.1.1`, and `objc_id 0.1.1`. The audit checked their complete
published archives and matched their Rust sources to exact release trees.
The manifest records those primary locations and hashes. An SPDX declaration
does not supply the missing notice. A later `malloc_buf` license accompanies
a substantially rewritten implementation and was not substituted.

## Target selection and retained code are separate evidence

The exact POSIX recipe builds librsvg as a static library through
`cargo cbuild --locked --release --library-type staticlib -p librsvg-c`.
It disables the CLI, tests, pixbuf and pixbuf loader. The selected `librsvg`
dependency has `capi`; image features are JPEG/PNG, and Cairo PDF/PostScript
features are removed. The offline workspace lock update removed only
`color_quant`, `gif`, `image-webp` and `weezl`; it added or upgraded no package.

`TARGET-GRAPHS.json` records the prepared input hashes, selected features,
normal/build edges and exact source URLs/checksums:

| Target        | Registry source candidates | Four old macOS crates selected |
| ------------- | -------------------------: | ------------------------------ |
| macOS arm64   |                        165 | Yes                            |
| macOS x64     |                        169 | Yes                            |
| Linux x64 GNU |                        164 | No                             |

These are library build-graph candidates, including build dependencies. They
replace the 357-package workspace superset for this narrower investigation;
they are not a final linked-code SBOM. Cargo 1.85.1 successfully resolved the
frozen manifests. No code was compiled with that toolchain: librsvg declares
Rust 1.92.0 as its minimum compiler. Cargo itself documents that
[`tree -e normal,build`](https://doc.rust-lang.org/cargo/commands/cargo-tree.html#feature-unification)
closely approximates the build graph without guaranteeing exact compilation or
linkage equivalence.

`BINARY-EVIDENCE.json` records checks against the published arm64 dylib. Its
`locale_config` parser is positively identified by exact regex bytes, machine
instructions referencing them, and a synthetic SVG language-selection probe.
The production code obtains language names from GLib, then uses
`Locale::invariant()`, `LanguageRange::from_unix()` and `Locale::add()`.
It does not call `Locale::current()`; the occurrence in `cond.rs` is a comment.

The old macOS initializer requires `NSLocale` and the Objective-C runtime
functions `objc_getClass` / `sel_registerName`. Those strings, imports and
fixups are absent, supporting removal of that specific route. This does not
prove complete absence of all four crates: generic code can inline, and
`objc_retain` / `objc_release` are also used by other libraries in the combined
binary. The missing notices therefore remain unresolved; they must not be
deleted solely because symbols were stripped.

### Repeating the graph investigation

Use the exact librsvg archive and original checksum-verified crate sources.
Vendor them with Cargo's standard source replacement format. Apply only the
feature and Meson edits in the pinned sharp POSIX recipe, run
`cargo update --workspace --offline`, then apply its pinned embedded-image
memory-limit patch. Compare the resulting input hashes with
`TARGET-GRAPHS.json` before interpreting the output.

For each target, run from that prepared source directory:

```sh
cargo tree --frozen --target aarch64-apple-darwin -p librsvg-c \
  --edges normal,build --prefix depth --format '{p}|features={f}' > graph.txt
```

The independent `scripts/desktop/librsvg-source-graph.mjs` utility normalizes
this output against the reviewed sources in `TARGET-GRAPHS.json`:

```sh
node scripts/desktop/librsvg-source-graph.mjs graph.txt source-candidates.json
```

It removes local paths,
rejects unexpected workspace roots and requires exact source checksums. It
does not compile anything or approve a release. Preserve full original source
archives alongside the narrower candidate list until final linkage and
corresponding-source requirements have been satisfied.

Before enabling redistribution:

1. Recover the exact missing notices from an authoritative source, or adopt a
   separately verified compatible implementation with complete legal materials.
2. Preserve the original archives, the sharp-libvips build recipe, its patches
   and the checked lockfile. Obtain link/build evidence before excluding a
   selected source on the basis of dead stripping; target resolution alone
   does not establish which implementation bytes survived.
3. Produce a corresponding-source artifact with all applicable legal texts,
   patches, build instructions and instructions for replacing the shared library.
   A link to an upstream repository or a list of package names is insufficient.
4. Validate the actual desktop artifact, including native image formats, limits
   and cancellation. The audit does not claim that a native rebuild or complete
   managed desktop package has already passed.

Managed-runtime release packaging remains disabled. This audit records the
requirements for redistribution; it does not prevent authorized, isolated local
package acceptance. Such local acceptance is separate from release readiness.
The four notice gaps describe the resolved macOS paths and must not be presented
as proof of missing dependencies on every other platform. No image-processing
capability was removed to avoid completing the audit.
