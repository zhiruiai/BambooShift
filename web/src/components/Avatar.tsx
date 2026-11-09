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

export type AvatarMotion = 'idle' | 'working' | 'attention' | 'done' | 'preview';

export function Avatar({
  agent,
  size = 38,
  className = '',
  motion,
  userId,
}: {
  agent?: Partial<BotAgent>;
  size?: number;
  className?: string;
  motion?: AvatarMotion;
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
    if (previous === motion) return;
    previousMotion.current = motion;
    if (
      motion === 'done' &&
      previous === 'working' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setJustFinished(true);
    } else if (previous === 'done') {
      setJustFinished(false);
    }
  }, [motion]);
  const effect =
    image || sharedPath || agent?.avatarImageId
      ? undefined
      : motion === 'done'
        ? justFinished
          ? 'done'
          : undefined
        : motion;
  return (
    <span
      className={`avatar ${className}`}
      data-avatar-motion={effect}
      onAnimationEnd={effect === 'done' ? () => setJustFinished(false) : undefined}
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
  idle = false,
}: {
  agents: BotAgent[];
  size?: number;
  idle?: boolean;
}) {
  return (
    <span className="group-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {agents.slice(0, 3).map((a, i) => (
        <Avatar
          key={a.id}
          agent={a}
          size={size * 0.62}
          className={`group-avatar-${i}`}
          motion={idle && i === 0 ? 'idle' : undefined}
        />
      ))}
    </span>
  );
}
