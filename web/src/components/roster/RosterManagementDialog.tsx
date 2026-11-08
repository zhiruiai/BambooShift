import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import {
  SIDEBAR_MAX_SECTION_NAME,
  type SidebarRosterOperation,
  type SidebarRosterState,
} from '../../../../shared/sidebar-roster';
import { createPrimaryBotScope } from '../../primaryBot';
import { projectSidebar, rosterEntry } from '../../sidebarRoster';
import { Avatar, GroupAvatar } from '../Avatar';
import '../SidebarRoster.css';
import { Dialog } from '../UI';
import { DialogProps } from './types';
export function RosterManagementDialog(props: DialogProps) {
  return (
    <RosterDialogContent
      key={`${props.userId}:${props.workspaceId}:${JSON.stringify(props.request)}`}
      {...props}
    />
  );
}
export function RosterDialogContent(props: DialogProps) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const request = props.request;
  const [base, setBase] = useState(props.roster.state),
    [name, setName] = useState(
      request.kind === 'rename'
        ? props.roster.state?.sections.find((section) => section.id === request.id)?.name || ''
        : '',
    ),
    [sectionId, setSectionId] = useState(
      request.kind === 'move'
        ? rosterEntry(props.roster.state, request.target).sectionId || ''
        : '',
    );
  const [error, setError] = useState(''),
    [review, setReview] = useState(false),
    [observed, setObserved] = useState<SidebarRosterState>(),
    [leave, setLeave] = useState(false),
    [localBusy, setLocalBusy] = useState(false);
  const running = useRef(false);
  const initialName =
      request.kind === 'rename'
        ? base?.sections.find((section) => section.id === request.id)?.name || ''
        : '',
    initialSection =
      request.kind === 'move' ? rosterEntry(base, request.target).sectionId || '' : '';
  const dirty =
      request.kind === 'create' || request.kind === 'rename'
        ? name !== initialName
        : request.kind === 'move'
          ? sectionId !== initialSection
          : false,
    locked = localBusy || props.roster.busy;
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  const current = () => scope.current(scope.ticket());
  function close() {
    if (!current() || running.current) return;
    if (dirty) setLeave(true);
    else props.onClose();
  }
  async function read() {
    if (!current() || running.current) return;
    running.current = true;
    setLocalBusy(true);
    setError('');
    const value = await props.roster.read();
    if (current()) {
      if (value) setObserved(value);
      setLocalBusy(false);
    }
    running.current = false;
  }
  async function save() {
    if (
      !current() ||
      running.current ||
      locked ||
      review ||
      props.roster.needsSync ||
      !base ||
      request.kind === 'hidden'
    )
      return;
    const cleaned = name.trim();
    if (
      (request.kind === 'create' || request.kind === 'rename') &&
      (!cleaned ||
        cleaned.length > SIDEBAR_MAX_SECTION_NAME ||
        /[\u0000-\u001f\u007f\u2028\u2029]/.test(cleaned))
    ) {
      setError(uiText('common:text_7885cc8a6b94'));
      return;
    }
    const operation: SidebarRosterOperation =
      request.kind === 'create'
        ? {
            type: 'create-section',
            name: cleaned,
            ...(request.target ? { target: request.target } : {}),
          }
        : request.kind === 'rename'
          ? { type: 'rename-section', id: request.id, name: cleaned }
          : request.kind === 'delete'
            ? { type: 'delete-section', id: request.id }
            : { type: 'set-entry', target: request.target, sectionId: sectionId || null };
    running.current = true;
    setLocalBusy(true);
    setError('');
    const result = await props.roster.write(operation, base.revision);
    if (current()) {
      if (result.ok) {
        props.onNotice(
          request.kind === 'delete'
            ? uiText('common:text_e6cad65b264b')
            : uiText('common:text_b44666ba544f'),
        );
        props.onClose();
      } else {
        setError(result.message);
        setReview(result.review);
      }
      setLocalBusy(false);
    }
    running.current = false;
  }
  const hidden = projectSidebar(props.data).hidden;
  const title =
    request.kind === 'hidden'
      ? uiText('common:text_e41a8d33f36c')
      : request.kind === 'create'
        ? uiText('common:text_a810d51d0baa')
        : request.kind === 'rename'
          ? uiText('common:text_ad87505cb7d7')
          : request.kind === 'delete'
            ? uiText('common:text_1360fe153f81')
            : uiText('common:text_6b4122942500');
  const sectionExists =
    (request.kind === 'rename' || request.kind === 'delete') &&
    base &&
    !base.sections.some((section) => section.id === request.id);
  const duplicate =
    (request.kind === 'create' || request.kind === 'rename') &&
    base?.sections.some(
      (section) =>
        section.name.toLowerCase() === name.trim().toLowerCase() &&
        (request.kind !== 'rename' || section.id !== request.id),
    );
  return (
    <Dialog
      title={title}
      subtitle={uiText('common:text_cae176daac5b')}
      className="roster-dialog"
      onClose={close}
    >
      {request.kind === 'hidden' ? (
        <>
          {hidden.length ? (
            hidden.map((item) => {
              const conversation = item.conversation,
                agents = props.data.agents.filter((agent) =>
                  conversation.agentIds.includes(agent.id),
                );
              return (
                <div className="roster-hidden-row" key={`${item.target.kind}:${item.target.id}`}>
                  {conversation.isGroup ? (
                    <GroupAvatar agents={agents} size={37} />
                  ) : (
                    <Avatar agent={agents[0]} size={37} />
                  )}
                  <span>
                    <strong>
                      {conversation.title}
                      {item.primary && (
                        <small className="primary-bot-badge">
                          {uiText('common:text_33bc0375810d')}
                        </small>
                      )}
                    </strong>
                    <small>
                      {item.target.kind === 'bot'
                        ? uiText('common:text_d0b4288477a7')
                        : uiText('common:text_c117104ac9be')}{' '}
                      {uiText('common:text_59820f127e04')}
                    </small>
                  </span>
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        if (current()) {
                          props.onOpen(conversation);
                          props.onClose();
                        }
                      }}
                    >
                      {uiText('common:text_0ca06fc30628')}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={locked || !props.roster.state || props.roster.needsSync}
                      onClick={async () => {
                        if (!current() || running.current) return;
                        running.current = true;
                        setLocalBusy(true);
                        const result = await props.roster.write({
                          type: 'set-entry',
                          target: item.target,
                          hidden: false,
                        });
                        if (current()) {
                          if (!result.ok) setError(result.message);
                          else props.onNotice(uiText('common:text_12f3d007b8e1'));
                          setLocalBusy(false);
                        }
                        running.current = false;
                      }}
                    >
                      {uiText('common:text_e0534b8a4e46')}
                    </button>
                    {item.primary && (
                      <button
                        type="button"
                        className="roster-text-button"
                        onClick={() => {
                          if (current()) props.onPrimary();
                        }}
                      >
                        {uiText('common:text_938012235b4b')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="field-help">{uiText('common:text_d1fc43eaaa62')}</p>
          )}
          <p className="field-help">{uiText('common:text_390562c6ebcc')}</p>
        </>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {(request.kind === 'create' || request.kind === 'rename') && (
            <label>
              {uiText('common:text_812fc897aa6d')}
              <input
                value={name}
                maxLength={SIDEBAR_MAX_SECTION_NAME}
                disabled={locked || review}
                onChange={(event) => setName(event.target.value)}
                placeholder={uiText('common:text_41515a3e45f5')}
                autoFocus
              />
            </label>
          )}
          {request.kind === 'move' && (
            <>
              <label>
                {uiText('common:text_bfffd330a948')}
                <select
                  value={sectionId}
                  disabled={locked || review}
                  onChange={(event) => setSectionId(event.target.value)}
                >
                  <option value="">{uiText('common:text_e86ea3f280d9')}</option>
                  {base?.sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-help">{uiText('common:text_3d61a6f48ba6')}</p>
            </>
          )}
          {request.kind === 'delete' && (
            <div className="bot-form-notice">
              <strong>
                {uiText('common:text_9fad3beb4471')}
                {base?.sections.find((section) => section.id === request.id)?.name ||
                  uiText('common:text_2abc4623bc7c')}
                {uiText('common:punct_a33706e414ed')}
              </strong>
              <p>{uiText('common:text_3cf93d04c87d')}</p>
            </div>
          )}
          {duplicate && <p className="field-help">{uiText('common:text_3eee4c4d8b90')}</p>}
          {sectionExists && <p className="error-text">{uiText('common:text_a98334476e77')}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={locked} onClick={close}>
              {uiText('common:text_2cd0f3be8738')}
            </button>
            <button
              className="primary-button"
              disabled={
                locked ||
                review ||
                props.roster.needsSync ||
                !base ||
                !!duplicate ||
                !!sectionExists
              }
            >
              {request.kind === 'delete'
                ? uiText('common:text_d7623c23f804')
                : request.kind === 'create'
                  ? uiText('common:text_87a68ca61e18')
                  : uiText('common:text_a3030bf8f16d')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {(review || props.roster.needsSync) && (
        <div className="bot-form-notice">
          <p>{uiText('common:text_efd2f172c044')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={() => void read()}
          >
            {uiText('common:text_65b1ed7d2e28')}
          </button>
          {observed && (
            <>
              <p>{uiText('common:text_a611192905d8')}</p>
              <button
                type="button"
                className="secondary-button"
                disabled={locked}
                onClick={() => {
                  if (!current()) return;
                  setBase(observed);
                  setReview(false);
                  setObserved(undefined);
                  setError('');
                }}
              >
                {uiText('common:text_ee8704d07cc4')}
              </button>
            </>
          )}
        </div>
      )}
      {leave && (
        <div className="bot-form-notice" role="alert">
          <p>{uiText('common:text_e23537a22162')}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setLeave(false)}>
              {uiText('common:text_fd4b9e3b6c68')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                if (current() && !running.current) props.onClose();
              }}
            >
              {uiText('common:text_17f1ff1b24ca')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
