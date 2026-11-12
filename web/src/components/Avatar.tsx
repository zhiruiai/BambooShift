import { uiText } from '../i18n';
import type { BotAgent } from '../../../shared/types';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../shared/shared-bots';
import { sharedAvatarPath } from '../sharedBots';
import { useAccount } from '../AccountContext';
import { avatarImageUrl } from '../avatarImages';
import { currentWorkspaceId } from '../workspace-scope';
import './AvatarPicker.css';
import { useAvatarAppearance } from '../avatarAppearance';
import { AvatarArtwork } from './AvatarArtwork';
import { GeneratedAvatarArtwork } from './GeneratedAvatarArtwork';

export type AvatarMotion =
  'idle' | 'thinking' | 'working' | 'attention' | 'done' | 'error' | 'preview';

const runningMotion = (motion: AvatarMotion | undefined) =>
  motion === 'thinking' || motion === 'working';

const terminalMotion = (motion: AvatarMotion | undefined) =>
  motion === 'done' || motion === 'error';

export function Avatar({
  agent,
  size = 38,
  className = '',
  motion,
  awaitingCompletion = false,
  sustain = false,
  userId,
}: {
  agent?: Partial<BotAgent>;
  size?: number;
  className?: string;
  motion?: AvatarMotion;
  awaitingCompletion?: boolean;
  sustain?: boolean;
  userId?: string;
}) {
  const account = useAccount();
  const { avatarTheme, customAvatarTheme, useCustomAvatarTheme } = useAvatarAppearance();
  const actor = userId || account?.session.user?.id;
  const sharedPath = isSharedBot(agent)
    ? sharedAvatarPath(agent?.sharedBot?.avatarPath)
    : undefined;
  const sharedKey = `${actor || ''}:${sharedPath || ''}`;
  const latest = useRef(sharedKey);
  latest.current = sharedKey;
  const [sharedImage, setSharedImage] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (!sharedPath || !actor) return;
    const controller = new AbortController(),
      pathname = typeof window === 'undefined' ? '' : window.location.pathname;
    let active = true,
      objectUrl: string | undefined;
    void fetch(sharedPath, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'X-OpenBot-Expected-User': actor },
    })
      .then(async (response) => {
        if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'image/webp')
          throw new Error(uiText('common:text_32d0249999d1'));
        const blob = await response.blob();
        if (blob.size > 2 * 1024 * 1024) throw new Error(uiText('common:text_32d0249999d1'));
        if (
          !active ||
          latest.current !== sharedKey ||
          (typeof window === 'undefined' ? '' : window.location.pathname) !== pathname
        )
          return;
        objectUrl = URL.createObjectURL(blob);
        setSharedImage({ key: sharedKey, url: objectUrl });
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sharedPath, actor]);
  const url = isSharedBot(agent)
    ? sharedImage?.key === sharedKey
      ? sharedImage.url
      : undefined
    : avatarImageUrl(agent?.avatarImageId, account?.workspace.id || currentWorkspaceId());
  const [failed, setFailed] = useState<string>();
  const image = url && failed !== url;
  const shape = agent?.avatar || 'orb';
  const previousMotion = useRef(motion);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    const previous = previousMotion.current;
    // Text can stop streaming before the same message becomes terminal.
    if (previous === motion || (awaitingCompletion && motion === undefined)) return;
    previousMotion.current = motion;
    if (
      terminalMotion(motion) &&
      (runningMotion(previous) || previous === 'attention') &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setJustFinished(true);
    } else if (terminalMotion(previous)) {
      setJustFinished(false);
    }
  }, [motion, awaitingCompletion]);
  const effect =
    image || sharedPath || agent?.avatarImageId
      ? undefined
      : terminalMotion(motion)
        ? justFinished
          ? motion
          : undefined
        : motion;
  const element = useRef<HTMLSpanElement>(null);
  const sustained = sustain && runningMotion(effect);
  useEffect(() => {
    const target = element.current;
    if (!sustained || !target) return;
    let visible = typeof IntersectionObserver === 'undefined';
    const update = () => {
      target.dataset.avatarVisible = String(visible && !document.hidden);
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(
            ([entry]) => {
              visible = entry?.isIntersecting === true && entry.intersectionRatio >= 0.25;
              update();
            },
            { threshold: 0.25 },
          );
    observer?.observe(target);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      delete target.dataset.avatarVisible;
    };
  }, [sustained]);
  return (
    <span
      ref={element}
      className={`avatar ${className}`}
      data-avatar-motion={effect}
      data-avatar-sustained={sustained ? '' : undefined}
      onAnimationEnd={terminalMotion(effect) ? () => setJustFinished(false) : undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {image ? (
        <img
          key={url}
          className="avatar-image"
          src={url}
          width={size}
          height={size}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(url)}
        />
      ) : useCustomAvatarTheme && customAvatarTheme ? (
        <GeneratedAvatarArtwork theme={customAvatarTheme} shape={shape} size={size} />
      ) : (
        <AvatarArtwork theme={avatarTheme} shape={shape} color={agent?.color} size={size} />
      )}
    </span>
  );
}
export function GroupAvatar({
  agents,
  size = 40,
  motion,
  sustain = false,
}: {
  agents: BotAgent[];
  size?: number;
  motion?: AvatarMotion;
  sustain?: boolean;
}) {
  return (
    <span className="group-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {agents.slice(0, 3).map((a, i) => (
        <Avatar
          key={a.id}
          agent={a}
          size={size * 0.62}
          className={`group-avatar-${i}`}
          motion={i === 0 ? motion : undefined}
          sustain={sustain && i === 0}
        />
      ))}
    </span>
  );
}
