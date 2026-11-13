/** Offline importer for pinned, licensed community avatar geometry. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [openSource, grokSource] = process.argv.slice(2).map((value) => path.resolve(value));
assert(openSource && grokSource, 'Pass the pinned Open Bot Avatar and GrokBot source directories.');
const output = path.join(root, 'shared/avatar-packs');
const round = (value) => Math.round(value * 1e6) / 1e6;
const point = (x, y) => [round(x), round(y)];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const read = (directory, file) => readFile(path.join(directory, file), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const labels = {
  controller: '游戏手柄', barbell: '哑铃', mug: '咖啡杯', lightbulb: '灯泡', chat: '对话气泡', sprout: '小盆栽', 'watering-can': '浇水壶',
  book: '书本', brain: '大脑', bull: '小牛', bunny: '兔子', camera: '相机', cat: '猫咪', cloud: '云朵', ghost: '小幽灵', magnifier: '放大镜', 'paint-brush': '画笔', palette: '调色盘', rocket: '火箭', shield: '盾牌', star: '星星', 'witch-hat': '巫师帽',
  blob: '圆团', pebble: '鹅卵石', bean: '豆豆', egg: '蛋形', squircle: '圆方块', tablet: '小板', capsule: '胶囊', cylinder: '圆柱', hex: '六角', gem: '宝石', crystal: '水晶', wedge: '楔形', dome: '穹顶', arch: '拱门', teardrop: '水滴', leaf: '叶子',
};

function recordsJson(value) {
  return `{\n${Object.entries(value).map(([key, record]) => `  ${JSON.stringify(key)}: ${JSON.stringify(record)}`).join(',\n')}\n}\n`;
}

function resample(ring, count = 48) {
  const lengths = ring.map((p, i) => Math.hypot(p[0] - ring[(i + 1) % ring.length][0], p[1] - ring[(i + 1) % ring.length][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  return Array.from({ length: count }, (_, i) => {
    let distance = total * i / count;
    let segment = 0;
    while (distance > lengths[segment] && segment < lengths.length - 1) distance -= lengths[segment++];
    const t = lengths[segment] ? distance / lengths[segment] : 0;
    const a = ring[segment], b = ring[(segment + 1) % ring.length];
    return point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  });
}

function pillRing(mark) {
  const { x, y, width: w, height: h, radius: r } = mark;
  const centers = [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]];
  return resample(centers.flatMap(([cx, cy], corner) => Array.from({ length: 24 }, (_, i) => {
    const angle = (corner - 1) * Math.PI / 2 + i / 23 * Math.PI / 2;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  })));
}

function arcRing(mark) {
  const [x0, y0, cx, cy, x1, y1] = mark.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const radius = mark.strokeWidth / 2;
  const samples = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39, u = 1 - t;
    const dx = 2 * (u * (cx - x0) + t * (x1 - cx));
    const dy = 2 * (u * (cy - y0) + t * (y1 - cy));
    const angle = Math.atan2(dy, dx);
    return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1, angle };
  });
  const side = (sample, sign) => [sample.x - Math.sin(sample.angle) * radius * sign, sample.y + Math.cos(sample.angle) * radius * sign];
  const cap = (sample, start) => Array.from({ length: 12 }, (_, i) => {
    const angle = sample.angle + start + i / 11 * Math.PI;
    return [sample.x + Math.cos(angle) * radius, sample.y + Math.sin(angle) * radius];
  });
  return resample([
    ...samples.map((sample) => side(sample, -1)),
    ...cap(samples.at(-1), -Math.PI / 2),
    ...samples.toReversed().map((sample) => side(sample, 1)),
    ...cap(samples[0], Math.PI / 2),
  ]);
}

async function writePack(id, manifest, expressions, upstream, files) {
  const directory = path.join(output, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), json(manifest));
  await writeFile(path.join(directory, 'expressions.json'), recordsJson(expressions));
  await writeFile(path.join(directory, 'upstream.json'), recordsJson(upstream));
  const sourceDirectory = id === 'open-avatar' ? openSource : grokSource;
  await writeFile(path.join(directory, 'LICENSE'), await read(sourceDirectory, 'LICENSE'));
  const sourceFiles = await Promise.all(files.map(async (file) => ({ path: file, sha256: sha256(await read(sourceDirectory, file)) })));
  await writeFile(path.join(directory, 'SOURCES.json'), json({
    repository: manifest.repository, revision: manifest.revision, license: manifest.license,
    copyright: manifest.copyright, files: sourceFiles,
    transformations: id === 'open-avatar'
      ? ['Preserved all 7 starter and 15 gallery definitions.', 'Sampled the upstream depth-zero native pill and round-stroke happy eyes to closed 48-point rings.', 'Kept the three native moods; BambooShift state mappings are separate adapter policy.']
      : ['Preserved all 18 body and face descriptors, 25 expressions and 39 state records.', 'Converted rounded bodies and 259-unit eye coordinates to a 100-unit viewBox.', 'Preserved native per-eye scale and face transform; the expression rings are not replaced.'],
    provenance: id === 'open-avatar'
      ? 'The pinned upstream describes starter geometry as generated using its own avatar design prompt and explicitly licenses gallery contributions under MIT.'
      : 'The pinned upstream publishes these parameter tables under BSD-3-Clause. Its documented TypeScript port attributes shape, expression and state design to nasawz. No xAI-extracted image or official character asset is bundled. This records the community author attribution, not independent proof of authorship or an xAI license.',
    affiliation: 'Independent community artwork; no endorsement by or affiliation with xAI is implied.',
  }));
}

async function importOpenAvatar() {
  const moduleUrl = (file) => pathToFileURL(path.join(openSource, 'packages/core/src', file)).href;
  const { examples } = await import(moduleUrl('examples.ts'));
  const { avatarFrame } = await import(moduleUrl('render.ts'));
  const { validateAvatar } = await import(moduleUrl('validate.ts'));
  const galleryFiles = (await readdir(path.join(openSource, 'gallery'))).filter((name) => name.endsWith('.json') && name !== 'colors.json').sort();
  const definitions = [...examples, ...await Promise.all(galleryFiles.map(async (name) => JSON.parse(await read(openSource, `gallery/${name}`))))];
  const colors = JSON.parse(await read(openSource, 'gallery/colors.json'));
  assert.equal(definitions.length, 22);
  const shapes = {}, expressions = {}, upstream = {};
  for (const definition of definitions) {
    assert(validateAvatar(definition).ok, `Invalid upstream avatar ${definition.id}`);
    upstream[definition.id] = definition;
    const moodExpressions = {};
    for (const motion of ['idle', 'thinking', 'happy']) {
      const frame = avatarFrame(definition, { depth: 0, motion, reducedMotion: true });
      const eyes = frame.shapes.filter((shape) => shape.kind === 'eye').sort((a, b) => a.key.localeCompare(b.key));
      assert.equal(eyes.length, 2);
      const id = `${definition.id}:${motion}`;
      expressions[id] = eyes.map(({ mark }) => mark.shape === 'pill' ? pillRing(mark) : arcRing(mark));
      moodExpressions[motion] = id;
    }
    shapes[definition.id] = {
      sourceName: definition.name, label: { en: definition.name, zh: labels[definition.id] }, defaultColor: colors[definition.id],
      body: { path: definition.body.path, fillRule: 'nonzero' },
      eyeTransform: [1, 0, 0, 1, 0, 0], eyeScale: 1, expressions: moodExpressions,
      nativeEyes: definition.eyes,
    };
  }
  await writePack('open-avatar', {
    schemaVersion: 1, id: 'open-avatar', name: 'Open Bot Avatar', viewBox: [0, 0, 100, 100],
    repository: 'https://github.com/DominikScholz/open-bot-avatar', revision: '921907e614fb40e76c249bf8684d8619a8a3bf0f',
    license: 'MIT', copyright: 'Copyright (c) 2026 Dominik Scholz', eyeColor: '#151515',
    expressionFormat: 'closed-eye-rings-48', expressionsFile: 'expressions.json',
    states: { idle: { expression: 'idle' }, thinking: { expression: 'thinking' }, happy: { expression: 'happy' } },
    motion: { transitionMs: 420, blinkDurationMs: 190, blinkSlotMs: 4200, gazeMax: [1.5, 1.1] },
    shapes,
  }, expressions, upstream, ['LICENSE', 'gallery/README.md', 'gallery/colors.json', 'packages/core/src/examples.ts', 'packages/core/src/render.ts', 'packages/core/src/motion.ts', ...galleryFiles.map((file) => `gallery/${file}`)]);
}

function radiiFor(radius, width, height) {
  const expand = (tokens) => tokens.length === 1 ? Array(4).fill(tokens[0]) : tokens.length === 2 ? [...tokens, ...tokens] : tokens.length === 3 ? [...tokens, tokens[1]] : tokens;
  const parts = radius.split('/');
  const values = (part, axis) => expand(part.trim().split(/\s+/)).map((token) => Number.parseFloat(token) * (token.endsWith('%') ? axis / 100 : 1));
  const x = values(parts[0], width), y = values(parts[1] ?? parts[0], height);
  const clampPair = (array, a, b, size) => { const sum = array[a] + array[b]; if (sum > size) { array[a] *= size / sum; array[b] *= size / sum; } };
  clampPair(x, 0, 1, width); clampPair(x, 3, 2, width); clampPair(y, 0, 3, height); clampPair(y, 1, 2, height);
  return x.map((v, i) => [v, y[i]]);
}

function roundedBody(shape) {
  const n = (value) => round((value + 15) * 100 / 259);
  const d = (value) => round(value * 100 / 259);
  const width = 210 * shape.aspectX, height = 210 * shape.aspectY;
  const l = 114.2705 - width / 2, t = 114.2705 - height / 2, r = l + width, b = t + height;
  const [tl, tr, br, bl] = radiiFor(shape.radius, width, height);
  return `M${n(l + tl[0])} ${n(t)}H${n(r - tr[0])}A${d(tr[0])} ${d(tr[1])} 0 0 1 ${n(r)} ${n(t + tr[1])}V${n(b - br[1])}A${d(br[0])} ${d(br[1])} 0 0 1 ${n(r - br[0])} ${n(b)}H${n(l + bl[0])}A${d(bl[0])} ${d(bl[1])} 0 0 1 ${n(l)} ${n(b - bl[1])}V${n(t + tl[1])}A${d(tl[0])} ${d(tl[1])} 0 0 1 ${n(l + tl[0])} ${n(t)}Z`;
}

async function importGrokBot() {
  const shapeText = await read(grokSource, 'lib/src/data/shape_data.dart');
  const stateText = await read(grokSource, 'lib/src/data/state_data.dart');
  const ringText = await read(grokSource, 'lib/src/data/expression_data.dart');
  const rawPoints = [...ringText.matchAll(/Offset\(([-.\d]+),\s*([-.\d]+)\)/g)].map((match) => [Number(match[1]), Number(match[2])]);
  const points = rawPoints.map(([x, y]) => point((x + 15) * 100 / 259, (y + 15) * 100 / 259));
  assert.equal(points.length, 25 * 2 * 48);
  const expressions = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`expression${String(i).padStart(2, '0')}`, [points.slice(i * 96, i * 96 + 48), points.slice(i * 96 + 48, (i + 1) * 96)]]));
  const shapes = {}, upstream = {};
  const keys = ['faceX', 'faceY', 'faceScaleX', 'faceScaleY', 'eyeScale', 'squashOnTurn', 'radius', 'aspectX', 'aspectY'];
  for (const match of shapeText.matchAll(/GrokBotShape\.(\w+):\s*GrokBotShapeData\(([\s\S]*?)\)/g)) {
    const args = match[2].split(',').map((v) => v.trim()).filter(Boolean).map((v) => v.startsWith("'") ? v.slice(1, -1) : v === 'false' ? false : v === 'true' ? true : Number(v));
    assert.equal(args.length, 9);
    const shape = Object.fromEntries(keys.map((key, i) => [key, args[i]]));
    upstream[match[1]] = shape;
    const center = (114.2705 + 15) * 100 / 259;
    shapes[match[1]] = {
      sourceName: match[1], label: { en: match[1][0].toUpperCase() + match[1].slice(1), zh: labels[match[1]] }, defaultColor: '#5b7fe5', body: { path: roundedBody(shape), fillRule: 'nonzero' },
      eyeTransform: [shape.faceScaleX, 0, 0, shape.faceScaleY, round(center * (1 - shape.faceScaleX) + shape.faceX * 100 / 259), round(center * (1 - shape.faceScaleY) + shape.faceY * 100 / 259)],
      eyeScale: shape.eyeScale, squashOnTurn: shape.squashOnTurn,
      faceOrigin: point(center + shape.faceX * 100 / 259, center + shape.faceY * 100 / 259),
      faceRadius: round(105 * Math.min(shape.faceScaleX, shape.faceScaleY) * 100 / 259),
    };
  }
  const states = {};
  const statePattern = /GrokBotState\.(\w+):\s*GrokBotStateData\(\s*_expressions\(\[([^\]]+)\]\),\s*_cadence\((\d+),\s*(\d+)\),\s*(null|_cadence\((\d+),\s*(\d+)\)),\s*\)/g;
  for (const match of stateText.matchAll(statePattern)) states[match[1] === 'poweringDown' ? 'powering-down' : match[1]] = {
    expressions: match[2].split(',').map((value) => `expression${String(Number(value)).padStart(2, '0')}`),
    expressionCadenceMs: [Number(match[3]), Number(match[4])],
    blinkCadenceMs: match[5] === 'null' ? null : [Number(match[6]), Number(match[7])],
  };
  assert.equal(Object.keys(shapes).length, 18); assert.equal(Object.keys(states).length, 39);
  await writePack('grokbot', {
    schemaVersion: 1, id: 'grokbot', name: 'Community GrokBot', viewBox: [0, 0, 100, 100],
    repository: 'https://github.com/nasawz/GrokBot', revision: 'bb7b634b029a6c99121cb74954020ddfc8c07acf',
    license: 'BSD-3-Clause', copyright: 'Copyright (c) 2026, nasawz', eyeColor: '#fffdf7',
    expressionFormat: 'closed-eye-rings-48', expressionsFile: 'expressions.json', states,
    motion: { blinkDurationMs: 320, blinkCloseFraction: 0.42, minimumBlinkScale: 0.04, springFrequency: 7, springDampingRatio: 1, gazeMax: [round(13.2 * 100 / 259), round(8.4 * 100 / 259)] },
    shapes,
  }, expressions, {
    shapes: upstream,
    expressions: Array.from({ length: 25 }, (_, i) => [rawPoints.slice(i * 96, i * 96 + 48), rawPoints.slice(i * 96 + 48, (i + 1) * 96)]),
    states,
    geometry: { faceCenter: 114.2705, bodyWidth: 228.541, viewBoxSize: 259, viewBoxInset: 15 },
  }, ['LICENSE', 'README.md', 'lib/src/data/shape_data.dart', 'lib/src/data/expression_data.dart', 'lib/src/data/state_data.dart', 'lib/src/grokbot_painter.dart', 'lib/src/geometry.dart', 'lib/src/theme.dart']);
}

await importOpenAvatar();
await importGrokBot();
const packs = await Promise.all(['open-avatar', 'grokbot'].map(async (id) => {
  const pack = JSON.parse(await read(output, `${id}/manifest.json`));
  return { id, name: pack.name, license: pack.license, repository: pack.repository, themes: Object.entries(pack.shapes).map(([sourceId, shape]) => ({ id: `${id}-${sourceId}`, sourceId, name: shape.sourceName, label: shape.label })) };
}));
await writeFile(path.join(output, 'catalog.json'), json({ version: 1, packs }));
console.log('Imported 22 Open Bot Avatar shapes and 18 community GrokBot shapes (25 expressions, 39 states).');
