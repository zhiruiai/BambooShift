# Product icon

BambooShift's icon is a large charcoal rounded form with two white, gently tilted eyes. Its simple geometry, generous mark size and high contrast remain legible at launcher and favicon sizes.

[The SVG master](../web/public/favicon.svg) is the editable source. It has no fonts, external images or filters. Do not edit generated PNGs independently.

Run `npm run icons` to refresh the desktop setup logo, Web/PWA icons and native iOS/Android launcher assets. The desktop packager derives macOS ICNS and Windows ICO from the same master. Mobile artwork uses an opaque canvas so the operating system can apply its own corner mask. The maskable PWA export keeps the white mark within the central 80% safe circle and extends its dark backdrop to the canvas edges.

Inspect the generated icons at 16, 24, 32, 64 and 1024 pixels on light and dark backgrounds before changing the master. The export command also writes ignored, local 1024-, 2048- and 4096-pixel previews for review. Product artwork is distributed under the repository license.

See [Avatar animation](avatar-animation.md) for character artwork, task expressions and animation attribution.
