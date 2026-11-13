import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import type { AvatarShape, AvatarTheme, CommunityAvatarTheme } from '../avatarThemes';
import type { AvatarFaceMotion } from './avatarFaceMotion';
import { watchAvatarFace } from './avatarFaceFrames';
import { communityAvatar, createCommunityMotion, ringPath } from './communityAvatarMotion';

export function CommunityAvatarArtwork({
  theme,
  displayTheme = theme,
  shape,
  color,
  size,
  motion = { state: 'idle', sustain: false, animate: false },
}: {
  theme: CommunityAvatarTheme;
  displayTheme?: AvatarTheme;
  shape: AvatarShape;
  color: string;
  size: number;
  motion?: AvatarFaceMotion;
}) {
  const clipId = useId();
  const avatar = useMemo(() => communityAvatar(theme), [theme]);
  const group = useRef<SVGGElement>(null);
  const initial = useRef(motion.state);
  const latest = useRef(motion);
  latest.current = motion;
  const animated = motion.animate !== false;
  const control = useRef<{
    animation: ReturnType<typeof createCommunityMotion>;
    request: () => void;
  }>(null);
  useLayoutEffect(() => {
    const element = group.current;
    if (!element || !animated) return;
    const eyes = element.querySelectorAll('[data-avatar-eye]');
    const animation = createCommunityMotion(avatar, latest.current, (rings) =>
      rings.forEach((ring, index) => {
        const path = ringPath(ring);
        if (eyes[index].getAttribute('d') !== path) eyes[index].setAttribute('d', path);
      }),
    );
    animation.frame(0, true);
    const watched = watchAvatarFace(element, animation.frame);
    control.current = { animation, request: watched.request };
    watched.request();
    return () => {
      control.current = null;
      watched.dispose();
    };
  }, [avatar, animated]);
  useLayoutEffect(() => {
    control.current?.animation.set(motion);
    control.current?.request();
  }, [motion.state, motion.sustain, motion.blinkWhenIdle]);
  const rings = avatar.pose(animated ? initial.current : motion.state);
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      data-avatar-theme={displayTheme}
      data-avatar-source-theme={theme}
      data-avatar-shape={shape}
      data-avatar-pack={avatar.packId}
      aria-hidden="true"
      focusable="false"
    >
      <path
        className={displayTheme === 'classic' ? 'avatar-classic-body' : undefined}
        d={avatar.shape.body.path}
        fill={color}
        fillRule={avatar.shape.body.fillRule as 'evenodd' | 'nonzero'}
      />
      <defs>
        <clipPath id={clipId}>
          <path
            d={avatar.shape.body.path}
            clipRule={avatar.shape.body.fillRule as 'evenodd' | 'nonzero'}
          />
        </clipPath>
      </defs>
      <g
        clipPath={`url(#${clipId})`}
        ref={group}
        data-avatar-expression={motion.state}
        fill={avatar.eyeColor}
      >
        {rings.map((ring, index) => (
          <path key={index} data-avatar-eye="" d={ringPath(ring)} />
        ))}
      </g>
    </svg>
  );
}
