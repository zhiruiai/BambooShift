import face from '../../../shared/avatar-face-motion.json';
import type { AvatarShape, OriginalAvatarTheme } from '../avatarThemes';

export type AvatarFaceState = keyof typeof face.poses;
export type AvatarFaceMotion = {
  state: AvatarFaceState;
  sustain: boolean;
  animate?: boolean;
};
type EyePose = Omit<(typeof face.poses)['idle'], 'duration'>;

export const avatarFaceGeometry = face.themes;
export const avatarFaceTiming = face.motion;
export const avatarEyePose = (state: AvatarFaceState): EyePose => face.poses[state];

export function avatarEyeTilt(theme: OriginalAvatarTheme, shape: AvatarShape) {
  if (!avatarFaceGeometry[theme].shapeTilt) return undefined;
  const tilt = shape === 'leaf' ? -8 : shape === 'gem' ? 7 : 0;
  return `rotate(${tilt} 32 31)`;
}

function precision(value: number) {
  return Math.round(value * 100) / 100;
}

export function avatarEyeFrame(
  theme: OriginalAvatarTheme,
  shape: AvatarShape,
  index: number,
  pose: EyePose,
) {
  const spec = avatarFaceGeometry[theme];
  const [centerX, centerY, width, height] = spec.eyes[index];
  const x = centerX + (spec.pupil ? 0 : pose.gazeX * 0.36);
  const y = centerY + (spec.pupil ? 0 : pose.gazeY * 0.36);
  const w = width * pose.width;
  const h = height / 2;
  const tilt = pose.tilt * (index === 0 ? 1 : -1);
  const point = (horizontal: number, vertical: number) =>
    `${precision(x + horizontal * w)} ${precision(y + vertical * h)}`;
  const start = point(-0.5, pose.side - tilt);
  const end = point(0.5, pose.side + tilt);
  const d = `M${start}C${point(-0.42, pose.top - tilt)} ${point(0.42, pose.top + tilt)} ${end}C${point(0.42, pose.bottom + tilt)} ${point(-0.42, pose.bottom - tilt)} ${start}Z`;
  if (!spec.pupil) return { d };
  const [pupilWidth, pupilHeight] = spec.pupil;
  const offset = spec.pupilOffsetX[index] - Number(spec.shapeTilt && shape === 'drop');
  const bound = (w - pupilWidth) / 2 - 0.35;
  const pupilX = Math.max(-bound, Math.min(bound, offset + pose.gazeX));
  return {
    d,
    pupil: {
      x: precision(x + pupilX - pupilWidth / 2),
      y: precision(y + spec.pupilOffsetY + pose.gazeY - pupilHeight / 2),
      width: pupilWidth,
      height: pupilHeight,
      opacity: precision(pose.pupilOpacity),
    },
  };
}

// Eye-pose interpolation adapted from BoopFace (MIT, © 2026 CX ART Lab),
// 24ee5f698e58fa4f131b5ae7827373814e191f4c: src/boopface-core.js.
// Gaze smoothing follows embedded/lib/BoopFace/src/BoopFaceGaze.h at the same revision.
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function createAvatarEyeMotion(initial: AvatarFaceMotion, paint: (pose: EyePose) => void) {
  let motion = initial;
  let current = avatarEyePose(initial.state);
  let from = current;
  let elapsed = face.poses[initial.state].duration;

  return {
    set(next: AvatarFaceMotion) {
      if (motion.state === next.state && motion.sustain === next.sustain) return;
      motion = next;
      from = current;
      elapsed = 0;
    },
    frame(dt: number, reduced: boolean) {
      const target = face.poses[motion.state];
      if (reduced) {
        current = target;
        from = target;
        elapsed = target.duration;
        paint(current);
        return false;
      }
      elapsed += dt;
      const { easingPower, workingPeriodMs, workingGazeAmplitude, gazeSmoothingMs } = face.motion;
      const progress = Math.min(1, elapsed / target.duration);
      const eased = 1 - (1 - progress) ** easingPower;
      const sustain = motion.sustain && motion.state === 'working';
      const gaze =
        target.gazeX +
        (sustain ? Math.sin((elapsed * 2 * Math.PI) / workingPeriodMs) * workingGazeAmplitude : 0);
      const gazeX = lerp(current.gazeX, gaze, dt / (gazeSmoothingMs + dt));
      const gazeY = lerp(current.gazeY, target.gazeY, dt / (gazeSmoothingMs + dt));
      const moving = Math.abs(gazeX - gaze) > 0.025 || Math.abs(gazeY - target.gazeY) > 0.025;
      current =
        !sustain && progress === 1 && !moving
          ? target
          : {
              width: lerp(from.width, target.width, eased),
              top: lerp(from.top, target.top, eased),
              bottom: lerp(from.bottom, target.bottom, eased),
              side: lerp(from.side, target.side, eased),
              tilt: lerp(from.tilt, target.tilt, eased),
              gazeX,
              gazeY,
              pupilOpacity: lerp(from.pupilOpacity, target.pupilOpacity, eased),
            };
      paint(current);
      return sustain || progress < 1 || moving;
    },
  };
}
