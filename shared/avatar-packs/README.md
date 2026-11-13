# Community avatar packs

Two pinned, offline geometry packs extend BambooShift's original avatar themes.
They contain **all 22 Open Bot Avatar characters** (7 starters and 15 gallery
characters) and **all 18 community GrokBot shapes**, not a selection of six.

The default **Classic black** preset is defined separately in
`shared/avatar-classic.json`. It combines six of the existing community GrokBot
shapes with a charcoal body and the pack's light eyes. It keeps the same vector
geometry, task expressions, visibility and reduced-motion handling. This is a
community-derived preset, not an official xAI asset. Existing explicit theme
choices remain unchanged; new and unset preferences use Classic black.

`catalog.json` is the small cross-client theme allowlist. Theme IDs are stable:
`open-avatar-<sourceId>` and `grokbot-<sourceId>`. A theme changes the shared
silhouette; each Bot keeps its existing role key. Individual community themes
keep role colors, while the Classic black preset uses its fixed monochrome palette. Source names remain
available alongside English and Chinese display labels.

## Drawing contract

Each pack contains `manifest.json`, `expressions.json`, original source data in
`upstream.json`, the unmodified upstream `LICENSE`, and a pinned `SOURCES.json`
inventory with source hashes. Geometry uses a `0 0 100 100` viewBox.

- `shapes[id].body.path` is a closed SVG path with its recorded fill rule.
- An expression is `[leftEye, rightEye]`. Each eye is a closed ring of 48 `[x,y]`
  points; connect the last point back to the first. Point positions can be
  interpolated between expressions without changing topology.
- Apply `eyeTransform` in SVG affine order `[a,b,c,d,e,f]` to each point first.
  Apply `eyeScale` around **each transformed eye's own centroid**, preserving the
  distance between the two eye centers. Clip the resulting eyes to the body.
- Use `eyeColor` for the eyes. The Bot's role color overrides `defaultColor`.
- Open Bot Avatar shape records map `idle`, `thinking`, and `happy` to expression
  IDs. The ring outlines are sampled from its native pill and round-stroke arc
  eyes. Its original definitions are preserved. BambooShift adapts its
  silhouettes and eye geometry; it does **not** port the inferred-volume 3D
  renderer.
- Community GrokBot preserves all 25 native expressions, 39 native state pools
  and cadences, face corrections, gaze limits, blink and spring parameters.
  `faceOrigin`, `faceRadius` and `squashOnTurn` support its original spherical
  projection if a client enables head turns. They do not require an upstream
  timer or widget runtime.

Clients own visibility, lifecycle, reduced motion and current-task state. A
historical completed message is static. A state change interpolates from the
pose currently displayed, and replacing a theme invalidates older async loads.
The product maps task states to native expressions separately from upstream
data: approval is `alerting` / `thinking`, success is `celebrate` / `happy`, and
failure is `sad` / `thinking` (GrokBot / Open Bot Avatar respectively).

## Resolution and export

The 100-unit viewBox is a coordinate system, not a 100-pixel image. Web clients
draw inline SVG and Flutter draws paths at the current display density. Keep
that vector path through theme selection, conversation avatars and enlarged
previews; do not replace it with a thumbnail enlarged by CSS or a bitmap widget.
The original upstream definitions remain in `upstream.json`.

When a platform or export format requires a bitmap, render from the vector
source at the requested physical pixel size. Keep the vector master and export
1×, 2× and 3× assets independently as required; never generate a larger asset
from a smaller PNG. Application launcher icons have their own platform size
sets and are generated separately from the product's SVG master.

## Attribution and limits

Open Bot Avatar is by Dominik Scholz, distributed under MIT. Its repository
describes starter geometry as generated from its avatar design prompt and
expressly licenses gallery contributions under MIT.

GrokBot is the **community project by nasawz**, distributed under BSD-3-Clause.
Its documented Web port attributes the expression, shape, and state design to
nasawz. This inventory records that published attribution and license; it does
not claim independent proof of authorship or a license from xAI. No screenshot,
remote image, or proprietary official character file was downloaded from xAI.
GrokBot is named only to identify the upstream community project. Neither
BambooShift nor these packs imply xAI affiliation or endorsement.

Regenerate only from the revisions listed in each `SOURCES.json`:

```sh
node scripts/avatars/import-community-packs.mjs <open-bot-avatar-source> <community-grokbot-source>
node scripts/avatars/sync-community-packs.mjs
```

The importer reads local pinned sources and writes data only. It adds no
upstream animation runtime, network call, or additional service.

The sync step generates Flutter's catalog, copies its runtime geometry, and
publishes the unchanged licenses in both clients. `npm run check:source`
checks these outputs for drift. The backend compiles the same small catalog
for theme selection, account synchronization and generated-theme validation.
