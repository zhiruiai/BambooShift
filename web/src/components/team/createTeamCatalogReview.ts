import { uiText } from '../../i18n';
import type {
  BotTeamCatalogRefreshResult,
  BotTeamCatalogReview,
} from '../../../../shared/bot-team-plans';
import { botTeamProblem } from '../../botTeamDraft';
import { catalogProfiles, type CatalogRequest } from '../../teamCatalogReview';
import '../SmartTeamPanel.css';
import type { TeamCatalogReviewContext } from './createTeamCatalogReview.types';
export function createTeamCatalogReview(read: () => TeamCatalogReviewContext) {
  function invalidateCatalogPreview() {
    const { catalogSequence, catalogPreviewRef, setCatalogPreview, setCatalogLoading } = read();

    catalogSequence.current++;
    catalogPreviewRef.current = undefined;
    setCatalogPreview(undefined);
    setCatalogLoading(false);
  }
  function retainCatalogRequest(value?: CatalogRequest) {
    const { storageKey, catalogRequestRef, setCatalogRequest, latest, setCatalogSavedPlan } =
      read();

    if (value) {
      const { body: _body, ...metadata } = value;
      const serialized = JSON.stringify(metadata);
      try {
        sessionStorage.setItem(storageKey, serialized);
        if (sessionStorage.getItem(storageKey) !== serialized) throw new Error();
      } catch {
        throw new Error(uiText('bots:text_819380a5ecba'));
      }
    } else {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* A stale identifier can still recover its receipt. */
      }
    }
    catalogRequestRef.current = value;
    setCatalogRequest(value);
    if (value) latest.current.props.onDirty(true);
    if (!value) setCatalogSavedPlan(undefined);
  }
  function finishCatalog(result: BotTeamCatalogRefreshResult, pending: CatalogRequest) {
    const {
      commitRequest,
      uncertainRef,
      setUncertain,
      requestedPlan,
      setOpening,
      setShowHistory,
      accept,
      setError,
      setNotice,
      latest,
      setPlan,
    } = read();

    if (
      result.requestId !== pending.requestId ||
      result.planId !== pending.planId ||
      result.plan?.id !== pending.planId ||
      typeof result.appliedRevision !== 'string' ||
      !result.appliedRevision ||
      typeof result.plan.revision !== 'string' ||
      !result.plan.revision
    )
      throw new Error(uiText('bots:text_e21f4a847ff6'));
    retainCatalogRequest();
    commitRequest.current = undefined;
    uncertainRef.current = false;
    setUncertain(false);
    requestedPlan.current = undefined;
    setOpening(false);
    setShowHistory(false);
    if (result.plan.revision === result.appliedRevision) {
      accept(result.plan, true, true);
      setError('');
      setNotice(uiText('bots:text_b3a7b722357f'));
    } else {
      invalidateCatalogPreview();
      if (!latest.current.plan || latest.current.plan.id !== result.plan.id)
        accept(result.plan, true, true);
      else setPlan(result.plan);
      setError(uiText('bots:text_16466a9c6d0a'));
      setNotice(uiText('bots:text_0253cba93858'));
    }
  }
  async function reviewBots() {
    const {
      latest,
      scope,
      running,
      uncertainRef,
      catalogRequestRef,
      commitRequest,
      avatarEdits,
      setError,
      setNotice,
      catalogSequence,
      setCatalogLoading,
      catalogPreviewRef,
      setCatalogPreview,
    } = read();

    const value = latest.current,
      ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      running.current ||
      value.props.disabled ||
      uncertainRef.current ||
      catalogRequestRef.current ||
      commitRequest.current ||
      value.plan?.status !== 'ready' ||
      !value.draft
    )
      return;
    if (avatarEdits.current().pending) {
      setError(uiText('bots:text_a2fcc3bfecb3'));
      return;
    }
    if (!value.draft.members.some((member) => member.kind === 'reuse')) {
      setNotice(uiText('bots:text_834b02fe7fbd'));
      return;
    }
    const problem = botTeamProblem(value.draft, value.props.agents, true);
    if (problem) {
      setError(problem);
      return;
    }
    invalidateCatalogPreview();
    const order = catalogSequence.current,
      profiles = catalogProfiles(value.draft, value.props.agents);
    setCatalogLoading(true);
    setError('');
    try {
      const review = await scope.request<BotTeamCatalogReview>(
        `/bot-team-plans/${value.plan.id}/review-bots`,
        'POST',
        {
          expectedRevision: value.plan.revision,
          draft: structuredClone(value.draft),
        },
      );
      if (!scope.current(ticket) || order !== catalogSequence.current) return;
      if (
        latest.current.props.disabled ||
        latest.current.plan?.id !== value.plan.id ||
        latest.current.plan.revision !== value.plan.revision ||
        latest.current.draft !== value.draft ||
        avatarEdits.current().pending ||
        profiles !== catalogProfiles(latest.current.draft, latest.current.props.agents)
      ) {
        setError(uiText('bots:text_1e65b5a38b0f'));
        return;
      }
      const reused = value.draft.members.filter((member) => member.kind === 'reuse');
      if (
        review.planId !== value.plan.id ||
        review.expectedRevision !== value.plan.revision ||
        typeof review.reviewToken !== 'string' ||
        !review.reviewToken ||
        !Array.isArray(review.members) ||
        review.members.length !== reused.length ||
        reused.some(
          (member) =>
            !review.members.some(
              (item) => item.key === member.key && item.agentId === member.agentId,
            ),
        )
      )
        throw new Error(uiText('bots:text_3ae0cac852c9'));
      const preview = { value: review, draft: value.draft, profiles };
      catalogPreviewRef.current = preview;
      setCatalogPreview(preview);
    } catch (cause) {
      if (scope.current(ticket) && order === catalogSequence.current)
        setError((cause as Error).message);
    } finally {
      if (scope.current(ticket) && order === catalogSequence.current) setCatalogLoading(false);
    }
  }
  async function saveCatalog(retry = false) {
    const {
      scope,
      latest,
      running,
      avatarEdits,
      catalogRequestRef,
      catalogPreviewRef,
      uncertainRef,
      commitRequest,
      setError,
      sequence,
      setBusy,
      setNotice,
      setLoading,
    } = read();

    const ticket = scope.ticket(),
      value = latest.current;
    if (
      !scope.current(ticket) ||
      running.current ||
      value.props.disabled ||
      avatarEdits.current().pending
    )
      return;
    let pending = catalogRequestRef.current;
    if (retry) {
      if (!pending?.body) return;
    } else {
      const preview = catalogPreviewRef.current;
      if (
        pending ||
        uncertainRef.current ||
        commitRequest.current ||
        !preview ||
        value.plan?.status !== 'ready' ||
        preview.value.planId !== value.plan.id ||
        preview.value.expectedRevision !== value.plan.revision ||
        preview.draft !== value.draft ||
        preview.profiles !== catalogProfiles(value.draft, value.props.agents)
      ) {
        invalidateCatalogPreview();
        setError(uiText('bots:text_c16c77e51a28'));
        return;
      }
      const requestId = crypto.randomUUID();
      pending = {
        version: 1,
        requestId,
        planId: value.plan.id,
        expectedRevision: value.plan.revision,
        body: {
          requestId,
          expectedRevision: value.plan.revision,
          draft: structuredClone(value.draft!),
          reviewToken: preview.value.reviewToken,
        },
      };
      try {
        retainCatalogRequest(pending);
      } catch (cause) {
        setError((cause as Error).message);
        return;
      }
    }
    running.current = true;
    sequence.current++;
    setBusy(true);
    value.props.onBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await scope.request<BotTeamCatalogRefreshResult>(
        `/bot-team-plans/${pending!.planId}/refresh-bots`,
        'POST',
        pending!.body,
      );
      if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
      finishCatalog(result, pending!);
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  return { invalidateCatalogPreview, retainCatalogRequest, finishCatalog, reviewBots, saveCatalog };
}
