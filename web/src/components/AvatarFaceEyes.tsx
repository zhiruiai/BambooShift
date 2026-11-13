import { useId, useLayoutEffect, useRef } from 'react';
import type { AvatarShape, AvatarTheme } from '../avatarThemes';
import { watchAvatarFace } from './avatarFaceFrames';
import {
  avatarEyeFrame,
  avatarFaceGeometry,
  createAvatarEyeMotion,
  avatarEyePose,
  type AvatarFaceMotion,
} from './avatarFaceMotion';

function writeAttribute(node: Element, name: string, value: string | number) {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

export function AvatarFaceEyes({
  theme,
  shape,
  motion,
}: {
  theme: AvatarTheme;
  shape: AvatarShape;
  motion: AvatarFaceMotion;
}) {
  const id = useId();
  const group = useRef<SVGGElement>(null);
  const control = useRef<{
    animation: ReturnType<typeof createAvatarEyeMotion>;
    request: () => void;
  }>(null);
  const initial = useRef(motion.state);
  const current = useRef(motion);
  current.current = motion;
  const animated = motion.animate !== false;
  const initialPose = avatarEyePose(animated ? initial.current : motion.state);
  const spec = avatarFaceGeometry[theme];

  useLayoutEffect(() => {
    const element = group.current;
    if (!element || !animated) return;
    const eyes = element.querySelectorAll<SVGPathElement>('[data-avatar-eye]');
    const pupils = element.querySelectorAll<SVGRectElement>('[data-avatar-pupil]');
    const animation = createAvatarEyeMotion(current.current, (pose) => {
      eyes.forEach((eye, index) => {
        const { d, pupil } = avatarEyeFrame(theme, shape, index, pose);
        writeAttribute(eye, 'd', d);
        if (!pupil) return;
        writeAttribute(pupils[index], 'x', pupil.x);
        writeAttribute(pupils[index], 'y', pupil.y);
        writeAttribute(pupils[index], 'opacity', pupil.opacity);
      });
    });
    animation.frame(0, true);
    const watched = watchAvatarFace(element, animation.frame);
    control.current = { animation, request: watched.request };
    watched.request();
    return () => {
      control.current = null;
      watched.dispose();
    };
  }, [theme, shape, animated]);

  useLayoutEffect(() => {
    control.current?.animation.set({ state: motion.state, sustain: motion.sustain });
    control.current?.request();
  }, [motion.state, motion.sustain]);

  return (
    <g ref={group} data-avatar-expression={motion.state}>
      {spec.eyes.map((_, index) => {
        const { d, pupil } = avatarEyeFrame(theme, shape, index, initialPose);
        const eyeId = `${id}-eye-${index}`;
        return (
          <g key={eyeId}>
            <path id={eyeId} data-avatar-eye="" d={d} fill={spec.paper} />
            {pupil && (
              <>
                <clipPath id={`${eyeId}-clip`}>
                  <use href={`#${eyeId}`} />
                </clipPath>
                <rect
                  data-avatar-pupil=""
                  {...pupil}
                  rx={pupil.width / 2}
                  fill={spec.ink}
                  clipPath={`url(#${eyeId}-clip)`}
                />
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}
