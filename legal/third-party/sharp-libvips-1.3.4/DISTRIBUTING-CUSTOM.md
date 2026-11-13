# BambooShift source-built native image codecs

This distribution is built by BambooShift from fixed upstream source archives.
It is not an official sharp-libvips binary or the original
`@img/sharp-libvips-darwin-arm64` npm publication. Its own distribution manifest
identifies the binary archive, corresponding-source archive, library, version
metadata, build recipe and original legal texts by SHA-256. The npm lock records
upstream inputs; it does not describe the substituted library's bytes.

The source-built library contains independently licensed software. BambooShift's
MIT license does not relicense these components. Use the original permission,
copyright, patent and disclaimer texts in `LICENSES/`, together with the complete
source archives accompanying this distribution.

## Acknowledgements and license choices

This software is based in part on the work of the Independent JPEG Group.

Portions of this software are copyright © 1996–2026 The FreeType Project
(https://freetype.org). All rights reserved. FreeType is used under the FreeType
License in `LICENSES/freetype/docs/FTL.TXT`. Its separately licensed contributed
code retains the notices identified in `LICENSE.TXT` and included in `LICENSES/`.

The retained libraries include proxy-libintl, zlib-ng, libffi, GLib (including
gvdb), libxml2, libexif, Little CMS, libaom, libheif, mozjpeg/libjpeg-turbo, libpng,
the BSD-licensed libimagequant fork, libwebp, libtiff, Highway, FreeType, Expat,
libarchive, fontconfig, HarfBuzz, pixman, Cairo, FriBidi, Pango, cgif, libultrahdr
and libvips (including libnsgif).

Cairo is used under its MPL 1.1 alternative. The applicable LGPL libraries are
used under LGPL version 3, using their permitted later-version option where
necessary, as in the pinned upstream build. The complete LGPLv3 and GPLv3 texts
are included in `LICENSES/heif/COPYING`; the other components' original texts
are also retained. AOM and WebP patent notices are included. These selections
do not replace separately applicable notices in contributed or embedded code.

The 27 source archives and their referenced legal files are pinned in
`NATIVE-NOTICES.json`. The notice collection intentionally includes some build,
test and alternative-license material. This conservative superset is not a
claim that every such component or optional feature is linked into the library.
Full source archives retain per-file authorship and permission notices.

## Source, changes and replacement

Distribute the corresponding-source archive alongside the binary archive at the
same release location, with equal access. It contains every fixed source archive
and upstream patch, the recipe and platform files, the dated BambooShift patches,
the complete build entry point, tool requirements, and this notice collection.
`REBUILD.md` gives the clean rebuild and shared-library replacement procedure.
A URL catalog, a license summary or an empty source-download link is not a
substitute for these materials.

Changes dated 2026-11-13 disable librsvg through libvips' supported build option,
remove its unused build dependencies, and make build paths and archive metadata
independent of the build machine. The exact changes are supplied as patches.
The original libraries' author notices remain intact. The separate audit of the
official npm binaries and its four unresolved old Rust notices is unchanged;
this new source-built library does not retrospectively approve those binaries.

Recipients may modify the LGPL components and rebuild and replace the shared
library with an ABI-compatible version. Do not add contractual restrictions on
modification or on reverse engineering needed to debug such modifications. Do
not make execution depend on a vendor-only signing key. Locally modified macOS
libraries and app bundles may require a new local ad-hoc signature as described
in `REBUILD.md`; operating-system permissions remain separate.

## Consuming a candidate

Keep the custom library and its notices under a separate
`native-image-runtime/<build-id>/` directory. The unmodified Sharp addon can
reach it through a relative link from its expected sibling-library path. Record
that overlay, including original input hashes and replacement hashes, separately
from the npm lock. Update the library's version metadata with the candidate's
metadata so absent features are not reported as available.

Before accepting a candidate, independently pin and verify its distribution
manifest, both actual archives, source inventory, complete notice members and
loaded-library hash. Then validate the complete desktop package, image contract,
signing and lifecycle. Material collection alone does not authorize publication
or enable the managed-runtime release workflow. Other platforms require their
own native build and acceptance evidence.
