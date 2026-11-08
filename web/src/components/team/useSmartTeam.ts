import { useEffect, useRef, useState } from 'react';
import type {
  BotTeamDraft,
  BotTeamPlan,
  CommitBotTeamPlan,
  CreateBotTeamPlan,
  NewTeamMember,
} from '../../../../shared/bot-team-plans';
import { createAppConnectionScope } from '../../appConnections';
import { useAvatarEdits } from '../../avatarImages';
import {
  catalogProfiles,
  catalogStorageKey,
  restoredCatalogRequest,
  type CatalogPreview,
  type CatalogRequest,
} from '../../teamCatalogReview';
import '../SmartTeamPanel.css';
import { createTeamCatalogRecovery } from './createTeamCatalogRecovery';
import type { TeamCatalogRecoveryContext } from './createTeamCatalogRecovery.types';
import { createTeamCatalogReview } from './createTeamCatalogReview';
import type { TeamCatalogReviewContext } from './createTeamCatalogReview.types';
import { createTeamPlanActions } from './createTeamPlanActions';
import type { TeamPlanActionsContext } from './createTeamPlanActions.types';
import type { SmartTeamProps as Props } from './types';
export function useSmartTeam(props: Props) {
  const readActionContext = (): TeamCatalogReviewContext &
    TeamCatalogRecoveryContext &
    TeamPlanActionsContext => actionContext;

  const avatarEdits = useAvatarEdits();
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current.props }),
  );
  const [goal, setGoal] = useState(''),
    [plan, setPlan] = useState<BotTeamPlan>(),
    [draft, setDraft] = useState<BotTeamDraft>(),
    [history, setHistory] = useState<BotTeamPlan[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [showHistory, setShowHistory] = useState(true);
  const [opening, setOpening] = useState(!!props.initialPlanId);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const running = useRef(false),
    sequence = useRef(0),
    startRequest = useRef<CreateBotTeamPlan | undefined>(undefined),
    commitRequest = useRef<CommitBotTeamPlan | undefined>(undefined),
    draftRevision = useRef<string | undefined>(undefined),
    uncertainRef = useRef(false),
    entered = useRef(false);
  const requestedPlan = useRef(props.initialPlanId);
  const newMemberDrafts = useRef(new Map<string, NewTeamMember>());
  const storageKey = catalogStorageKey(props);
  const [catalogRequest, setCatalogRequest] = useState<CatalogRequest | undefined>(() =>
    restoredCatalogRequest(storageKey),
  );
  const catalogRequestRef = useRef(catalogRequest);
  const [catalogPreview, setCatalogPreview] = useState<CatalogPreview>();
  const catalogPreviewRef = useRef<CatalogPreview | undefined>(undefined);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogSequence = useRef(0);
  const [catalogSavedPlan, setCatalogSavedPlan] = useState<BotTeamPlan>();
  const latest = useRef({ props, plan, draft, goal });
  latest.current = { props, plan, draft, goal };
  const dirty =
    !!draft && plan?.status === 'ready' && JSON.stringify(draft) !== JSON.stringify(plan.draft);
  const locked = busy || !!props.disabled || uncertain || !!catalogRequest;
  const revisionConflict =
    !!draft && plan?.status === 'ready' && draftRevision.current !== plan.revision;
  const goalChanged = !!goal.trim() && (!plan || goal !== plan.goal);
  useEffect(() => {
    props.onDirty(dirty || goalChanged || avatarEdits.pending || !!catalogRequest);
  }, [dirty, goalChanged, avatarEdits.pending, catalogRequest]);
  const { accept, read, mutate, update, resumeEditing, choose, enter } =
    createTeamPlanActions(readActionContext);
  const { invalidateCatalogPreview, retainCatalogRequest, finishCatalog, reviewBots, saveCatalog } =
    createTeamCatalogReview(readActionContext);

  const selectedProfiles = catalogProfiles(draft, props.agents);
  useEffect(() => {
    if (catalogPreviewRef.current && catalogPreviewRef.current.profiles !== selectedProfiles)
      invalidateCatalogPreview();
  }, [selectedProfiles]);

  const { checkCatalogRequest, continueSavedCatalog } =
    createTeamCatalogRecovery(readActionContext);

  useEffect(() => {
    scope.resume();
    void read();
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !latest.current.props.disabled &&
        latest.current.plan?.status === 'generating'
      )
        void read();
    }, 2000);
    return () => {
      scope.suspend();
      sequence.current++;
      catalogSequence.current++;
      clearInterval(timer);
      latest.current.props.onBusy(false);
      latest.current.props.onDirty(false);
    };
  }, [scope]);

  const editable = !!draft && plan?.status === 'ready';

  const actionContext = {
    catalogSequence,
    catalogPreviewRef,
    setCatalogPreview,
    setCatalogLoading,
    storageKey,
    catalogRequestRef,
    setCatalogRequest,
    latest,
    setCatalogSavedPlan,
    commitRequest,
    uncertainRef,
    setUncertain,
    requestedPlan,
    setOpening,
    setShowHistory,
    accept,
    setError,
    setNotice,
    setPlan,
    scope,
    running,
    avatarEdits,
    sequence,
    setBusy,
    setLoading,
    finishCatalog,
    catalogSavedPlan,
    retainCatalogRequest,
    invalidateCatalogPreview,
    draftRevision,
    newMemberDrafts,
    setGoal,
    setDraft,
    checkCatalogRequest,
    startRequest,
    setHistory,
    locked,
    entered,
    dirty,
    goalChanged,
    setDiscard,
  };
  return {
    ...actionContext,
    props,
    busy,
    error,
    notice,
    uncertain,
    discard,
    opening,
    loading,
    choose,
    plan,
    goal,
    mutate,
    catalogRequest,
    saveCatalog,
    continueSavedCatalog,
    editable,
    revisionConflict,
    resumeEditing,
    draft,
    update,
    catalogLoading,
    reviewBots,
    catalogPreview,
    enter,
    read,
    showHistory,
    history,
  };
}
