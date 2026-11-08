import { uiText } from '../../i18n';
import type { BotTeamDraft, BotTeamPlan } from '../../../../shared/bot-team-plans';
import { ApiError } from '../../api';
import { botTeamProblem, confirmTeamConversation } from '../../botTeamDraft';
import '../SmartTeamPanel.css';
import type { TeamPlanActionsContext } from './createTeamPlanActions.types';
import type { TeamStarterSelection } from './TeamStarterPicker';
export function createTeamPlanActions(readContext: () => TeamPlanActionsContext) {
  function accept(value: BotTeamPlan, replace = false, keepNewMemberDrafts = false) {
    const {
      invalidateCatalogPreview,
      avatarEdits,
      newMemberDrafts,
      setPlan,
      latest,
      setGoal,
      setDraft,
      draftRevision,
      setError,
    } = readContext();

    invalidateCatalogPreview();
    if (replace) {
      avatarEdits.reset();
      if (!keepNewMemberDrafts) newMemberDrafts.current.clear();
    }
    setPlan(value);
    if (replace || !latest.current.plan || latest.current.goal === latest.current.plan.goal)
      setGoal(value.goal);
    if (replace || !latest.current.draft || value.status !== 'ready') {
      setDraft(value.draft);
      draftRevision.current = value.revision;
    } else if (value.revision !== draftRevision.current) setError(uiText('bots:text_351f65f6621f'));
  }
  async function read() {
    const {
      running,
      scope,
      sequence,
      setLoading,
      latest,
      setError,
      catalogRequestRef,
      checkCatalogRequest,
      requestedPlan,
      setOpening,
      setShowHistory,
      startRequest,
      setHistory,
      uncertainRef,
      setUncertain,
    } = readContext();

    if (running.current) return;
    const ticket = scope.ticket(),
      order = ++sequence.current;
    if (!scope.current(ticket)) return;
    setLoading(true);
    try {
      const active = latest.current.plan;
      setError('');
      if (catalogRequestRef.current) {
        await checkCatalogRequest();
        return;
      }
      if (active) {
        const value = await scope.request<BotTeamPlan>(`/bot-team-plans/${active.id}`);
        if (!scope.current(ticket) || order !== sequence.current) return;
        accept(value);
      } else if (requestedPlan.current) {
        const id = requestedPlan.current;
        const value = await scope.request<BotTeamPlan>(`/bot-team-plans/${encodeURIComponent(id)}`);
        if (!scope.current(ticket) || order !== sequence.current || requestedPlan.current !== id)
          return;
        if (value.id !== id) throw new Error(uiText('bots:text_ebfa2d1c5168'));
        accept(value, true);
        requestedPlan.current = undefined;
        setOpening(false);
        setShowHistory(false);
      } else if (startRequest.current) {
        const list = await scope.request<BotTeamPlan[]>(
          `/bot-team-plans?requestId=${startRequest.current.requestId}`,
        );
        if (!scope.current(ticket) || order !== sequence.current) return;
        if (list[0]) accept(list[0], true);
        else setError(uiText('bots:text_f87a44365d69'));
      } else {
        const list = await scope.request<BotTeamPlan[]>('/bot-team-plans');
        if (!scope.current(ticket) || order !== sequence.current) return;
        setHistory(list);
      }
      uncertainRef.current = false;
      setUncertain(false);
    } catch (cause) {
      if (scope.current(ticket) && order === sequence.current) setError((cause as Error).message);
    } finally {
      if (scope.current(ticket) && order === sequence.current) setLoading(false);
    }
  }
  async function mutate(kind: 'start' | 'commit' | 'cancel', starter?: TeamStarterSelection) {
    const {
      scope,
      latest,
      running,
      uncertainRef,
      catalogRequestRef,
      avatarEdits,
      setError,
      requestedPlan,
      startRequest,
      commitRequest,
      draftRevision,
      invalidateCatalogPreview,
      sequence,
      setBusy,
      setNotice,
      setShowHistory,
      setUncertain,
      setLoading,
    } = readContext();

    const ticket = scope.ticket(),
      value = latest.current;
    if (
      !scope.current(ticket) ||
      running.current ||
      value.props.disabled ||
      uncertainRef.current ||
      catalogRequestRef.current
    )
      return;
    if (avatarEdits.current().pending) {
      setError(uiText('bots:text_a2fcc3bfecb3'));
      return;
    }
    if (kind === 'start') {
      if (requestedPlan.current) return;
      if (value.plan && ['generating', 'ready', 'committed'].includes(value.plan.status)) return;
      if (value.plan && ['error', 'cancelled'].includes(value.plan.status))
        startRequest.current = undefined;
      const original = startRequest.current;
      const template = original
        ? original.template
        : starter && { id: starter.id, language: starter.language };
      if (!template && !value.props.modelConfigured) {
        setError(uiText('bots:text_39121f146a22'));
        return;
      }
      const goal = original?.goal || value.goal.trim() || starter?.summary;
      if (!goal || goal.length > 6000) {
        setError(uiText('bots:text_9df1e9d5f62d'));
        return;
      }
      startRequest.current ||= {
        requestId: crypto.randomUUID(),
        goal,
        ...(template && { template }),
      };
    }
    if (kind === 'commit') {
      if (value.plan?.status !== 'ready' || !value.draft) return;
      if (!commitRequest.current && draftRevision.current !== value.plan.revision) return;
      const problem = botTeamProblem(value.draft, value.props.agents);
      if (problem) {
        setError(problem);
        return;
      }
      commitRequest.current ||= {
        requestId: crypto.randomUUID(),
        expectedRevision: value.plan.revision,
        draft: structuredClone(value.draft),
      };
    }
    if (kind === 'cancel' && (!value.plan || !['generating', 'ready'].includes(value.plan.status)))
      return;
    invalidateCatalogPreview();
    running.current = true;
    sequence.current++;
    setBusy(true);
    setError('');
    setNotice('');
    value.props.onBusy(true);
    try {
      const result = await scope.request<BotTeamPlan>(
        kind === 'start' ? '/bot-team-plans' : `/bot-team-plans/${value.plan!.id}/${kind}`,
        'POST',
        kind === 'start' ? startRequest.current : kind === 'commit' ? commitRequest.current : {},
      );
      if (!scope.current(ticket)) return;
      accept(result, true);
      setShowHistory(false);
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408
      ) {
        if (kind === 'start') startRequest.current = undefined;
        if (kind === 'commit') commitRequest.current = undefined;
      } else {
        uncertainRef.current = true;
        setUncertain(true);
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  function update(next: BotTeamDraft) {
    const {
      scope,
      running,
      latest,
      uncertainRef,
      locked,
      commitRequest,
      catalogRequestRef,
      invalidateCatalogPreview,
      setNotice,
      setDraft,
    } = readContext();

    if (
      !scope.current(scope.ticket()) ||
      running.current ||
      latest.current.props.disabled ||
      uncertainRef.current ||
      locked ||
      commitRequest.current ||
      catalogRequestRef.current
    )
      return;
    invalidateCatalogPreview();
    setNotice('');
    latest.current.draft = next;
    setDraft(next);
  }
  async function resumeEditing() {
    const {
      scope,
      latest,
      running,
      uncertainRef,
      catalogRequestRef,
      avatarEdits,
      setError,
      invalidateCatalogPreview,
      sequence,
      setBusy,
      commitRequest,
      draftRevision,
      setNotice,
      setUncertain,
    } = readContext();

    const ticket = scope.ticket(),
      value = latest.current;
    if (
      !scope.current(ticket) ||
      running.current ||
      value.props.disabled ||
      uncertainRef.current ||
      catalogRequestRef.current ||
      value.plan?.status !== 'ready' ||
      !value.draft
    )
      return;
    if (avatarEdits.current().pending) {
      setError(uiText('bots:text_a2fcc3bfecb3'));
      return;
    }
    const problem = botTeamProblem(value.draft, value.props.agents, true);
    if (problem) {
      setError(problem);
      return;
    }
    invalidateCatalogPreview();
    running.current = true;
    sequence.current++;
    setBusy(true);
    setError('');
    value.props.onBusy(true);
    try {
      const revised = await scope.request<BotTeamPlan>(
        `/bot-team-plans/${value.plan.id}/revise`,
        'POST',
        { expectedRevision: value.plan.revision, draft: value.draft },
      );
      if (!scope.current(ticket)) return;
      commitRequest.current = undefined;
      draftRevision.current = undefined;
      accept(revised, true);
      setNotice(uiText('bots:text_502433f9c0de'));
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      uncertainRef.current = true;
      setUncertain(true);
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const confirmed = await scope.request<BotTeamPlan>(`/bot-team-plans/${value.plan.id}`);
          if (!scope.current(ticket)) return;
          accept(confirmed);
          if (confirmed.status === 'committed') setError('');
          uncertainRef.current = false;
          setUncertain(false);
        } catch {
          /* Keep the original draft frozen until an authoritative read. */
        }
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  function choose(value?: BotTeamPlan) {
    const {
      scope,
      running,
      avatarEdits,
      catalogRequestRef,
      invalidateCatalogPreview,
      sequence,
      setLoading,
      requestedPlan,
      setOpening,
      startRequest,
      commitRequest,
      entered,
      setError,
      setNotice,
      setUncertain,
      uncertainRef,
      setPlan,
      setDraft,
      setGoal,
      setShowHistory,
      dirty,
      goalChanged,
      setDiscard,
    } = readContext();

    const work = () => {
      if (
        !scope.current(scope.ticket()) ||
        running.current ||
        avatarEdits.current().busy ||
        catalogRequestRef.current
      )
        return;
      invalidateCatalogPreview();
      avatarEdits.reset();
      sequence.current++;
      setLoading(false);
      requestedPlan.current = undefined;
      setOpening(false);
      startRequest.current = undefined;
      commitRequest.current = undefined;
      entered.current = false;
      setError('');
      setNotice('');
      setUncertain(false);
      uncertainRef.current = false;
      if (value) accept(value, true);
      else {
        setPlan(undefined);
        setDraft(undefined);
        setGoal('');
      }
      setShowHistory(!value);
    };
    if (dirty || goalChanged || avatarEdits.current().pending) setDiscard(() => work);
    else work();
  }
  async function enter(start: boolean) {
    const { latest, entered, running, scope, setBusy, setError } = readContext();

    const currentPlan = latest.current.plan;
    if (
      entered.current ||
      running.current ||
      !scope.current(scope.ticket()) ||
      currentPlan?.status !== 'committed' ||
      !currentPlan.result
    )
      return;
    entered.current = true;
    const ticket = scope.ticket(),
      confirmedPlan = currentPlan;
    running.current = true;
    setBusy(true);
    setError('');
    latest.current.props.onBusy(true);
    try {
      const confirmed = await confirmTeamConversation(scope, confirmedPlan.result!.conversationId);
      if (
        !scope.current(ticket) ||
        latest.current.plan?.id !== confirmedPlan.id ||
        latest.current.plan.status !== 'committed'
      )
        return;
      latest.current.props.onCreated(confirmedPlan, start, confirmed);
    } catch (cause) {
      if (scope.current(ticket)) {
        entered.current = false;
        setError((cause as Error).message);
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        latest.current.props.onBusy(false);
      }
    }
  }
  return { accept, read, mutate, update, resumeEditing, choose, enter };
}
