import { serviceText } from './i18n/serviceText';
import { uiText } from './i18n';
import type { ComputerState } from '../../shared/types';

type Screen = ComputerState['botScreen'];
export type ComputerLifecycleIntent = {
  agentId: string;
  assignmentRevision: string;
  kind: 'release' | 'reset' | 'resume';
  operationKind: 'release' | 'reset';
  operationId?: string;
};

export function lifecycleNotStarted(error: unknown) {
  const value = error as { code?: unknown; status?: unknown } | null;
  return (
    value?.code === 'LIFECYCLE_NOT_STARTED' &&
    typeof value.status === 'number' &&
    value.status >= 400 &&
    value.status < 500
  );
}

export function lifecycleBlockReason(screen: Screen, kind: ComputerLifecycleIntent['kind']) {
  if (!screen?.screenId || !screen.assignmentRevision) return uiText('computer:text_ca3fce11c0e6');
  const lifecycle = screen.lifecycle;
  if (!lifecycle) return uiText('computer:text_63cfc244fb7e');
  if (kind === 'resume') return lifecycle.operation ? '' : uiText('computer:text_176f686784a9');
  if (lifecycle.operation || lifecycle.state === 'changing')
    return uiText('computer:text_dbc218149793');
  if (
    screen.task?.queued ||
    ['running', 'waiting_cleanup', 'maintenance'].includes(screen.task?.status || '')
  )
    return serviceText(lifecycle.reason) || uiText('computer:text_4441997c9462');
  if (kind === 'release' ? !lifecycle.releaseAllowed : !lifecycle.resetAllowed)
    return (
      serviceText(lifecycle.reason) ||
      (kind === 'release'
        ? uiText('computer:text_63101afc503d')
        : uiText('computer:text_2a2ba390a3fa'))
    );
  return '';
}

export function lifecycleIntent(
  screen: Screen,
  kind: ComputerLifecycleIntent['kind'],
): ComputerLifecycleIntent {
  const reason = lifecycleBlockReason(screen, kind);
  if (reason) throw new Error(reason);
  return {
    agentId: screen!.agentId,
    assignmentRevision: screen!.assignmentRevision!,
    kind,
    operationKind: kind === 'resume' ? screen!.lifecycle!.operation!.kind : kind,
    ...(kind === 'resume' ? { operationId: screen!.lifecycle!.operation!.id } : {}),
  };
}

/** Confirmation is about this exact assignment and, when resuming, the saved transaction. */
export function lifecycleRequest(intent: ComputerLifecycleIntent, screen: Screen) {
  if (intent.agentId !== screen?.agentId || intent.assignmentRevision !== screen.assignmentRevision)
    throw new Error(uiText('computer:text_c4feb9b69947'));
  const reason = lifecycleBlockReason(screen, intent.kind);
  if (reason) throw new Error(reason);
  if (
    intent.kind === 'resume' &&
    (intent.operationId !== screen!.lifecycle?.operation?.id ||
      intent.operationKind !== screen!.lifecycle?.operation?.kind)
  )
    throw new Error(uiText('computer:text_9cc426feedc9'));
  return {
    path: intent.kind === 'resume' ? '/lifecycle/resume' : `/${intent.kind}`,
    body: {
      confirm: true,
      assignmentRevision: intent.assignmentRevision,
      ...(intent.kind === 'resume' ? { operationId: intent.operationId } : {}),
    },
  };
}

export function lifecycleCompleted(intent: ComputerLifecycleIntent, screen: Screen) {
  if (!screen || screen.agentId !== intent.agentId || screen.lifecycle?.operation) return false;
  return intent.operationKind === 'release'
    ? screen.status === 'unassigned' && !screen.screenId && !screen.assignmentRevision
    : !!screen.assignmentRevision &&
        screen.assignmentRevision !== intent.assignmentRevision &&
        screen.lifecycle?.state === 'ready';
}

export function lifecycleCompletionNotice(intent: ComputerLifecycleIntent, state: ComputerState) {
  if (intent.operationKind === 'release') return uiText('computer:text_d6b140c721e7');
  return state.connected && state.botScreen?.status === 'ready'
    ? uiText('computer:text_fc70e6bb6b1e')
    : uiText('computer:text_fde641c8e257');
}

export function botDeletionScreenReason(screen: Screen, loaded: boolean, error?: string) {
  if (error) return uiText('computer:text_2dd6805b6242');
  if (!loaded || !screen) return uiText('computer:text_7e5af961cb47');
  if (screen.screenId || screen.assignmentRevision || screen.lifecycle?.operation)
    return screen.lifecycle?.operation
      ? uiText('computer:text_8b49c1bc6503')
      : uiText('computer:text_def2a438b6e0');
  return '';
}
