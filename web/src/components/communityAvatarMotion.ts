import openManifest from '../../../shared/avatar-packs/open-avatar/manifest.json';
import openExpressions from '../../../shared/avatar-packs/open-avatar/expressions.json';
import grokManifest from '../../../shared/avatar-packs/grokbot/manifest.json';
import grokExpressions from '../../../shared/avatar-packs/grokbot/expressions.json';
import type { CommunityAvatarTheme } from '../avatarThemes';
import type { AvatarFaceMotion, AvatarFaceState } from './avatarFaceMotion';

type Point = number[];
export type EyeRings = Point[][];
type Shape = {
  body: { path: string; fillRule: string };
  eyeTransform: number[];
  eyeScale: number;
  expressions?: Record<string, string>;
};
type Pack = {
  eyeColor: string;
  shapes: Record<string, Shape>;
  states: Record<
    string,
    { expressions?: string[]; expressionCadenceMs?: number[]; blinkCadenceMs?: number[] | null }
  >;
  motion: {
    gazeMax: number[];
    blinkDurationMs: number;
    transitionMs?: number;
    blinkSlotMs?: number;
  };
};
const packs = {
  'open-avatar': {
    manifest: openManifest as unknown as Pack,
    expressions: openExpressions as Record<string, EyeRings>,
  },
  grokbot: {
    manifest: grokManifest as unknown as Pack,
    expressions: grokExpressions as Record<string, EyeRings>,
  },
};
const taskStates: Record<AvatarFaceState, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  attention: 'alerting',
  done: 'celebrate',
  error: 'sad',
};
export function communityAvatar(theme: CommunityAvatarTheme) {
  const packId = theme.startsWith('open-avatar-') ? 'open-avatar' : 'grokbot';
  const pack = packs[packId];
  const shape = pack.manifest.shapes[theme.slice(packId.length + 1)];
  const expressions = new Map<string, EyeRings>();
  function pose(state: AvatarFaceState, index = 0) {
    const source =
      packId === 'open-avatar'
        ? shape.expressions![state === 'done' ? 'happy' : state === 'idle' ? 'idle' : 'thinking']
        : pack.manifest.states[taskStates[state]].expressions![
            index % pack.manifest.states[taskStates[state]].expressions!.length
          ];
    if (!expressions.has(source)) {
      const [a, b, c, d, e, f] = shape.eyeTransform;
      const transformed = pack.expressions[source].map((ring) => {
        const points = ring.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
        const center = points.reduce(
          ([x, y], p) => [x + p[0] / points.length, y + p[1] / points.length],
          [0, 0],
        );
        return points.map(([x, y]) => [
          center[0] + (x - center[0]) * shape.eyeScale,
          center[1] + (y - center[1]) * shape.eyeScale,
        ]);
      });
      expressions.set(source, transformed);
    }
    return expressions.get(source)!;
  }
  return {
    packId,
    shape,
    eyeColor: pack.manifest.eyeColor,
    pose,
    cadence(state: AvatarFaceState) {
      const times = pack.manifest.states[taskStates[state]]?.expressionCadenceMs;
      return times ? (times[0] + times[1]) / 2 : 2800;
    },
    gazeMax: pack.manifest.motion.gazeMax,
    blinkDuration: pack.manifest.motion.blinkDurationMs,
    transitionMs: pack.manifest.motion.transitionMs ?? 420,
    blinkSlot(state: AvatarFaceState) {
      const cadence = pack.manifest.states[taskStates[state]]?.blinkCadenceMs;
      return pack.manifest.motion.blinkSlotMs ?? (cadence ? (cadence[0] + cadence[1]) / 2 : 4200);
    },
  };
}
export type CommunityAvatar = ReturnType<typeof communityAvatar>;
export function ringPath(ring: Point[]) {
  return `${ring.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`).join('')}Z`;
}
const mix = (a: EyeRings, b: EyeRings, t: number): EyeRings =>
  t === 0
    ? a
    : t === 1
      ? b
      : a.map((ring, eye) =>
          ring.map((p, point) => p.map((value, axis) => value + (b[eye][point][axis] - value) * t)),
        );

/** Native 48-point rings share the product's single visibility-aware animation clock. */
export function createCommunityMotion(
  avatar: CommunityAvatar,
  initial: AvatarFaceMotion,
  paint: (rings: EyeRings) => void,
) {
  let motion = initial;
  let base = avatar.pose(initial.state),
    from = base,
    target = base,
    painted = base;
  let transition = avatar.transitionMs,
    elapsed = 0,
    expression = 0;
  return {
    set(next: AvatarFaceMotion) {
      if (next.state === motion.state && next.sustain === motion.sustain) return;
      motion = next;
      // Retarget from the visible blink/gaze pose, not the unmodified eye rings.
      from = painted;
      target = avatar.pose(next.state);
      transition = 0;
      elapsed = 0;
      expression = 0;
    },
    frame(dt: number, reduced: boolean) {
      if (reduced) {
        base = target = avatar.pose(motion.state);
        from = base;
        transition = avatar.transitionMs;
        elapsed = 0;
        painted = base;
        paint(painted);
        return false;
      }
      elapsed += dt;
      const sustaining = motion.sustain && !['done', 'error'].includes(motion.state);
      const nextExpression = sustaining ? Math.floor(elapsed / avatar.cadence(motion.state)) : 0;
      if (nextExpression !== expression) {
        expression = nextExpression;
        from = base;
        target = avatar.pose(motion.state, expression);
        transition = 0;
      }
      transition = Math.min(avatar.transitionMs, transition + dt);
      base = mix(from, target, 1 - (1 - transition / avatar.transitionMs) ** 5);
      const blinkSlot = avatar.blinkSlot(motion.state);
      const blinkTime = elapsed % blinkSlot;
      const blink =
        sustaining && blinkTime > blinkSlot - avatar.blinkDuration
          ? 1 -
            0.96 *
              Math.sin(
                (Math.PI * (blinkTime - blinkSlot + avatar.blinkDuration)) / avatar.blinkDuration,
              )
          : 1;
      const gaze = sustaining && motion.state !== 'idle' ? Math.sin(elapsed / 650) : 0;
      // Expression cycling uses base rings so blink/gaze are applied exactly once.
      painted =
        blink === 1 && gaze === 0
          ? base
          : base.map((ring) => {
              const centerY = ring.reduce((sum, point) => sum + point[1] / ring.length, 0);
              return ring.map(([x, y]) => [
                x + gaze * avatar.gazeMax[0] * 0.28,
                centerY + (y - centerY) * blink,
              ]);
            });
      paint(painted);
      return sustaining || transition < avatar.transitionMs;
    },
  };
}
