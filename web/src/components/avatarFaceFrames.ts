import { avatarFaceTiming } from './avatarFaceMotion';

// One observer and one frame loop for mounted, visible animated eye layers.
type DrawFrame = (elapsed: number, reduced: boolean) => boolean;
type Face = { draw: DrawFrame; visible: boolean };

function createAvatarFrameDriver() {
  const faces = new Map<Element, Face>();
  const pending = new Set<Face>();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let requestId = 0;
  let previous: number | undefined;

  function schedule() {
    if (requestId || !pending.size || document.hidden) return;
    requestId = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    requestId = 0;
    const elapsed = previous === undefined ? 0 : now - previous;
    if (previous === undefined || elapsed >= 28) {
      previous = now;
      for (const face of pending) {
        if (!face.draw(Math.min(elapsed, avatarFaceTiming.maxFrameDeltaMs), false))
          pending.delete(face);
      }
    }
    if (!pending.size) previous = undefined;
    schedule();
  }

  function request(face: Face) {
    if (!face.visible || document.hidden) return;
    if (reduced?.matches) {
      pending.delete(face);
      face.draw(0, true);
    } else {
      pending.add(face);
      schedule();
    }
  }

  function refresh() {
    cancelAnimationFrame(requestId);
    requestId = 0;
    previous = undefined;
    pending.clear();
    for (const face of faces.values()) request(face);
  }

  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const face = faces.get(entry.target);
              if (!face) continue;
              face.visible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
              if (face.visible) request(face);
              else pending.delete(face);
            }
          },
          { threshold: 0.25 },
        );
  document.addEventListener('visibilitychange', refresh);
  reduced?.addEventListener('change', refresh);

  return {
    watch(element: Element, draw: DrawFrame) {
      const face = { draw, visible: !observer };
      faces.set(element, face);
      observer?.observe(element);
      if (reduced?.matches) draw(0, true);
      return {
        request: () => request(face),
        dispose() {
          observer?.unobserve(element);
          faces.delete(element);
          pending.delete(face);
          if (faces.size) return;
          observer?.disconnect();
          document.removeEventListener('visibilitychange', refresh);
          reduced?.removeEventListener('change', refresh);
          cancelAnimationFrame(requestId);
          driver = undefined;
        },
      };
    },
  };
}

let driver: ReturnType<typeof createAvatarFrameDriver> | undefined;

export function watchAvatarFace(element: Element, draw: DrawFrame) {
  driver ??= createAvatarFrameDriver();
  return driver.watch(element, draw);
}
