import { lazy, Suspense } from 'react';
import { LoadBoundary } from '../../components/LoadBoundary';
import { DEFAULT_AVATAR_THEME } from '../../avatarThemeCatalog';
import { useAppearance } from '../../useAppearance';
import './AccountAvatar.css';

const AvatarArtwork = lazy(() =>
  import('../../components/AvatarArtwork').then(({ AvatarArtwork }) => ({
    default: AvatarArtwork,
  })),
);
const GeneratedAvatarArtwork = lazy(() =>
  import('../../components/GeneratedAvatarArtwork').then(({ GeneratedAvatarArtwork }) => ({
    default: GeneratedAvatarArtwork,
  })),
);

export function AccountAvatar({ size }: { size: number }) {
  const { avatarTheme, customAvatarTheme, useCustomAvatarTheme } = useAppearance();
  const custom = useCustomAvatarTheme ? customAvatarTheme : undefined;
  const style = { width: size, height: size };
  const brand = <span aria-hidden="true" className="avatar account-brand-avatar" style={style} />;
  if (avatarTheme === DEFAULT_AVATAR_THEME && !custom) return brand;
  const character = ['classic', 'colorful'].includes(custom?.motif || avatarTheme);
  const faceMotion = character
    ? { state: 'idle' as const, sustain: false, blinkWhenIdle: true }
    : undefined;
  return (
    <LoadBoundary fallback={brand} resetKey={custom || avatarTheme}>
      <Suspense fallback={brand}>
        <span aria-hidden="true" className="avatar" style={style}>
          {custom ? (
            <GeneratedAvatarArtwork theme={custom} size={size} faceMotion={faceMotion} />
          ) : (
            <AvatarArtwork theme={avatarTheme} size={size} faceMotion={faceMotion} />
          )}
        </span>
      </Suspense>
    </LoadBoundary>
  );
}
