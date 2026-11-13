import type { GeneratedAvatarTheme } from '../creationPreview';
import { AvatarArtwork } from './AvatarArtwork';
import type { AvatarFaceMotion } from './avatarFaceMotion';

const badgePaths = {
  star: 'M12 2L15 8L22 9L17 14L18 21L12 18L6 21L7 14L2 9L9 8Z',
  flower: 'M12 8C6 0 1 7 7 12C0 17 7 23 12 17C17 23 24 17 17 12C23 7 18 0 12 8Z',
  moon: 'M19 17A9 9 0 1 1 10 3A8 8 0 0 0 19 17Z',
  bolt: 'M14 2L4 14H10L9 22L20 9H14Z',
};

export function GeneratedAvatarArtwork({
  theme,
  shape,
  size = 38,
  faceMotion,
}: {
  theme: GeneratedAvatarTheme;
  shape?: string;
  size?: number;
  faceMotion?: AvatarFaceMotion;
}) {
  const index = ['drop', 'gem'].includes(shape || '')
    ? 1
    : ['leaf', 'arch'].includes(shape || '')
      ? 2
      : 0;
  const color = theme.colors[index];
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      {theme.backdrop !== 'plain' && (
        <circle
          cx="32"
          cy="32"
          r="30"
          fill={theme.backdrop === 'solid' ? color : 'none'}
          fillOpacity=".23"
          stroke={color}
          strokeOpacity=".55"
          strokeWidth="2"
        />
      )}
      <g transform={theme.backdrop === 'plain' ? undefined : 'translate(4 4) scale(.875)'}>
        <AvatarArtwork
          theme={theme.motif}
          shape={shape}
          size={64}
          color={color}
          faceMotion={faceMotion}
        />
      </g>
      {theme.badge !== 'none' && (
        <g transform="translate(43 42) scale(.75)">
          <circle cx="12" cy="12" r="13" fill="#29253a" stroke="#fff" strokeWidth="2" />
          <path d={badgePaths[theme.badge]} fill="#fff" />
        </g>
      )}
    </svg>
  );
}
