# Canvas 1.1.0 native notices

This directory collects unchanged upstream notices for the published
`@napi-rs/canvas-darwin-arm64@1.1.0` package. This README and `SOURCES.json` are
BambooShift's collection notes; they are not upstream license texts.

The published npm provenance payload identifies Canvas commit
`5246bbf5573fdf53b5672a4d096d4d8fa660a406`. Its subject digest matches the package
integrity in `package-lock.json`. We checked that relationship, but did not
independently verify the attestation's cryptographic signatures. That Canvas
commit pins Skia to `b94213a11b3a2edadfae89f0c57a7f4ab72772c9`.

`LICENSE` preserves both Canvas's MIT license and the Chromium image notice.
`skia/` preserves Skia's BSD license and selected notices from its source tree.
`skia-third-party/` contains version-pinned notices for the 12 native dependencies
named by the package's Skia SBOM: Brotli, Expat, FreeType, HarfBuzz, Highway, ICU,
libjpeg-turbo, libjxl, libpng, libwebp, Wuffs, and zlib. Source repositories,
revisions, URLs, and the SHA-256 of every collected original are in `SOURCES.json`.
Source-tree notices are included conservatively; their inclusion does not assert
that every source file from that directory was linked into the binary.

This software is based in part on the work of the FreeType Team
(https://freetype.org). FreeType is used under the FreeType Project License
alternative preserved in `skia-third-party/freetype/docs/FTL.TXT`.

This software is based in part on the work of the Independent JPEG Group.

## Coverage limits

The unchanged `sbom.cdx.json` comes from the published native npm package. We
matched its native binary SHA-256 to the installed binary. Its 142 components
include the binary itself, Cargo dependencies and the 12 native dependencies.
The upstream generator reads Cargo.lock, so the Cargo list can include build or
other-target dependencies; it is not an independently verified linker manifest.

This collection does not complete the Cargo component notice inventory or the
inventory of C dependencies vendored by Rust crates (including libavif/libaom).
Several listed Cargo components declare MPL-2.0. Their source availability and
notice obligations require a separate component-level review; the top-level MIT
license does not cover every bundled component or settle those obligations.
Do not describe this complete binary as exclusively MIT licensed or this
directory as a complete binary license audit.

Failed probes for optional `NOTICE` files were checked against upstream root
directory listings. Those absent files were not fabricated. The fetched license
and attribution files retain their original bytes, including historical dates.
