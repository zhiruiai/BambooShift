import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { BotTemplate } from '../../../../shared/bot-templates';
import {
  createBotInstaller,
  definiteTemplateRejection,
  type BotCopySource,
  type BotInstallerState,
  type RoutineInstallMode,
} from '../../botTemplates';
import { BotTemplatePreview, RoutineInstallChoice } from '../BotTemplatePreview';
import '../BotTemplates.css';
import { Dialog } from '../UI';
import { BotTemplateDialogRequest, Common } from './types';
export function TemplateSource(
  props: Common & { request: Extract<BotTemplateDialogRequest, { agentId: string }> },
) {
  const [source, setSource] = useState<BotCopySource>(),
    [name, setName] = useState(''),
    [mode, setMode] = useState<RoutineInstallMode>('preserve'),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false);
  const [installState, setInstallState] = useState<BotInstallerState>({
    busy: false,
    checked: false,
    error: '',
  });
  const key = `openbot-bot-${props.request.kind}:${props.userId || 'local'}:${props.workspaceId || 'local'}:${props.request.agentId}`;
  const [installer] = useState(() =>
    createBotInstaller({
      scope: props.scope,
      kind: 'copy',
      storageKey: key,
      onChange: setInstallState,
    }),
  );
  const [createAttempt, setCreateAttempt] = useState<
    { requestId: string; expectedSourceRevision: string } | undefined
  >(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || 'null');
      return props.request.kind === 'share' &&
        typeof value?.requestId === 'string' &&
        typeof value.expectedSourceRevision === 'string'
        ? value
        : undefined;
    } catch {
      return;
    }
  });
  const createAttemptRef = useRef(createAttempt),
    createChecked = useRef(false);
  const [createCanContinue, setCreateCanContinue] = useState(false);
  const running = useRef(false),
    sequence = useRef(0),
    active = useRef(true);
  const current = () => active.current && props.scope.current(props.scope.ticket());
  async function load() {
    const order = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const value = await props.scope.request<BotCopySource>(
        `/bot-copy-source/${encodeURIComponent(props.request.agentId)}`,
      );
      if (current() && order === sequence.current) {
        setSource(value);
        setName(
          (previous) =>
            previous ||
            uiText('common:text_434bfc1dd9f5', {
              value0: value.blueprint.profile.name.slice(0, 37),
            }),
        );
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      if (current() && order === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    installer.resume();
    setInstallState(installer.state);
    void load();
    return () => {
      active.current = false;
      sequence.current++;
      installer.suspend();
    };
  }, [installer]);
  async function create() {
    if (
      !current() ||
      running.current ||
      !source ||
      (createAttemptRef.current && !createChecked.current)
    )
      return;
    running.current = true;
    setCreating(true);
    setError('');
    const attempt = createAttemptRef.current || {
      requestId: crypto.randomUUID(),
      expectedSourceRevision: source.sourceRevision,
    };
    createAttemptRef.current = attempt;
    createChecked.current = false;
    setCreateCanContinue(false);
    setCreateAttempt(attempt);
    try {
      sessionStorage.setItem(key, JSON.stringify(attempt));
      const template = await props.scope.request<BotTemplate>('/bot-templates', 'POST', {
        ...attempt,
        sourceAgentId: props.request.agentId,
        sourceConversationId: props.request.conversationId,
      });
      if (current()) {
        sessionStorage.removeItem(key);
        props.onChanged();
        props.onManage(template.id);
      }
    } catch (cause) {
      if (current()) {
        setError((cause as Error).message);
        if (definiteTemplateRejection(cause, 'template')) {
          createAttemptRef.current = undefined;
          setCreateAttempt(undefined);
          sessionStorage.removeItem(key);
        }
      }
    } finally {
      running.current = false;
      if (current()) setCreating(false);
    }
  }
  async function recover() {
    const attempt = createAttemptRef.current;
    if (!current() || running.current || !attempt) return;
    running.current = true;
    setCreating(true);
    setError('');
    try {
      const result = await props.scope.request<BotTemplate[]>(
        `/bot-templates?requestId=${encodeURIComponent(attempt.requestId)}`,
      );
      if (current()) {
        if (result[0]) {
          sessionStorage.removeItem(key);
          props.onManage(result[0].id);
        } else {
          createChecked.current = true;
          setCreateCanContinue(true);
          setError(uiText('common:text_6a1acf806eed'));
        }
      }
    } catch (cause) {
      if (current()) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (current()) setCreating(false);
    }
  }
  const busy = creating || installState.busy,
    pending = !!installState.attempt || !!installState.receipt;
  function close() {
    if (!running.current && !installer.state.busy && current()) props.onClose();
  }
  return (
    <Dialog
      title={
        props.request.kind === 'copy'
          ? uiText('common:text_65ee593d33ef')
          : uiText('common:text_9c59f028cecb')
      }
      subtitle={uiText('common:text_8821285d94a6')}
      className="bot-template-dialog"
      onClose={close}
    >
      {loading && <p className="field-help">{uiText('common:text_8e74a91ad2d8')}</p>}
      {(error || installState.error) && (
        <p className="error-text" role="alert">
          {error || installState.error}
        </p>
      )}
      {source && !pending && !createAttempt && (
        <>
          <BotTemplatePreview
            workspaceId={props.workspaceId}
            userId={props.userId}
            blueprint={source.blueprint}
            avatarPath={source.avatarPath}
            routineMode={mode}
          />
          {props.request.kind === 'copy' && (
            <div className="dialog-form">
              <label>
                {uiText('common:text_2d25504d52f4')}
                <input
                  value={name}
                  maxLength={40}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <RoutineInstallChoice
                mode={mode}
                onChange={setMode}
                disabled={busy}
                routines={source.blueprint.routines}
              />
            </div>
          )}
        </>
      )}
      {props.request.kind === 'copy' ? (
        <>
          {pending && (
            <p className="bot-form-notice">
              {uiText('common:text_7231021eb647')}
              {installState.attempt?.name || name}
              {uiText('common:text_0e9aefdba26d')}
            </p>
          )}
          {installState.confirmed ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                if (current()) props.onCreated(installState.confirmed!);
              }}
            >
              {uiText('common:text_c10381fb9fd7')}
            </button>
          ) : (
            <div className="dialog-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={close}>
                {uiText('common:text_3fd47edce45b')}
              </button>
              {pending ? (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void installer.check()}
                  >
                    {uiText('common:text_a86d0a4390dc')}
                  </button>
                  {installState.checked && (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void installer.retry()}
                    >
                      {uiText('common:text_23d944871e93')}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || loading || !source || !name.trim()}
                  onClick={() => {
                    if (source)
                      void installer.start({
                        kind: 'copy',
                        agentId: props.request.agentId,
                        expectedSourceRevision: source.sourceRevision,
                        name: name.trim(),
                        routineMode: mode,
                      });
                  }}
                >
                  {uiText('common:text_559e976912d7')}
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={close}>
            {uiText('common:text_3fd47edce45b')}
          </button>
          {createAttempt && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void recover()}
            >
              {uiText('common:text_d810dae981fb')}
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={busy || loading || !source || (!!createAttempt && !createCanContinue)}
            onClick={() => void create()}
          >
            {createAttempt
              ? uiText('common:text_601c6e1f7cd4')
              : uiText('common:text_03c818dd9e9a')}
          </button>
        </div>
      )}
      {(!source || !!error || !!installState.error) && !loading && !createAttempt && !pending && (
        <button type="button" className="secondary-button" onClick={() => void load()}>
          {uiText('common:text_df7392cc96be')}
        </button>
      )}
    </Dialog>
  );
}
