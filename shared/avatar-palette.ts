import palette from './avatar-palette.json';

export const AVATAR_PALETTE = palette;
export const AVATAR_COLORS: readonly string[] = palette.colors;
export const AVATAR_ROLE_COLORS = palette.roles;

/** Derive bundled-vector fills without changing stored profiles or uploaded images. */
export function displayAvatarColor(value: unknown, fallback = palette.defaultColor): string {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) return fallback;
  const hex = value.toLowerCase();
  const legacy = palette.legacy[hex as keyof typeof palette.legacy];
  if (legacy) return legacy;
  const [red, green, blue] = [1, 3, 5].map(
    (start) => parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const high = Math.max(red, green, blue),
    low = Math.min(red, green, blue);
  const range = high - low;
  const saturation = high === 0 ? 0 : range / high;
  if (high >= palette.purple.minBrightness && saturation >= palette.purple.minSaturation) {
    const sector =
      high === red
        ? (green - blue) / range
        : high === green
          ? (blue - red) / range + 2
          : (red - green) / range + 4;
    const hue = (sector * 60 + 360) % 360;
    if (hue >= palette.purple.minHue && hue <= palette.purple.maxHue) return palette.defaultColor;
  }
  return value;
}
