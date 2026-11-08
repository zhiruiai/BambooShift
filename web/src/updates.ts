import { useEffect, useRef, useState } from 'react';
import { version as sourceVersion } from '../../package.json';
import { createPrimaryBotScope } from './primaryBot';
import { uiText } from './i18n';
import { releaseUrl, validReleaseRepository } from './updateVersions';
export { sourceVersion };
export type UpdateStatus =
  'unconfigured' | 'unavailable' | 'current' | 'update_available' | 'unknownVersion';
export type UpdatesState = {
  scope: { userId: string; workspaceId: string };
  repository: string | null;
  serviceVersion: string;
  status: UpdateStatus;
  checkedAt: string | null;
  reason:
    | 'not_checked'
    | 'network'
    | 'timeout'
    | 'rate_limited'
    | 'not_found'
    | 'invalid_release'
    | 'response_too_large'
    | null;
  release: {
    tag: string;
    version: string | null;
    name: string;
    notes: string;
    publishedAt: string;
    url: string;
  } | null;
};
declare global {
  interface Window {
    openbotVersion?: { getVersion(): Promise<string> };
  }
}
export function checkedUpdates(
  value: UpdatesState,
  identity: { userId?: string; workspaceId?: string },
) {
  const validVersion = (version: unknown) =>
    typeof version === 'string' &&
    version.length > 0 &&
    version.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(version);
  const validDate = (date: unknown) =>
    typeof date === 'string' && Number.isFinite(Date.parse(date));
  if (
    !value ||
    value.scope?.userId !== identity.userId ||
    value.scope?.workspaceId !== identity.workspaceId ||
    !validVersion(value.serviceVersion) ||
    !['unconfigured', 'unavailable', 'current', 'update_available', 'unknownVersion'].includes(
      value.status,
    ) ||
    (value.checkedAt !== null && !validDate(value.checkedAt)) ||
    (value.repository !== null &&
      (typeof value.repository !== 'string' || !validReleaseRepository(value.repository))) ||
    (value.reason !== null &&
      ![
        'not_checked',
        'network',
        'timeout',
        'rate_limited',
        'not_found',
        'invalid_release',
        'response_too_large',
      ].includes(value.reason)) ||
    (value.status === 'unconfigured' && (value.repository !== null || value.release !== null)) ||
    (value.release !== null &&
      (!value.repository ||
        typeof value.release?.name !== 'string' ||
        value.release.name.length > 400 ||
        typeof value.release.notes !== 'string' ||
        value.release.notes.length > 64000 ||
        !validDate(value.release.publishedAt) ||
        releaseUrl(value.repository, value.release.tag) !== value.release.url ||
        (value.release.version !== null &&
          value.release.version !== value.release.tag.replace(/^v/, ''))))
  )
    throw Error(uiText('workspace:updatesInvalidResponse'));
  return value;
}
export function useUpdates(props: { userId?: string; workspaceId?: string; active?: boolean }) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({
      ...props,
      identity: () => latest.current,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    }),
  );
  const [state, setState] = useState<{ loading: boolean; data?: UpdatesState; error: string }>({
    loading: false,
    error: '',
  });
  const [desktopVersion, setDesktopVersion] = useState<string>();
  const sequence = useRef(0),
    busy = useRef(false);
  const current = () => scope.current(scope.ticket()) && latest.current.active !== false;
  const desktop = typeof window.openbotVersion?.getVersion === 'function';
  async function read(check = false) {
    if (!current() || busy.current || !props.userId || !props.workspaceId) return;
    const order = ++sequence.current,
      ticket = scope.ticket();
    busy.current = true;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const data = checkedUpdates(
        await scope.request<UpdatesState>(
          '/updates',
          check ? 'POST' : 'GET',
          check ? {} : undefined,
        ),
        props,
      );
      if (current() && scope.current(ticket) && sequence.current === order)
        setState({ loading: false, data, error: '' });
    } catch (cause) {
      if (current() && scope.current(ticket) && sequence.current === order)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: cause instanceof Error ? cause.message : uiText('workspace:updatesFailed'),
        }));
    } finally {
      if (sequence.current === order) busy.current = false;
    }
  }
  useEffect(() => {
    if (props.active !== false) {
      scope.resume();
      void read();
      if (desktop) {
        const ticket = scope.ticket();
        void window
          .openbotVersion!.getVersion()
          .then((value) => {
            if (
              current() &&
              scope.current(ticket) &&
              typeof value === 'string' &&
              value.length <= 128 &&
              !/[\u0000-\u001f\u007f]/.test(value)
            )
              setDesktopVersion(value);
          })
          .catch(() => {});
      }
    }
    return () => {
      sequence.current++;
      busy.current = false;
      scope.suspend();
    };
  }, [scope, props.active, props.userId, props.workspaceId]);
  return {
    ...state,
    desktop,
    desktopVersion,
    sourceVersion,
    available: !!props.userId && !!props.workspaceId,
    check: () => read(true),
    refresh: () => read(false),
    current,
  };
}
