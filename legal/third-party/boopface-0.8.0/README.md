# BoopFace source adaptation

Selected eye-pose parameters and interpolation helpers are adapted from [CX-ArtLab/BoopFace](https://github.com/CX-ArtLab/BoopFace/tree/24ee5f698e58fa4f131b5ae7827373814e191f4c), package version 0.8.0, commit `24ee5f698e58fa4f131b5ae7827373814e191f4c`. The original MIT license is preserved unchanged in [LICENSE](LICENSE). [SOURCES.json](SOURCES.json) records the exact upstream files and their SHA-256 values.

The selected code comes from `src/boopface-core.js` (eye poses, easing, and interpolation) and `embedded/lib/BoopFace/src/BoopFaceGaze.h` (time-weighted gaze smoothing). Both the repository and embedded library carry the same copyright holder and MIT terms. BambooShift converts the parameters to its own avatar coordinates and renders its own body artwork. It does not embed the upstream robot body, component registration, gesture system, skins, hardware integrations, or preview dependencies.

This is a source adaptation, not an installed npm dependency. The dependency supplement manifest is intentionally reserved for exact npm/Cargo packages and does not collect this notice automatically. Keep the original license with redistributed adaptations. The root `THIRD_PARTY.md` includes its complete text for service and desktop packages; standalone Web and Flutter builds must also retain their shipped notice assets.

The avatar expresses supplied application states. Its animation does not establish task success, user presence, attention, or access to a camera, microphone, or screen. Upstream target smoothing is mathematical input processing; it does not itself provide a sensor.
