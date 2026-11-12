import type { DesktopCapture, DesktopInput } from './desktop.js';
import type { CuaResult } from './cua-connection.js';

export interface CuaGeometry {
  width: number;
  height: number;
  scale: number;
}
export interface CuaFrame extends CuaGeometry {
  captureId: string;
  imageWidth: number;
  imageHeight: number;
  capturedAt: number;
}
const bounded = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
export function cuaGeometry(result: CuaResult): CuaGeometry {
  const data = result.structuredContent;
  if (
    result.isError ||
    !data ||
    !bounded(data.width, 32_768) ||
    !bounded(data.height, 32_768) ||
    !bounded(data.scale_factor, 8)
  )
    throw new Error('无法读取主屏幕尺寸。');
  return { width: data.width, height: data.height, scale: data.scale_factor };
}
export function sameCuaGeometry(a: CuaGeometry, b: CuaGeometry) {
  return a.width === b.width && a.height === b.height && a.scale === b.scale;
}
export function cuaImageSize(geometry: CuaGeometry) {
  const scale = Math.min(1, 1600 / geometry.width, 1000 / geometry.height);
  return {
    width: Math.max(1, Math.floor(geometry.width * scale)),
    height: Math.max(1, Math.floor(geometry.height * scale)),
  };
}
export function cuaCapture(
  result: CuaResult,
  geometry: CuaGeometry,
): {
  frame: CuaFrame;
  capture: DesktopCapture;
} {
  const data = result.structuredContent;
  const images = result.content?.filter((item) => item.type === 'image') ?? [];
  const image = images[0];
  if (
    result.isError ||
    !data ||
    data.platform !== 'macos' ||
    data.display !== 'primary' ||
    data.screen_width !== geometry.width ||
    data.screen_height !== geometry.height ||
    data.scale_factor !== geometry.scale ||
    !bounded(data.screenshot_width, 1600) ||
    !bounded(data.screenshot_height, 1000) ||
    typeof data.capture_id !== 'string' ||
    !data.capture_id.length ||
    data.capture_id.length > 512 ||
    images.length !== 1 ||
    image.mimeType !== 'image/png' ||
    typeof image.data !== 'string' ||
    image.data.length > 12 * 1024 * 1024
  )
    throw new Error('桌面截图或主屏幕尺寸已变化，请重新截图。');
  const png = Buffer.from(image.data, 'base64');
  if (
    png.length < 24 ||
    png.length > 8 * 1024 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== data.screenshot_width ||
    png.readUInt32BE(20) !== data.screenshot_height
  )
    throw new Error('桌面截图格式或尺寸无效。');
  const capturedAt = Date.now();
  return {
    frame: {
      ...geometry,
      captureId: data.capture_id,
      imageWidth: data.screenshot_width,
      imageHeight: data.screenshot_height,
      capturedAt,
    },
    capture: {
      png,
      width: data.screenshot_width,
      height: data.screenshot_height,
      capturedAt: new Date(capturedAt).toISOString(),
    },
  };
}

const target = { kind: 'desktop', display_id: 'primary' };
const modifiers: Record<string, string> = {
  controlormeta: 'cmd',
  meta: 'cmd',
  command: 'cmd',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};
export function cuaActions(input: DesktopInput, frame: CuaFrame) {
  const action = (name: string, args: Record<string, unknown>) => ({
    name,
    args: { target, ...args },
  });
  const x = (value: number) => (value * frame.width * frame.scale) / frame.imageWidth;
  const y = (value: number) => (value * frame.height * frame.scale) / frame.imageHeight;
  switch (input.type) {
    case 'click':
      return [
        action('click', {
          x: input.x,
          y: input.y,
          capture_id: frame.captureId,
          delivery_mode: 'foreground',
          button: input.button ?? 'left',
          count: input.clickCount ?? 1,
        }),
      ];
    // Cua 0.47.8 drag/scroll consume full native pixels, unlike capture-bound click.
    case 'drag':
      return [
        action('drag', {
          from_x: x(input.x),
          from_y: y(input.y),
          to_x: x(input.toX),
          to_y: y(input.toY),
          duration_ms: input.durationMs ?? 500,
        }),
      ];
    case 'type':
      if (/[\uD800-\uDFFF]/u.test(input.text))
        throw new Error('输入文字包含不完整的 Unicode 字符。');
      return [action('type_text', { text: input.text })];
    case 'key': {
      const parts = input.key.toLowerCase().split('+');
      const key = parts.pop()!;
      const mapped = parts.map((part) => modifiers[part]);
      if (new Set(mapped).size !== mapped.length) throw new Error('组合键包含重复的修饰键。');
      // macOS's "delete" is backspace; our shared Delete means forward-delete.
      return [
        action('press_key', { key: key === 'delete' ? 'forward_delete' : key, modifiers: mapped }),
      ];
    }
    case 'scroll':
      // Native Cua scrolling is in notches (120 px per line on macOS), not exact pixels.
      return [
        { delta: input.deltaY, positive: 'down', negative: 'up' },
        { delta: input.deltaX ?? 0, positive: 'right', negative: 'left' },
      ]
        .filter(({ delta }) => delta !== 0)
        .map(({ delta, positive, negative }) =>
          action('scroll', {
            x: x(frame.imageWidth / 2),
            y: y(frame.imageHeight / 2),
            direction: delta > 0 ? positive : negative,
            by: 'line',
            amount: Math.max(1, Math.round(Math.abs(delta) / 120)),
          }),
        );
  }
}

/** A tool completed delivery; visual effects are verified by the next screenshot. */
export function cuaInputOutcome(
  result: CuaResult,
): 'completed' | 'refused' | 'incomplete' | 'unknown' {
  const data = result.structuredContent;
  if (!data) return 'unknown';
  if ((data.effect === 'refused' || data.status === 'refused') && !data.delivery) return 'refused';
  if (result.isError) return 'unknown';
  if (data.effect === 'confirmed' || data.effect === 'unverifiable') return 'completed';
  if (data.effect === 'partial' || data.effect === 'suspected_noop') return 'incomplete';
  return 'unknown';
}
