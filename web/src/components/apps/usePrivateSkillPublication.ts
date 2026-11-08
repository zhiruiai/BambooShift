import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PrivateSkillPublicationTeam } from '../../../../shared/team-skills';
import { ApiError } from '../../api';
import type { createAppConnectionScope } from '../../appConnections';
import { uiText } from '../../i18n';
import { privateSkillKey, type PrivateSkill } from '../../privateSkills';
import {
  parsePublicationResult,
  parsePublicationTeams,
  publicationPath,
  publicationRecoveryKey,
  recoverPublicationIntent,
  type PrivateSkillPublicationIntent as Intent,
  type PrivateSkillPublicationResult,
} from '../../privateSkillPublications';

type Review = { key: string; teamId: string; teams?: PrivateSkillPublicationTeam[] };
type Feedback = { tone: 'error' | 'status'; text: string };
type Decision = 'submit' | 'retry' | 'check' | 'cancel';
const conflictCodes = new Set([
  'TEAM_SKILL_SOURCE_CHANGED',
  'TEAM_SKILL_REVISION',
  'TEAM_SKILL_REQUEST_CONFLICT',
  'TEAM_SKILL_CAPACITY',
  'TEAM_SKILL_POLICY_CHANGED',
  'TEAM_SKILL_MODERATED',
  'TEAM_SKILL_TEMPLATE_SOURCE',
]);
const eligible = (skill?: PrivateSkill): skill is PrivateSkill =>
  !!skill?.available && !!skill.description.trim();

function publicationError(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.code === 'TEAM_SKILL_SOURCE_CHANGED')
      return uiText('apps:privateSkillPublicationSourceChanged');
    if (cause.code === 'TEAM_SKILL_CAPACITY') return uiText('common:teamSkillCapacity');
    if (cause.code === 'TEAM_SKILL_POLICY_CHANGED')
      return uiText('apps:privateSkillPublicationPolicyChanged');
    if (cause.code === 'TEAM_SKILL_MODERATED')
      return uiText('apps:privateSkillPublicationModerated');
    if (cause.code === 'TEAM_SKILL_TEMPLATE_SOURCE')
      return uiText('common:teamSkillTemplateSource');
    if (cause.status === 401 || cause.status === 403)
      return uiText('apps:privateSkillPublicationAccess');
    if (conflictCodes.has(cause.code || '')) return uiText('apps:privateSkillPublicationChanged');
  }
  return uiText('apps:privateSkillPublicationReadFailed');
}

export function usePrivateSkillPublication(options: {
  scope: ReturnType<typeof createAppConnectionScope>;
  workspaceId?: string;
  userId?: string;
  skill?: PrivateSkill;
  busyRef: RefObject<boolean>;
  isShelfBusy: () => boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged?: () => void;
}) {
  const { scope, workspaceId, userId, busyRef } = options;
  const latest = useRef(options);
  latest.current = options;
  const storageKey =
    workspaceId && userId && typeof window !== 'undefined'
      ? publicationRecoveryKey(window.location.origin, userId, workspaceId)
      : '';
  const [review, setReview] = useState<Review>();
  const [pending, setPending] = useState<Intent>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [dismissible, setDismissible] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const mounted = useRef(false);
  const readyRef = useRef(false);
  const pendingRef = useRef<Intent | undefined>(undefined);
  const reviewRef = useRef<Review | undefined>(undefined);
  const retryRef = useRef(false);
  const writeLock = useRef(false);

  function saveReview(next?: Review) {
    reviewRef.current = next;
    setReview(next);
  }
  function retryable(value: boolean) {
    retryRef.current = value;
    setCanRetry(value);
  }
  function error(text: string) {
    setFeedback({ tone: 'error', text });
  }
  function storageFailed() {
    error(uiText('apps:privateSkillPublicationStorage'));
  }
  function showIntent(intent?: Intent) {
    if (intent?.requestId !== pendingRef.current?.requestId) {
      retryable(false);
      setDismissible(undefined);
    }
    pendingRef.current = intent;
    setPending(intent);
  }
  function restoreIntent() {
    try {
      showIntent(
        storageKey ? recoverPublicationIntent(window.localStorage, storageKey) : undefined,
      );
      readyRef.current = !!storageKey;
      setReady(readyRef.current);
      return true;
    } catch {
      readyRef.current = false;
      setReady(false);
      storageFailed();
      return false;
    }
  }
  function clearIntent(intent: Intent) {
    try {
      window.localStorage.removeItem(storageKey + intent.requestId);
      showIntent(undefined);
      return restoreIntent();
    } catch {
      storageFailed();
      return false;
    }
  }

  useEffect(() => {
    if (!storageKey) return;
    mounted.current = true;
    restoreIntent();
    function sync(event: StorageEvent) {
      if (
        (event.key && !event.key.startsWith(storageKey)) ||
        busyRef.current ||
        !scope.current(scope.ticket())
      )
        return;
      const previous = pendingRef.current?.requestId;
      if (restoreIntent() && previous !== pendingRef.current?.requestId) {
        setFeedback(undefined);
        saveReview(undefined);
      }
    }
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('storage', sync);
      mounted.current = false;
      readyRef.current = false;
      if (writeLock.current) latest.current.onBusyChange(false);
      writeLock.current = false;
      busyRef.current = false;
    };
  }, [scope, storageKey]);

  function available() {
    return (
      mounted.current &&
      scope.current(scope.ticket()) &&
      !busyRef.current &&
      !latest.current.isShelfBusy()
    );
  }
  function begin(write: boolean) {
    if (!available()) return;
    const ticket = scope.ticket();
    busyRef.current = true;
    setBusy(true);
    writeLock.current = write;
    if (write) latest.current.onBusyChange(true);
    const current = () => mounted.current && scope.current(ticket);
    return {
      current,
      finish() {
        if (!current()) return;
        busyRef.current = false;
        setBusy(false);
        if (writeLock.current) latest.current.onBusyChange(false);
        writeLock.current = false;
      },
    };
  }
  async function readTargets(skill: PrivateSkill, teamId: string, current: () => boolean) {
    const key = privateSkillKey(skill);
    const teams = parsePublicationTeams(
      await scope.request(
        `/private-skills/${encodeURIComponent(skill.id)}/team-publication-targets`,
      ),
    );
    const live = latest.current.skill;
    if (!current() || !live || privateSkillKey(live) !== key) return;
    if (!teams) throw Error('Invalid publication targets');
    saveReview({
      key,
      teams,
      teamId: teams.some((team) => team.workspaceId === teamId) ? teamId : '',
    });
  }
  async function open(skill: PrivateSkill, clearFeedback = true) {
    const live = latest.current.skill;
    if (
      !storageKey ||
      pendingRef.current ||
      !eligible(live) ||
      privateSkillKey(skill) !== privateSkillKey(live)
    )
      return;
    const operation = begin(false);
    if (!operation) return;
    if (clearFeedback) setFeedback(undefined);
    const key = privateSkillKey(live);
    const teamId = reviewRef.current?.key === key ? reviewRef.current.teamId : '';
    saveReview({ key, teamId });
    try {
      await readTargets(live, teamId, operation.current);
    } catch (cause) {
      if (operation.current()) error(publicationError(cause));
    } finally {
      operation.finish();
    }
  }
  function choose(teamId: string) {
    const current = reviewRef.current;
    if (
      !available() ||
      pendingRef.current ||
      !current?.teams ||
      (teamId && !current.teams.some((team) => team.workspaceId === teamId))
    )
      return;
    saveReview({ ...current, teamId });
  }

  async function resolve(decision: Decision) {
    const intent = pendingRef.current;
    if (!intent || (decision === 'retry' && !retryRef.current)) return;
    const operation = begin(true);
    if (!operation) return;
    setFeedback(undefined);
    retryable(false);
    setDismissible(undefined);
    const mutation = decision === 'submit' || decision === 'retry';
    try {
      let result: PrivateSkillPublicationResult | undefined;
      try {
        const payload = await scope.request(
          publicationPath(intent, !mutation),
          mutation ? 'PUT' : decision === 'cancel' ? 'DELETE' : 'GET',
          mutation
            ? {
                requestId: intent.requestId,
                expectedSourceRevision: intent.expectedSourceRevision,
                expectedPublicationRevision: intent.expectedPublicationRevision,
                ...(intent.expectedTeamPolicyRevision
                  ? { expectedTeamPolicyRevision: intent.expectedTeamPolicyRevision }
                  : {}),
              }
            : undefined,
        );
        if (!operation.current()) return;
        result = parsePublicationResult(payload, intent);
      } catch (cause) {
        if (!operation.current()) return;
        if (cause instanceof ApiError) {
          if (cause.status === 409 && cause.code === 'TEAM_SKILL_REQUEST_CLOSED') {
            result = { status: 'cancelled' } as const;
          } else if (
            decision === 'check' &&
            cause.status === 404 &&
            cause.code === 'TEAM_SKILL_PUBLICATION_NOT_FOUND'
          ) {
            retryable(true);
            error(uiText('apps:privateSkillPublicationNotObserved'));
            return;
          } else if (
            (mutation && cause.status === 409 && conflictCodes.has(cause.code || '')) ||
            (decision === 'submit' && [400, 401, 403, 404, 413, 422].includes(cause.status))
          ) {
            if (!clearIntent(intent)) return;
            saveReview(undefined);
            error(publicationError(cause));
            return;
          } else if (cause.status === 401 || cause.status === 403) {
            if (cause.status === 403) setDismissible(intent.requestId);
            error(publicationError(cause));
            return;
          }
        }
      }
      if (!result) {
        error(uiText('apps:privateSkillPublicationUnknown'));
        return;
      }
      if (!clearIntent(intent)) return;
      saveReview(undefined);
      const committed = 'publication' in result;
      setFeedback({
        tone: 'status',
        text: uiText(
          committed
            ? 'apps:privateSkillPublicationAccepted'
            : 'apps:privateSkillPublicationCancelled',
        ),
      });
      if (committed) latest.current.onChanged?.();
      const live = latest.current.skill;
      if (eligible(live) && live.id === intent.skillId) {
        try {
          await readTargets(live, intent.teamId, operation.current);
        } catch {
          // The receipt remains valid even when the current list cannot be loaded.
        }
      }
    } finally {
      operation.finish();
    }
  }

  function dismiss() {
    const intent = pendingRef.current;
    if (!intent || intent.requestId !== dismissible || !available() || !clearIntent(intent)) return;
    saveReview(undefined);
    setFeedback({ tone: 'status', text: uiText('apps:privateSkillPublicationReminderRemoved') });
  }

  function publish(skill: PrivateSkill, target: PrivateSkillPublicationTeam) {
    const live = latest.current.skill;
    const current = reviewRef.current;
    if (
      !available() ||
      !readyRef.current ||
      pendingRef.current ||
      !eligible(live) ||
      privateSkillKey(live) !== privateSkillKey(skill) ||
      current?.key !== privateSkillKey(live) ||
      current.teamId !== target.workspaceId ||
      !current.teams?.includes(target) ||
      target.publication?.sourceRevision === live.revision
    )
      return;
    const intent: Intent = {
      version: 1,
      skillId: live.id,
      teamId: target.workspaceId,
      requestId: crypto.randomUUID(),
      expectedSourceRevision: live.revision,
      expectedPublicationRevision: target.publication?.revision ?? null,
      ...(target.policyRevision ? { expectedTeamPolicyRevision: target.policyRevision } : {}),
    };
    try {
      // Recheck other windows, then write only this request's marker.
      const prior = recoverPublicationIntent(window.localStorage, storageKey);
      if (prior) {
        showIntent(prior);
        return;
      }
      window.localStorage.setItem(storageKey + intent.requestId, JSON.stringify(intent));
    } catch {
      storageFailed();
      return;
    }
    showIntent(intent);
    void resolve('submit');
  }

  const skill = options.skill;
  return {
    eligible: !!storageKey && eligible(skill),
    review: skill && review?.key === privateSkillKey(skill) ? review : undefined,
    ready,
    pending,
    canRetry,
    canDismiss: !!pending && pending.requestId === dismissible,
    feedback,
    busy,
    open,
    choose,
    publish,
    resolve,
    dismiss,
  };
}
