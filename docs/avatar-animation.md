# Avatar animation

BambooShift includes five original vector themes: Companions, Pandas, Dinosaurs, Chicks and Elephants. The Web and desktop clients render layered SVG artwork. The Flutter client uses the same character assets and its own motion widgets. A Bot keeps its theme, shape and color as it moves through idle, thinking, working, waiting for approval, success and failure. Status text provides the same information when motion is disabled.

The browser and desktop clients draw the eyes in SVG. Flutter draws the matching eye layers over the same original artwork. Both consume the [shared geometry and task poses](../shared/avatar-face-motion.json). Recent task completions transition to their final expression. Historical results open with a static expression. Uploaded images stay static.

Web pauses the eye animation clock when the artwork leaves the viewport or the page is hidden and respects `prefers-reduced-motion`. Flutter respects the platform animation setting, application lifecycle and `TickerMode`. Task text conveys the state at all sizes, including in a compact sidebar. [Web avatar](../web/src/components/Avatar.tsx) · [Flutter avatar](../mobile/lib/widgets/bot_avatar.dart)

## Design references

xAI describes using recognizable silhouettes and task expressions to communicate activity at sidebar sizes. Its public design article documents the interaction and artwork. Novra separately published an independent Rive concept with state transitions and pointer-driven gaze. [xAI design article](https://x.ai/news/designing-grok-bot#what-are-they-doing) · [Novra case study](https://www.novra.design/case-studies/grokbot)

| Project | Verified scope |
| --- | --- |
| BoopFace (MIT) | Browser component with its own robot shell, SVG eye poses and timed expression transitions. The public Web component does not expose a way to mount expressions on arbitrary SVG artwork. [Pinned source and license](https://github.com/CX-ArtLab/BoopFace/tree/24ee5f698e58fa4f131b5ae7827373814e191f4c) |
| Open Bot Avatar (MIT) | Validated JSON describes a single silhouette and its eyes. The repository provides browser animation and static SVG export. Its schema and rendering suit simple custom shapes. [Pinned source and license](https://github.com/DominikScholz/open-bot-avatar/tree/921907e614fb40e76c249bf8684d8619a8a3bf0f) |
| GrokBot Web and GrokBot Flutter (BSD-3-Clause) | Community implementations with eye-shape interpolation. The Web project ports the Flutter project's expressions to Canvas. [Web source](https://github.com/Coiggahou2002/grokbot-web/tree/616c1dd451f105a10a903e01eed8f82370968681) · [Flutter source](https://github.com/nasawz/GrokBot/tree/bb7b634b029a6c99121cb74954020ddfc8c07acf) |
| Rive (MIT runtimes) | Web and Flutter runtimes can play authored Rive assets and state machines. Using them would require new animation assets for the BambooShift characters. [Web runtime](https://github.com/rive-app/rive-wasm) · [Flutter runtime](https://github.com/rive-app/rive-flutter) |

## BoopFace attribution

The panda prototype validated adapting eye-shape interpolation and gaze smoothing to the original BambooShift eye layers. The production renderers apply the same approach across the five themes. Both renderers use normalized eye dimensions and lids for each pose, with the original silhouettes, palettes and other face details preserved. The adaptation carries the original MIT notice, copyright 2026 CX ART Lab. [Pose data and interpolation](https://github.com/CX-ArtLab/BoopFace/blob/24ee5f698e58fa4f131b5ae7827373814e191f4c/src/boopface-core.js) · [Gaze smoothing](https://github.com/CX-ArtLab/BoopFace/blob/24ee5f698e58fa4f131b5ae7827373814e191f4c/embedded/lib/BoopFace/src/BoopFaceGaze.h#L46-L54) · [MIT license](../legal/third-party/boopface-0.8.0/LICENSE)

The integration uses BoopFace’s small interpolation and smoothing routines with BambooShift’s own artwork and renderers.
