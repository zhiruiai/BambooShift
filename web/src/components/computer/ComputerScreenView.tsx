import { serviceText } from '../../i18n/serviceText';
import { currentLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import {
  ArrowUp,
  FolderOpen,
  Image,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { HOST_DESKTOP_CAPABILITY } from '../../../../shared/computer-screens';
import { ComputerFiles } from '../ComputerFiles';
import { ComputerSurface } from '../ComputerSurface';
import { ComputerActionEntry } from './ComputerActionEntry';
import { ComputerManualControlsView } from './ComputerManualControlsView';
import { type ComputerDialogModel } from './types';
export function ComputerScreenView(model: ComputerDialogModel) {
  const {
    panel,
    lifecyclePending,
    setPanel,
    machine,
    conversationId,
    conversationTitle,
    refresh,
    controlled,
    screenReady,
    takeoverSupported,
    canManage,
    computer,
    busy,
    inputBusy,
    otherControlled,
    permissionBusy,
    checkComputer,
    selectSurface,
    agent,
    isDesktop,
    desktopLabel,
    remaining,
    virtualDesktop,
    finish,
    startTakeover,
    pointerMode,
    dragStart,
    setDragStart,
    zoomed,
    shot,
    bindScreenImage,
    clickScreen,
    setShotSize,
    shotSize,
    desktopScreenLabel,
    shotAt,
    shotError,
    controlError,
    autoRefresh,
    observingWork,
    setZoomed,
    setAutoRefresh,
    loading,
    screenshot,
    manual,
    url,
    run,
    scope,
    setUrl,
    setPointerMode,
    inputText,
    setInputText,
    visibleActions,
    identity,
    preparing,
    decideAction,
  } = model;
  const privateControlsPaused = controlled && model.privateFramesPaused.current;
  return (
    <>
      <div className="computer-main">
        <div
          className="computer-panel-tabs"
          role="tablist"
          aria-label={uiText('computer:text_5802516f1e10')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'screen'}
            disabled={lifecyclePending}
            onClick={() => setPanel('screen')}
          >
            <Monitor size={15} />
            {uiText('computer:text_fd9f1c90bafd')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'files'}
            disabled={lifecyclePending}
            onClick={() => setPanel('files')}
          >
            <FolderOpen size={15} />
            {uiText('computer:text_39932f24fe11')}
          </button>
        </div>
        {panel === 'files' ? (
          <>
            <ComputerFiles
              computer={machine}
              conversationId={conversationId}
              conversationTitle={conversationTitle}
              refresh={refresh}
            />
            {controlled && <p className="field-help">{uiText('computer:text_6949d6612f17')}</p>}
          </>
        ) : (
          <>
            {screenReady &&
            canManage &&
            (!computer.botScreen?.shared ||
              computer.desktop?.kind === 'virtual' ||
              computer.capabilities?.includes(HOST_DESKTOP_CAPABILITY)) ? (
              <ComputerSurface
                computer={computer}
                busy={busy || inputBusy || otherControlled}
                checking={permissionBusy}
                onCheck={() => void checkComputer()}
                onSelect={(surface) => void selectSurface(surface)}
              />
            ) : !computer.botScreen?.shared ? (
              <p className="field-help">{uiText('computer:text_ed1e4dc0d3d2')}</p>
            ) : null}
            <div className={`takeover-bar ${controlled ? 'active' : ''}`}>
              <div>
                <span className="takeover-icon">
                  {controlled ? <MousePointer2 size={17} /> : <Monitor size={17} />}
                </span>
                <span>
                  <strong>
                    {controlled
                      ? uiText('computer:text_bfaeb5bee9a3', {
                          value0: agent?.name || uiText('computer:text_35c684d6c7d5'),
                        })
                      : otherControlled
                        ? uiText('computer:text_e7b63cee323f')
                        : isDesktop
                          ? desktopLabel
                          : uiText('computer:text_082ae2a4f29e')}
                  </strong>
                  <small>
                    {controlled
                      ? uiText('computer:text_1ace1ac9ac66', {
                          value0: Math.floor(remaining / 60),
                          value1: String(remaining % 60).padStart(2, '0'),
                        })
                      : otherControlled
                        ? uiText('computer:text_82a81f402464')
                        : isDesktop && virtualDesktop
                          ? uiText('computer:text_7bbae4594070')
                          : uiText('computer:text_842cb7642c0f')}
                  </small>
                </span>
              </div>
              {controlled ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={inputBusy}
                  onClick={() => void finish()}
                >
                  <Square size={12} />
                  {uiText('computer:text_a9f1c3ef5a66')}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    inputBusy ||
                    busy ||
                    !screenReady ||
                    !takeoverSupported ||
                    otherControlled ||
                    (isDesktop && !computer.desktop?.authorized)
                  }
                  onClick={() => void startTakeover()}
                >
                  {inputBusy ? <Loader2 className="spin" size={14} /> : <MousePointer2 size={14} />}
                  {inputBusy
                    ? uiText('computer:text_a9b5182570b7')
                    : uiText('computer:text_692f577ab078')}
                </button>
              )}
            </div>
            {controlled && (
              <p className="takeover-help">
                {uiText(
                  privateControlsPaused
                    ? 'computer:privateTakeoverMasked'
                    : 'computer:privateTakeoverVisible',
                )}
                <br />
                {isDesktop
                  ? uiText('computer:text_d4815a3cec83', {
                      value0: virtualDesktop
                        ? uiText('computer:text_c255841f6809')
                        : uiText('computer:text_d57d9bd74319'),
                    })
                  : uiText('computer:text_a56d6e1de743')}
              </p>
            )}
            {screenReady && !controlled && !otherControlled && !takeoverSupported && (
              <p className="takeover-help">{uiText('computer:privateTakeoverUnsupported')}</p>
            )}
            {controlled && isDesktop && pointerMode === 'drag' && (
              <p className="drag-screen-status">
                {dragStart
                  ? uiText('computer:text_56ef884058ac')
                  : uiText('computer:text_610861579c5d')}
                {dragStart && (
                  <button type="button" className="text-button" onClick={() => setDragStart(null)}>
                    {uiText('computer:text_2cd0f3be8738')}
                  </button>
                )}
              </p>
            )}
            <div
              className={`computer-screen ${controlled ? 'screen-interactive' : ''} ${inputBusy ? 'screen-busy' : ''} ${zoomed ? 'screen-zoomed' : ''}`}
            >
              {shot ? (
                <img
                  ref={bindScreenImage}
                  src={shot}
                  onClick={clickScreen}
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    setShotSize((previous) =>
                      previous.width === img.naturalWidth && previous.height === img.naturalHeight
                        ? previous
                        : { width: img.naturalWidth, height: img.naturalHeight },
                    );
                  }}
                  style={
                    zoomed
                      ? { width: shotSize.width, height: shotSize.height, maxWidth: 'none' }
                      : undefined
                  }
                  draggable={false}
                  alt={uiText('computer:text_d5100b156f36', {
                    value0: isDesktop ? desktopScreenLabel : uiText('computer:text_162f582e1060'),
                    value1: shotAt
                      ? new Date(shotAt).toLocaleString(currentLanguage())
                      : uiText('computer:text_65c9b80829a8'),
                  })}
                  aria-label={
                    controlled
                      ? uiText('computer:text_47e7fe66f2fd')
                      : isDesktop
                        ? uiText('computer:text_079c351fa169', { value0: desktopScreenLabel })
                        : uiText('computer:text_2a55c898bfd9')
                  }
                />
              ) : (
                <div className="computer-screen-empty">
                  <Monitor size={40} />
                  <h3>
                    {agent
                      ? uiText('computer:text_60e92744fead', { value0: agent.name })
                      : uiText('computer:text_aca0cc6f14ba')}
                  </h3>
                  <p>
                    {(otherControlled ? uiText('computer:privateTakeoverMasked') : shotError) ||
                      (!screenReady
                        ? serviceText(computer.botScreen?.reason || computer.status)
                        : isDesktop
                          ? uiText('computer:text_111793f7f6ed', {
                              value0: virtualDesktop
                                ? uiText('computer:text_33491e07b151')
                                : uiText('computer:text_efa898a02a2d'),
                            })
                          : uiText('computer:text_3c2deab96981'))}
                  </p>
                  <span>
                    {computer.connected
                      ? uiText('computer:text_9011c8748978')
                      : uiText('computer:text_cc5e9da32ca6')}
                  </span>
                </div>
              )}
              {controlled && inputBusy && (
                <span className="screen-working">
                  <Loader2 size={15} className="spin" />
                  {uiText('computer:text_95967c3c6231')}
                </span>
              )}
            </div>
            {shotError && (
              <div className="screenshot-error" role="alert">
                <Info size={14} />
                <span>
                  {shotError}
                  {shot && <small>{uiText('computer:text_8030b2ffbc69')}</small>}
                </span>
              </div>
            )}
            {controlError && (
              <div className="screenshot-error" role="alert">
                <Info size={14} />
                <span>{controlError}</span>
              </div>
            )}
            {shotAt && (
              <p className="screenshot-timestamp">
                {uiText('computer:text_e3576b511c1d')}
                {new Date(shotAt).toLocaleString(currentLanguage(), { hour12: false })} ·{' '}
                {(controlled || observingWork) && autoRefresh
                  ? uiText('computer:text_52bedba79dac')
                  : uiText('computer:text_6e487586e277')}
              </p>
            )}
            {zoomed && (
              <p className="screen-zoom-hint">
                {uiText('computer:text_ea943bd68ec4')}
                {controlled
                  ? uiText('computer:text_c56fe839dd3d')
                  : uiText('common:punct_eb0d5884569b')}
              </p>
            )}
            <div className="computer-screen-toolbar">
              <span>
                <span className={`tiny-dot ${computer.connected ? '' : 'disconnected'}`} />
                {computer.connected
                  ? uiText('computer:text_5be0323e8adc')
                  : uiText('computer:text_3d52574ce150')}{' '}
                ·{' '}
                {uiText(
                  `computer:location_${computer.executionLocation ?? (computer.mode === 'local' ? 'server' : 'remote')}`,
                )}
              </span>
              <div>
                <button
                  type="button"
                  className="text-button"
                  disabled={!shot}
                  aria-pressed={zoomed}
                  onClick={() => setZoomed((v) => !v)}
                >
                  {zoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  {zoomed
                    ? uiText('computer:text_f8d01c881e34')
                    : uiText('computer:text_7527e6d25083')}
                </button>
                {(controlled || observingWork) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setAutoRefresh((v) => !v)}
                  >
                    {autoRefresh ? <Pause size={12} /> : <Play size={12} />}
                    {autoRefresh
                      ? uiText('computer:text_946056013d7e')
                      : uiText('computer:text_98073e15fa03')}
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    loading || !screenReady || inputBusy || otherControlled || privateControlsPaused
                  }
                  onClick={() => void screenshot()}
                >
                  {loading ? <Loader2 size={13} className="spin" /> : <Image size={13} />}
                  {uiText('computer:text_efb382b0a626')}
                </button>
              </div>
            </div>
            {!isDesktop && (
              <form
                className="browser-address"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (controlled) void manual({ type: 'navigate', url });
                  else
                    void run(
                      () => scope.request('/actions', 'POST', { type: 'browser_navigate', url }),
                      uiText('computer:text_1780a32a367e'),
                    );
                }}
              >
                <span>
                  <Monitor size={15} />
                </span>
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-label={uiText('computer:text_9469779864de')}
                  placeholder="https://"
                />
                <button
                  className="primary-button"
                  disabled={
                    busy || inputBusy || !screenReady || otherControlled || privateControlsPaused
                  }
                >
                  {uiText('computer:text_bdc799e5677d')}
                  <ArrowUp size={14} />
                </button>
              </form>
            )}
            {controlled && (
              <ComputerManualControlsView
                {...model}
                inputBusy={inputBusy || model.teachingBlocked || privateControlsPaused}
              />
            )}
          </>
        )}
        <div className="computer-activity">
          <div className="section-label">
            {panel === 'files'
              ? uiText('computer:text_3664a60c71b4')
              : uiText('computer:text_c9cf30817de5')}
            {panel === 'screen' && controlled && (
              <small>{uiText('computer:text_c857393e5358')}</small>
            )}
          </div>
          {!visibleActions.length ? (
            <p className="field-help">
              {panel === 'files'
                ? uiText('computer:text_7e98d07f81a5')
                : uiText('computer:text_d7eb35977617')}
            </p>
          ) : (
            visibleActions
              .slice()
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .slice(0, 12)
              .map((a) => (
                <ComputerActionEntry
                  key={a.id}
                  action={a}
                  owner={canManage}
                  userId={identity.current.userId}
                  busy={busy || inputBusy || preparing}
                  controlled={controlled || otherControlled || (panel === 'screen' && !screenReady)}
                  onReject={() => void decideAction(a.id, false)}
                  onApprove={() => void decideAction(a.id, true)}
                />
              ))
          )}
        </div>
      </div>
    </>
  );
}
