import { uiText } from '../../i18n';
import { Check, Info, Loader2, MessageSquare, Plus } from 'lucide-react';
import { routineSaveBody, type RoutineDraft } from '../../routineDraft';
import { ApiError } from '../../api';
import { displayTimeZone as timeZoneLabel, validTimeZone } from '../../timeZones';
import '../RoutineDialog.css';
import { TimeZoneSelect } from '../TimeZoneSelect';
import { RoutinePublicSearchEditor } from './RoutinePublicSearchEditor';
import type { useRoutineDialog } from './useRoutineDialog';
export type RoutineDialogModel = ReturnType<typeof useRoutineDialog>;
export function RoutineScheduleEditorView(model: RoutineDialogModel) {
  const {
    navigate,
    onClose,
    routines,
    editing,
    disabled,
    selectedId,
    mounted,
    operations,
    setSelectedId,
    allAgents,
    clock,
    onChatRequest,
    chatDisabled,
    requestChat,
    edit,
    onToggle,
    savingRef,
    busy,
    askDelete,
    selected,
    conversations,
    userId,
    workspaceId,
    deleting,
    onOpenRun,
    openRun,
    deleteError,
    setDeleting,
    setDeleteError,
    confirmDelete,
    saving,
    onOpenConversation,
    openResult,
    formDisabled,
    editingMissing,
    setError,
    targetConversation,
    availableAgents,
    draft,
    draftRef,
    conversationId,
    createDraft,
    setSaving,
    onSave,
    resetEditor,
    change,
    currentEditing,
    titleRef,
    error,
    feedbackRef,
    leave,
    setLeave,
    openingRef,
  } = model;
  return (
    <form
      className="dialog-form bordered-form routine-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          !mounted.current ||
          !operations.scope.current(operations.scope.ticket()) ||
          formDisabled ||
          savingRef.current ||
          operations.getState().busy ||
          (!editing && operations.getState().request)
        )
          return;
        if (editingMissing) {
          setError(uiText('routines:text_ab6b9e519a7d'));
          return;
        }
        if (!targetConversation || !availableAgents.some((agent) => agent.id === draft.agentId)) {
          setError(uiText('routines:text_7dfe86dcf31a'));
          return;
        }
        let body: ReturnType<typeof routineSaveBody>;
        try {
          body = routineSaveBody(draftRef.current, conversationId, editing);
          if (body.publicSearchQueries && !model.canEditPublicSearch(draftRef.current.agentId))
            throw Error(uiText('routines:publicSearchTarget'));
          if (body.schedule === 'webhook' && !model.canEditWebhook(draftRef.current.agentId))
            throw Error(uiText('routines:webhookTarget'));
        } catch (cause) {
          setError((cause as Error).message);
          return;
        }
        if (!editing) {
          createDraft.current = draftRef.current;
          setError('');
          await operations.create(body);
          return;
        }
        savingRef.current = true;
        const ticket = operations.scope.ticket();
        setSaving(true);
        setError('');
        try {
          await onSave(body, editing?.id);
          if (!mounted.current || !operations.scope.current(ticket)) return;
          resetEditor();
        } catch (cause) {
          if (mounted.current && operations.scope.current(ticket)) {
            const key =
              cause instanceof ApiError && cause.code === 'ROUTINE_SEARCH_SCOPE_CHANGED'
                ? 'routines:publicSearchChanged'
                : cause instanceof ApiError && cause.code === 'ROUTINE_SEARCH_TARGET'
                  ? 'routines:publicSearchTarget'
                  : undefined;
            setError(
              key ? uiText(key) : (cause as Error).message || uiText('routines:text_43ffaacf54c5'),
            );
          }
        } finally {
          savingRef.current = false;
          if (mounted.current && operations.scope.current(ticket)) setSaving(false);
        }
      }}
    >
      {onChatRequest && !editing && (
        <section className="routine-chat-entry" aria-label={uiText('routines:text_d5777aeaf871')}>
          <label>
            {uiText('routines:text_68458e102038')}
            <select
              value={draft.agentId}
              disabled={formDisabled}
              onChange={(event) => change('agentId', event.target.value)}
            >
              {!availableAgents.some((agent) => agent.id === draft.agentId) && (
                <option value="">{uiText('routines:text_5f4fa1b1cda1')}</option>
              )}
              {availableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={chatDisabled || !availableAgents.some((agent) => agent.id === draft.agentId)}
            onClick={() =>
              requestChat({ kind: 'create', conversationId, agentId: draftRef.current.agentId })
            }
          >
            <MessageSquare size={15} />
            {uiText('routines:text_85c0b0e7ef26')}
          </button>
          <p className="field-help">{uiText('routines:text_54b1c098aaa0')}</p>
        </section>
      )}
      <div className="routine-editor-heading">
        <h3>
          {onChatRequest
            ? editing
              ? uiText('routines:text_d6cf3cddaab9')
              : uiText('routines:text_cd824faf3026')
            : editing
              ? uiText('routines:text_6b6ec9a057fd')
              : uiText('routines:text_71d613f272cf')}
        </h3>
        {editing && (
          <span>
            {(currentEditing || editing).enabled
              ? uiText('routines:text_dfb802238b38')
              : uiText('routines:text_eb0c326b60ae')}
            {uiText('routines:text_1301f8f37507')}
          </span>
        )}
      </div>
      {editing && (
        <p className="field-help">
          {uiText('routines:text_e0a607fefb4e')}
          {targetConversation?.title || uiText('routines:text_d2b3fd68bdc0')}
          {uiText('routines:text_9c0175735a00')}
        </p>
      )}
      <fieldset className="routine-editor-fields" disabled={formDisabled}>
        <label>
          {uiText('routines:text_2479560deb33')}
          <input
            ref={titleRef}
            required
            maxLength={100}
            placeholder={uiText('routines:text_87728e4b6c4e')}
            value={draft.title}
            onChange={(event) => change('title', event.target.value)}
          />
        </label>
        {(!onChatRequest || editing) && (
          <label>
            {uiText('routines:text_68458e102038')}
            <select
              required
              value={draft.agentId}
              onChange={(event) => change('agentId', event.target.value)}
            >
              {!availableAgents.some((agent) => agent.id === draft.agentId) && (
                <option value="">{uiText('routines:text_5f4fa1b1cda1')}</option>
              )}
              {availableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="field-pair">
          <label>
            {uiText('routines:text_56a782688460')}
            <select
              value={draft.mode}
              onChange={(event) => change('mode', event.target.value as RoutineDraft['mode'])}
            >
              <option value="daily">{uiText('routines:text_998fb4db1add')}</option>
              <option value="weekdays">{uiText('routines:text_b0f73e686d33')}</option>
              <option value="weekly">{uiText('routines:text_ab88ce6535a1')}</option>
              <option value="interval">{uiText('routines:text_6c9084f96f7f')}</option>
              {(model.canEditWebhook(draft.agentId) || draft.mode === 'webhook') && (
                <option value="webhook" disabled={!model.canEditWebhook(draft.agentId)}>
                  {uiText('routines:webhookSchedule')}
                </option>
              )}
              {draft.mode === 'invalid' && (
                <option value="invalid" disabled>
                  {uiText('routines:text_7cfc40fc374f')}
                </option>
              )}
            </select>
          </label>
          {draft.mode !== 'interval' && draft.mode !== 'webhook' && (
            <label>
              {uiText('routines:text_45e03e436ed0')}
              <input
                type="time"
                required
                value={draft.time}
                onChange={(event) => change('time', event.target.value)}
              />
            </label>
          )}
          {draft.mode === 'interval' && (
            <label>
              {uiText('routines:text_63f674fb44eb')}
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={525600}
                step={1}
                required
                value={draft.minutes}
                onChange={(event) => change('minutes', event.target.value)}
              />
            </label>
          )}
        </div>
        {((draft.mode !== 'interval' && draft.mode !== 'webhook') ||
          !validTimeZone(draft.timeZone)) && (
          <TimeZoneSelect
            value={draft.timeZone}
            disabled={formDisabled}
            onChange={(value) => change('timeZone', value)}
          />
        )}
        {draft.mode === 'weekly' && (
          <fieldset className="routine-weekdays">
            <legend>{uiText('routines:text_85dc6d57b49f')}</legend>
            <div className="routine-weekday-options">
              {[
                uiText('routines:text_51a75f4634df'),
                uiText('routines:text_084b42f6e95e'),
                uiText('routines:text_a4c3313deb18'),
                uiText('routines:text_754a9d5828d5'),
                uiText('routines:text_c9b87f516a38'),
                uiText('routines:text_de07b5383874'),
                uiText('routines:text_85217f7aff77'),
              ].map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={draft.days.includes(index + 1)}
                    onChange={(event) => {
                      const days = event.target.checked
                        ? [...draft.days, index + 1]
                        : draft.days.filter((value) => value !== index + 1);
                      change(
                        'days',
                        days.sort((a, b) => a - b),
                      );
                    }}
                  />
                  <span>
                    {uiText('routines:text_5c553ec3f6db')}
                    {day}
                  </span>
                </label>
              ))}
            </div>
            {!draft.days.length && (
              <small className="routine-day-hint">{uiText('routines:text_900fa0336d19')}</small>
            )}
          </fieldset>
        )}
        <label>
          {uiText('routines:text_7b023cc57225')}
          <textarea
            required
            maxLength={12000}
            rows={3}
            placeholder={uiText('routines:text_192ae43642d1')}
            value={draft.prompt}
            onChange={(event) => change('prompt', event.target.value)}
          />
        </label>
        {model.canEditPublicSearch(draft.agentId) && (
          <RoutinePublicSearchEditor
            value={draft.publicSearch}
            onChange={(value) => change('publicSearch', value)}
          />
        )}
      </fieldset>
      {draft.mode === 'webhook' ? (
        <p className="field-help">{uiText('routines:webhookScheduleHelp')}</p>
      ) : (
        <p className="field-help">
          {draft.mode === 'interval'
            ? uiText('routines:text_dbcd66041c80')
            : draft.mode === 'invalid'
              ? uiText('routines:text_cfe64fad3a04')
              : draft.mode === 'weekdays'
                ? uiText('routines:text_882d20964336', { value0: timeZoneLabel(draft.timeZone) })
                : draft.mode === 'weekly'
                  ? uiText('routines:text_61b6364b393e', { value0: timeZoneLabel(draft.timeZone) })
                  : uiText('routines:text_6a188a824bf7', { value0: timeZoneLabel(draft.timeZone) })}
          {draft.mode !== 'interval' && uiText('routines:text_d4c4abbf08fd')}
          {uiText('routines:text_95b63988a89a')}
          {draft.mode === 'weekly' || draft.mode === 'weekdays'
            ? uiText('routines:text_580d48baaab8')
            : uiText('routines:text_7b3da05991c8')}
          {uiText('routines:text_446b2d72ab11')}
        </p>
      )}
      {error && (
        <div className="routine-save-error" role="alert" tabIndex={-1} ref={feedbackRef}>
          <Info size={15} />
          <span>{error}</span>
        </div>
      )}
      <div className="dialog-actions">
        {editing && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => navigate(resetEditor)}
          >
            {uiText('routines:text_4b29ce8e4093')}
          </button>
        )}
        <button
          className="primary-button"
          disabled={formDisabled || !draft.title.trim() || !draft.prompt.trim() || !draft.agentId}
        >
          {saving ? (
            <Loader2 size={15} className="spin" />
          ) : editing ? (
            <Check size={15} />
          ) : (
            <Plus size={15} />
          )}
          {saving
            ? uiText('routines:text_6bdb4435095e')
            : editing
              ? uiText('routines:text_991bb7cfe5a8')
              : uiText('routines:text_d2ff17f44817')}
        </button>
      </div>
    </form>
  );
}
