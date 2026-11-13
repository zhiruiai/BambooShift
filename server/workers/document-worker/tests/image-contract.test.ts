import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { ATTACHMENT_LIMITS, type AttachmentResult } from '../contract.ts';
import {
  animatedWebp,
  apng,
  blockSize,
  colourGrid,
  contractTargets,
  noisyJpeg,
  orientedImage,
  padPng,
  palette,
  solidPng,
} from './image-contract.fixture.ts';

// Independent EXIF expectations: the source is A B C / D E F. No codec transform
// is used to calculate the expected rotations, reflections or output dimensions.
const orientations = [
  [
    [0, 1, 2],
    [3, 4, 5],
  ],
  [
    [2, 1, 0],
    [5, 4, 3],
  ],
  [
    [5, 4, 3],
    [2, 1, 0],
  ],
  [
    [3, 4, 5],
    [0, 1, 2],
  ],
  [
    [0, 3],
    [1, 4],
    [2, 5],
  ],
  [
    [3, 0],
    [4, 1],
    [5, 2],
  ],
  [
    [5, 2],
    [4, 1],
    [3, 0],
  ],
  [
    [2, 5],
    [1, 4],
    [0, 3],
  ],
];
const animationWarning = '动态图像只读取第一帧。';
const resizeWarning = '图片已按方向信息校正，并缩放到适合模型观察的尺寸。';
const workerRejection = '附件解析失败，文件可能损坏、不受支持或超过限制。';

function rejectedFor(sourceMessage: RegExp) {
  return (error: unknown) =>
    error instanceof Error &&
    (error.message === workerRejection || sourceMessage.test(error.message));
}

async function decoded(result: AttachmentResult, name: string, bytes: Buffer, mime: string) {
  assert.equal(result.kind, 'image');
  assert.ok(result.kind === 'image');
  assert.equal(result.name, name);
  assert.equal(result.sourceMimeType, mime);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.truncated, false);
  const png = Buffer.from(result.data, 'base64');
  assert.ok(png.length <= ATTACHMENT_LIMITS.imageOutputBytes);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, result.width);
  assert.equal(metadata.height, result.height);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.orientation, undefined);
  return { result, ...(await sharp(png).raw().toBuffer({ resolveWithObject: true })) };
}

function pixel(data: Buffer, width: number, channels: number, x: number, y: number) {
  const offset = (y * width + x) * channels;
  return Array.from(data.subarray(offset, offset + channels));
}

function near(actual: number[], expected: number[], tolerance: number, context: string) {
  assert.equal(actual.length, expected.length, context);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `${context}: ${actual} != ${expected} (±${tolerance})`,
    );
  });
}

// By default build the real worker with development dependencies. To qualify a
// replacement runtime, set OPENBOT_IMAGE_CONTRACT_RUNTIME to its runtime directory
// and optionally OPENBOT_IMAGE_CONTRACT_NODE to its Node executable. No install or
// native build is performed, and fixture generation always uses development Sharp.
test(
  'production image contract in source and the compiled worker',
  { timeout: 180_000 },
  async (t) => {
    const harness = await contractTargets();
    t.after(harness.close);
    for (const target of harness.targets) {
      await t.test(target.label, async (suite) => {
        for (const format of ['png', 'jpeg', 'webp'] as const) {
          await suite.test(
            `${format}: all eight EXIF orientations preserve the colour matrix`,
            async () => {
              for (let index = 0; index < orientations.length; index++) {
                const orientation = index + 1;
                const bytes = await orientedImage(format, orientation);
                assert.equal((await sharp(bytes).metadata()).orientation, orientation);
                const name = `orientation-${orientation}.${format}`;
                const output = await decoded(
                  await target.parse(name, bytes),
                  name,
                  bytes,
                  `image/${format}`,
                );
                const matrix = orientations[index];
                assert.equal(output.result.width, matrix[0].length * blockSize);
                assert.equal(output.result.height, matrix.length * blockSize);
                assert.equal(output.result.originalWidth, 3 * blockSize);
                assert.equal(output.result.originalHeight, 2 * blockSize);
                assert.deepEqual(output.result.warnings, orientation >= 5 ? [resizeWarning] : []);
                for (let y = 0; y < matrix.length; y++) {
                  for (let x = 0; x < matrix[y].length; x++) {
                    near(
                      pixel(
                        output.data,
                        output.info.width,
                        output.info.channels,
                        x * blockSize + 32,
                        y * blockSize + 32,
                      ),
                      palette[matrix[y][x]],
                      format === 'jpeg' ? 4 : 1,
                      `${format} EXIF ${orientation} block ${x},${y}`,
                    );
                  }
                }
              }
            },
          );
        }

        await suite.test(
          'embedded P3 and CMYK profiles convert to sRGB before stripping metadata',
          async () => {
            // CMYK is not lossless: freeze the reviewed full-runtime baseline, rather
            // than computing the expected colours with the transform under test.
            // Sharp 0.35.5 / libvips 8.18.7 built-in CMYK ICC, quality 100, 4:4:4.
            const cmykExpected = [
              [42, 41, 31],
              [184, 182, 182],
              [166, 59, 43],
              [58, 140, 64],
              [52, 80, 135],
              [131, 96, 142],
            ];
            for (const profile of ['p3', 'cmyk'] as const) {
              const image = colourGrid().withIccProfile(profile);
              const bytes = await (
                profile === 'p3'
                  ? image.png()
                  : image.toColourspace('cmyk').jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
              ).toBuffer();
              const input = await sharp(bytes).metadata();
              assert.ok(input.icc && input.icc.length > 100);
              assert.equal(input.space, profile === 'cmyk' ? 'cmyk' : 'srgb');
              const name = profile === 'p3' ? 'p3.png' : 'cmyk.jpg';
              const output = await decoded(
                await target.parse(name, bytes),
                name,
                bytes,
                profile === 'p3' ? 'image/png' : 'image/jpeg',
              );
              assert.equal(output.info.channels, 3);
              for (let index = 0; index < palette.length; index++) {
                near(
                  pixel(
                    output.data,
                    output.info.width,
                    3,
                    (index % 3) * blockSize + 32,
                    Math.floor(index / 3) * blockSize + 32,
                  ),
                  profile === 'p3' ? palette[index] : cmykExpected[index],
                  profile === 'p3' ? 2 : 3,
                  profile,
                );
              }
            }
          },
        );

        await suite.test(
          'small RGBA PNG keeps exact alpha and pixels without enlargement',
          async () => {
            const rgba = Buffer.from([10, 20, 30, 0, 100, 150, 200, 128, 25, 60, 90, 255]);
            const bytes = await sharp(rgba, { raw: { width: 3, height: 1, channels: 4 } })
              .png()
              .toBuffer();
            const output = await decoded(
              await target.parse('alpha.png', bytes),
              'alpha.png',
              bytes,
              'image/png',
            );
            assert.equal(output.result.width, 3);
            assert.equal(output.result.height, 1);
            assert.deepEqual(output.data, rgba);
            assert.deepEqual(output.result.warnings, []);
          },
        );

        await suite.test('downsampling RGBA preserves colour at translucent edges', async () => {
          const pixels = Buffer.alloc(4096 * 2 * 4);
          for (let index = 0; index < 4096 * 2; index++) {
            pixels.set(index % 4096 < 2048 ? [255, 0, 0, 255] : [0, 0, 255, 0], index * 4);
          }
          const bytes = await sharp(pixels, { raw: { width: 4096, height: 2, channels: 4 } })
            .png()
            .toBuffer();
          const output = await decoded(
            await target.parse('edge.png', bytes),
            'edge.png',
            bytes,
            'image/png',
          );
          assert.equal(output.result.width, 2048);
          assert.equal(output.result.height, 1);
          assert.equal(output.info.channels, 4);
          assert.deepEqual(pixel(output.data, 2048, 4, 0, 0), [255, 0, 0, 255]);
          assert.equal(pixel(output.data, 2048, 4, 2047, 0)[3], 0);
          const edge = pixel(output.data, 2048, 4, 1024, 0);
          assert.ok(edge[3] > 0 && edge[3] < 255);
          near(
            edge.slice(0, 3),
            [255, 0, 0],
            2,
            'transparent blue must not tint the visible red edge',
          );
          assert.deepEqual(output.result.warnings, [resizeWarning]);
        });

        await suite.test(
          'animated WebP reads the first frame and reports discarded animation',
          async () => {
            const bytes = await animatedWebp();
            assert.equal((await sharp(bytes).metadata()).pages, 2);
            const output = await decoded(
              await target.parse('animated.webp', bytes),
              'animated.webp',
              bytes,
              'image/webp',
            );
            assert.equal(output.result.width, 2);
            assert.equal(output.result.height, 1);
            assert.deepEqual(Array.from(output.data), [255, 0, 0, 255, 0, 0]);
            assert.deepEqual(output.result.warnings, [animationWarning]);
          },
        );

        await suite.test(
          'APNG preserves IDAT, including a poster excluded from the animation',
          async () => {
            for (const separatePoster of [false, true]) {
              const bytes = apng(separatePoster);
              const output = await decoded(
                await target.parse('poster.png', bytes),
                'poster.png',
                bytes,
                'image/png',
              );
              assert.equal(output.result.width, 2);
              assert.equal(output.result.height, 1);
              assert.deepEqual(Array.from(output.data), [255, 0, 0, 255, 0, 0]);
              // The current PNG loader does not expose APNG page metadata.
              assert.deepEqual(output.result.warnings, []);
            }
          },
        );

        await suite.test(
          'pixel and side limits are inclusive and use proportional 2048 resizing',
          async () => {
            for (const [width, height, outputWidth, outputHeight] of [
              [12000, 1, 2048, 1],
              [5000, 4000, 2048, 1638],
            ]) {
              const bytes = await solidPng(width, height);
              const output = await decoded(
                await target.parse('limit.png', bytes),
                'limit.png',
                bytes,
                'image/png',
              );
              assert.equal(output.result.width, outputWidth);
              assert.equal(output.result.height, outputHeight);
              assert.equal(output.result.originalWidth, width);
              assert.equal(output.result.originalHeight, height);
              assert.deepEqual(output.result.warnings, [resizeWarning]);
            }
            for (const [width, height] of [
              [12001, 1],
              [5001, 4000],
            ]) {
              await assert.rejects(
                target.parse('oversize.png', await solidPng(width, height)),
                rejectedFor(/20 百万像素|pixel limit/i),
              );
            }
          },
        );

        await suite.test(
          '10 MiB image input is accepted and one extra byte is rejected',
          async () => {
            const small = await solidPng(2, 1);
            const bytes = padPng(small, ATTACHMENT_LIMITS.inputBytes);
            assert.equal(bytes.length, ATTACHMENT_LIMITS.inputBytes);
            const output = await decoded(
              await target.parse('padded.png', bytes),
              'padded.png',
              bytes,
              'image/png',
            );
            assert.equal(output.result.width, 2);
            assert.equal(output.result.height, 1);
            await assert.rejects(
              target.parse('padded.png', padPng(small, ATTACHMENT_LIMITS.inputBytes + 1)),
              rejectedFor(/超过 10 MiB/),
            );
          },
        );

        await suite.test(
          'large normalized PNG falls back to 1280 within the output byte limit',
          async () => {
            const bytes = await noisyJpeg();
            assert.ok(bytes.length < ATTACHMENT_LIMITS.inputBytes);
            assert.ok(
              (await sharp(bytes).png().toBuffer()).length > ATTACHMENT_LIMITS.imageOutputBytes,
            );
            const output = await decoded(
              await target.parse('noise.jpg', bytes),
              'noise.jpg',
              bytes,
              'image/jpeg',
            );
            assert.equal(output.result.width, 1280);
            assert.equal(output.result.height, 1280);
            assert.deepEqual(output.result.warnings, [resizeWarning]);
          },
        );

        await suite.test(
          'SVG remains text and cannot enter the raster decoder through a PNG name',
          async () => {
            const bytes = Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>',
            );
            const result = await target.parse('vector.svg', bytes);
            assert.equal(result.kind, 'text');
            assert.ok(result.kind === 'text');
            assert.equal(result.text, bytes.toString());
            await assert.rejects(target.parse('vector.png', bytes), rejectedFor(/PNG 文件头无效/));
          },
        );
      });
    }
  },
);
