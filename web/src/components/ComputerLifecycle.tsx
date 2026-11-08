import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { Info, Loader2, RefreshCw } from 'lucide-react';
import type { ComputerState } from '../../../shared/types';
import {
  lifecycleBlockReason,
  lifecycleRequest,
  type ComputerLifecycleIntent,
} from '../computerLifecycle';

export function ComputerLifecycle({
  screen,
  name,
  owner,
  busy,
  pending,
  uncertain,
  confirmation,
  error,
  notice,
  localBlock,
  onChoose,
  onCancel,
  onConfirm,
  onRefresh,
}: {
  screen: ComputerState['botScreen'];
  name: string;
  owner: boolean;
  busy: boolean;
  pending: boolean;
  uncertain: boolean;
  confirmation: ComputerLifecycleIntent | null;
  error: string;
  notice: string;
  localBlock: string;
  onChoose: (kind: ComputerLifecycleIntent['kind']) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
}) {
  if (!screen?.screenId && !confirmation && !notice) return null;
  const lifecycle = screen?.lifecycle;
  const operation = lifecycle?.operation;
  const unavailableReason =
    serviceText(lifecycle?.reason) ||
    (!operation && !lifecycle?.resetAllowed ? lifecycleBlockReason(screen, 'release') : '');
  let blocked = localBlock;
  if (confirmation && !blocked) {
    try {
      lifecycleRequest(confirmation, screen);
    } catch (cause) {
      blocked = (cause as Error).message;
    }
  }
  const label =
    confirmation?.operationKind === 'reset'
      ? uiText('computer:text_e0534b8a4e46')
      : uiText('computer:text_cc3d94550a8c');
  const continueSaved =
    !!operation &&
    !pending &&
    (uncertain || confirmation?.kind !== 'resume' || confirmation.operationId !== operation.id);
  return (
    <section className="computer-lifecycle" aria-label={uiText('computer:text_3222f11781ed')}>
      {notice && (
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
      {confirmation ? (
        <div className="agent-delete-confirm">
          <strong>
            {confirmation.kind === 'resume' ? uiText('computer:text_5e6149034f06') : label}
            {uiText('common:punct_b269e4a0914b')}
            {name}
            {uiText('computer:text_368edc621843')}
          </strong>
          <p>{uiText('computer:text_da395a5ea449')}</p>
          <p>
            {confirmation.operationKind === 'release'
              ? uiText('computer:text_0468d75e4f9b')
              : uiText('computer:text_b292dc685540')}
          </p>
          {confirmation.kind === 'resume' && (
            <p>
              {uiText('computer:text_4a8640c05627')}
              {label}
              {uiText('computer:text_3183f9cfddb6')}
            </p>
          )}
          {pending && (
            <p role="status">
              {uiText('computer:text_e6b02a08e69a')}
              {confirmation.kind === 'resume' ? uiText('computer:text_5e6149034f06') : label}
              {uiText('computer:text_b37c19bf9542')}
            </p>
          )}
          {uncertain && <p role="status">{uiText('computer:text_3e874ba424cc')}</p>}
          {(error || blocked) && (
            <p className="error-text" role="alert">
              {error || blocked}
            </p>
          )}
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={onCancel}
            >
              {uncertain
                ? uiText('computer:text_6fc80d9e6fe8')
                : uiText('computer:text_2cd0f3be8738')}
            </button>
            {continueSaved ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !!localBlock || !owner}
                onClick={() => onChoose('resume')}
              >
                {uiText('computer:text_5e6149034f06')}
              </button>
            ) : (
              <button
                type="button"
                className="danger-button"
                disabled={!owner || busy || pending || uncertain || !!blocked}
                onClick={onConfirm}
              >
                {pending && <Loader2 size={14} className="spin" />}
                {confirmation.kind === 'resume'
                  ? uiText('computer:text_45dc124fe709')
                  : uiText('computer:text_fbe6e55ab7ad', { value0: label })}
              </button>
            )}
            {uncertain && !pending && (
              <button type="button" className="text-button" disabled={busy} onClick={onRefresh}>
                <RefreshCw size={13} />
                {uiText('computer:text_802a407c7743')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {unavailableReason && (
            <p className="field-help">
              <Info size={13} />
              {unavailableReason}
            </p>
          )}
          {operation && (
            <p className="field-help">
              {operation.kind === 'release'
                ? uiText('computer:text_cc3d94550a8c')
                : uiText('computer:text_e0534b8a4e46')}
              {uiText('computer:text_5171ea17a92b')}
            </p>
          )}
          {owner ? (
            <div className="lifecycle-actions">
              {operation ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || pending || !!localBlock}
                  onClick={() => onChoose('resume')}
                >
                  {uiText('computer:text_5e6149034f06')}
                </button>
              ) : uncertain ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || pending}
                  onClick={onRefresh}
                >
                  <RefreshCw size={13} />
                  {uiText('computer:text_33d1a20494c9')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy || pending || !!localBlock || !!lifecycleBlockReason(screen, 'release')
                    }
                    onClick={() => onChoose('release')}
                  >
                    {uiText('computer:text_c3b08f8bf7c5')}
                  </button>
                  {(lifecycle?.resetAllowed || lifecycle?.state === 'blocked') && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        busy || pending || !!localBlock || !!lifecycleBlockReason(screen, 'reset')
                      }
                      onClick={() => onChoose('reset')}
                    >
                      {uiText('computer:text_36dd1f935002')}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="field-help">{uiText('computer:text_b72100a10cc3')}</p>
          )}
          {owner && (localBlock || (uncertain && !operation)) && (
            <p className="field-help">{localBlock || uiText('computer:text_7c7130e9c782')}</p>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
