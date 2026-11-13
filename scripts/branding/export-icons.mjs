import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const master = await readFile(join(root, 'web/public/favicon.svg'), 'utf8');
// Native mobile launchers apply their own corner mask. Keep their canvas opaque.
const opaque = master.replace('<defs/>', '<rect width="512" height="512" fill="#101010"/><defs/>');
const render = (svg, size) => {
  const pipeline = sharp(Buffer.from(svg), { density: 576 }).resize(size, size);
  // iOS requires an RGB launcher asset, even when every RGBA pixel is opaque.
  return (svg === master ? pipeline : pipeline.removeAlpha())
    .png({ compressionLevel: 9 })
    .toBuffer();
};
const output = async (path, size, svg = master) =>
  writeFile(join(root, path), await render(svg, size));

await writeFile(join(root, 'desktop/ui/logo.svg'), master);
await output('web/public/icon-192.png', 192);
await output('web/public/icon-512.png', 512);
await output('web/public/apple-touch-icon.png', 180, opaque);
// Keep the entire mark inside the central 80% circle on any maskable launcher.
const maskable = opaque.replace(
  '<g id="mark">',
  '<g id="mark" transform="translate(71.68 71.68) scale(.72)">',
);
await output('web/public/icon-maskable-512.png', 512, maskable);
const apple = 'mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset';
const manifest = JSON.parse(await readFile(join(root, apple, 'Contents.json'), 'utf8'));
for (const { filename, size, scale } of manifest.images) {
  const pixels = Number(size.split('x')[0]) * Number(scale.replace('x', ''));
  await output(`${apple}/${filename}`, pixels, opaque);
}
for (const [density, size] of Object.entries({
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
}))
  await output(`mobile/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size, opaque);
await mkdir(join(root, '.local/branding'), { recursive: true });
for (const size of [1024, 2048, 4096]) await output(`.local/branding/icon-${size}.png`, size);
console.log('Updated Web, iOS and Android icons from the shared SVG master.');
