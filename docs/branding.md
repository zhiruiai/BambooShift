# Product icon

BambooShift's original icon is a small, friendly bamboo companion: a pearl face, leaf-shaped ears and a new shoot against a deep jade field. The broad silhouette and high-contrast eyes remain legible at launcher and favicon sizes.

[The SVG master](../web/public/favicon.svg) is the editable source. It has no fonts, external images or filters. Do not edit generated PNGs independently.

Run `npm run icons` to refresh the desktop setup logo, Web/PWA icons and native iOS/Android launcher assets. The desktop packager derives macOS ICNS and Windows ICO from the same master. Mobile artwork uses an opaque canvas so the operating system can apply its own corner mask. The maskable PWA export gives the complete mark extra safe-area padding.

Inspect the generated icons at 16, 24, 32, 64 and 1024 pixels on light and dark backgrounds before changing the master. The export command also writes an ignored, local 1024-pixel preview for review. Product artwork is distributed under the repository license.

See [Avatar animation](avatar-animation.md) for character artwork, task expressions and animation attribution.
