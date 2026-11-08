import { uiText } from '../../i18n';
import type { BotTeamCatalogRefreshResult, BotTeamPlan } from '../../../../shared/bot-team-plans';
import { ApiError } from '../../api';
import '../SmartTeamPanel.css';
import type { TeamCatalogRecoveryContext } from './createTeamCatalogRecovery.types';
export function createTeamCatalogRecovery(read: () => TeamCatalogRecoveryContext) {
  async function checkCatalogRequest() {
    const {
      catalogRequestRef,
      scope,
      running,
      latest,
      setBusy,
      setError,
      finishCatalog,
      setCatalogSavedPlan,
      accept,
      requestedPlan,
      setOpening,
      setShowHistory,
      setLoading,
    } = read();

    const pending = catalogRequestRef.current,
      ticket = scope.ticket();
    if (!pending || !scope.current(ticket) || running.current || latest.current.props.disabled)
      return;
    running.current = true;
    setBusy(true);
    latest.current.props.onBusy(true);
    setError('');
    try {
      try {
        const result = await scope.request<BotTeamCatalogRefreshResult>(
          `/bot-team-plans/${pending.planId}/catalog-refreshes/${pending.requestId}`,
        );
        if (scope.current(ticket) && catalogRequestRef.current === pending)
          finishCatalog(result, pending);
      } catch (cause) {
        if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
        const saved = await scope.request<BotTeamPlan>(`/bot-team-plans/${pending.planId}`);
        if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
        if (saved.id !== pending.planId) throw new Error(uiText('bots:text_820b10c70ed5'));
        setCatalogSavedPlan(saved);
        if (!latest.current.plan || latest.current.plan.id !== saved.id) accept(saved, true, true);
        else accept(saved);
        requestedPlan.current = undefined;
        setOpening(false);
        setShowHistory(false);
        setError(
          pending.body ? uiText('bots:text_0c7c4edfe582') : uiText('bots:text_f4a3344f9865'),
        );
      }
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  async function continueSavedCatalog() {
    const {
      catalogRequestRef,
      catalogSavedPlan,
      scope,
      running,
      latest,
      avatarEdits,
      setBusy,
      setError,
      finishCatalog,
      setCatalogSavedPlan,
      retainCatalogRequest,
      commitRequest,
      uncertainRef,
      setUncertain,
      invalidateCatalogPreview,
      setPlan,
      draftRevision,
      setNotice,
      accept,
      setLoading,
    } = read();

    const pending = catalogRequestRef.current,
      shown = catalogSavedPlan,
      ticket = scope.ticket();
    if (
      !pending ||
      !shown ||
      !scope.current(ticket) ||
      running.current ||
      latest.current.props.disabled ||
      avatarEdits.current().pending
    )
      return;
    running.current = true;
    setBusy(true);
    latest.current.props.onBusy(true);
    setError('');
    try {
      try {
        const result = await scope.request<BotTeamCatalogRefreshResult>(
          `/bot-team-plans/${pending.planId}/catalog-refreshes/${pending.requestId}`,
        );
        if (scope.current(ticket) && catalogRequestRef.current === pending)
          finishCatalog(result, pending);
        return;
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      }
      if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
      let saved = await scope.request<BotTeamPlan>(`/bot-team-plans/${pending.planId}`);
      if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
      if (
        saved.id !== shown.id ||
        saved.revision !== shown.revision ||
        JSON.stringify(saved.draft) !== JSON.stringify(shown.draft)
      ) {
        setCatalogSavedPlan(saved);
        setError(uiText('bots:text_3fadcd6b7069'));
        return;
      }
      if (saved.revision === pending.expectedRevision) {
        if (saved.status !== 'ready' || !saved.draft)
          throw new Error(uiText('bots:text_7b03667aa3e4'));
        saved = await scope.request<BotTeamPlan>(
          `/bot-team-plans/${pending.planId}/revise`,
          'POST',
          { expectedRevision: pending.expectedRevision, draft: saved.draft },
        );
        if (!scope.current(ticket) || catalogRequestRef.current !== pending) return;
        if (saved.id !== pending.planId || saved.revision === pending.expectedRevision)
          throw new Error(uiText('bots:text_a53cd975b5b1'));
      }
      retainCatalogRequest();
      commitRequest.current = undefined;
      uncertainRef.current = false;
      setUncertain(false);
      if (
        pending.body &&
        latest.current.plan?.id === saved.id &&
        latest.current.draft &&
        saved.status === 'ready'
      ) {
        invalidateCatalogPreview();
        setPlan(saved);
        draftRevision.current = saved.revision;
        setNotice(uiText('bots:text_ecf08ef3e299'));
      } else {
        accept(saved, true, true);
        setNotice(uiText('bots:text_6dffbc2d8a15'));
      }
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  return { checkCatalogRequest, continueSavedCatalog };
}
