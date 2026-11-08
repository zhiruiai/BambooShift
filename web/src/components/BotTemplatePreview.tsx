import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { BotBlueprint } from '../../../shared/bot-blueprint';
import type { BotTemplateSummary } from '../../../shared/bot-templates';
import { routineScheduleLabel } from '../routineLabels';
import {
  fetchBotTemplateAvatar,
  safeTemplateAvatarPath,
  type RoutineInstallMode,
  type TemplateIdentity,
} from '../botTemplates';
import { Avatar } from './Avatar';
import './BotTemplates.css';

export function BotTemplateAvatar({
  blueprint,
  summary,
  avatarPath,
  size = 56,
  workspaceId,
  userId,
  showStatus = false,
}: {
  blueprint?: BotBlueprint;
  summary?: BotTemplateSummary;
  avatarPath?: string;
  size?: number;
  showStatus?: boolean;
} & TemplateIdentity) {
  const url =
    blueprint?.avatar || summary?.avatarPath
      ? safeTemplateAvatarPath(avatarPath || summary?.avatarPath)
      : undefined;
  const identity = `${workspaceId || ''}:${userId || ''}:${url || ''}`;
  const latest = useRef(identity);
  latest.current = identity;
  const [image, setImage] = useState<{ key: string; url: string }>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController(),
      pathname = window.location.pathname;
    let active = true,
      objectUrl: string | undefined;
    void fetchBotTemplateAvatar(url, { workspaceId, userId }, controller.signal)
      .then((blob) => {
        if (!active || latest.current !== identity || window.location.pathname !== pathname) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ key: identity, url: objectUrl });
      })
      .catch(() => {
        if (active && latest.current === identity && window.location.pathname === pathname)
          setFailed(identity);
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, workspaceId, userId]);
  const content =
    image?.key === identity ? (
      <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
        <img
          className="avatar-image"
          src={image.url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => {
            setImage(undefined);
            setFailed(identity);
          }}
        />
      </span>
    ) : (
      <Avatar agent={blueprint?.profile || summary} size={size} />
    );
  return showStatus ? (
    <span className="template-avatar-wrap">
      {content}
      {blueprint?.avatar && (!url || failed === identity) && (
        <small role="status">{uiText('bots:text_62cab5ebabfe')}</small>
      )}
    </span>
  ) : (
    content
  );
}
export function BotTemplatePreview({
  blueprint,
  avatarPath,
  routineMode = 'preserve',
  workspaceId,
  userId,
}: {
  blueprint: BotBlueprint;
  avatarPath?: string;
  routineMode?: RoutineInstallMode;
} & TemplateIdentity) {
  return (
    <section className="bot-template-preview" aria-label={uiText('bots:text_f5144e31acdc')}>
      <div className="bot-settings-preview">
        <BotTemplateAvatar
          blueprint={blueprint}
          avatarPath={avatarPath}
          workspaceId={workspaceId}
          userId={userId}
          showStatus
        />
        <div>
          <h3>{blueprint.profile.name}</h3>
          <p>{blueprint.profile.role}</p>
        </div>
      </div>
      <p className="template-description">
        {blueprint.profile.description || uiText('bots:text_4fa5b0911bab')}
      </p>
      <details className="template-detail" open>
        <summary>{uiText('bots:text_f34d18b15b71')}</summary>
        <pre>{blueprint.profile.instructions || uiText('bots:text_8879608cfc51')}</pre>
      </details>
      <details className="template-detail" open>
        <summary>
          {uiText('bots:text_54df9705548e')}
          {blueprint.skills.length}
          {uiText('bots:text_f9d529eacdf3')}
        </summary>
        <p className="field-help">{uiText('bots:text_aa9b5ca20740')}</p>
        {blueprint.skills.length ? (
          blueprint.skills.map((skill, index) => (
            <details className="template-detail" key={index}>
              <summary>{skill.name}</summary>
              <p>{skill.description}</p>
              <pre>{skill.content}</pre>
            </details>
          ))
        ) : (
          <p className="field-help">{uiText('bots:text_952b6d6d2997')}</p>
        )}
      </details>
      <details className="template-detail" open>
        <summary>
          {uiText('bots:text_bca061ff418f')}
          {blueprint.routines.length}
          {uiText('bots:text_f9d529eacdf3')}
        </summary>
        {blueprint.routines.length ? (
          blueprint.routines.map((routine, index) => (
            <details className="template-detail" key={index}>
              <summary>
                {routine.title}
                <span className="pill skill-muted">
                  {routineMode === 'pause' || !routine.enabled
                    ? uiText('bots:text_de6c55ae2f15')
                    : uiText('bots:text_c00922ba3980')}
                </span>
              </summary>
              <p className="field-help">
                {routineScheduleLabel(routine.schedule, routine.timeZone)}
              </p>
              <pre>{routine.prompt}</pre>
            </details>
          ))
        ) : (
          <p className="field-help">{uiText('bots:text_1211b336c4b4')}</p>
        )}
      </details>
      <p className="bot-form-notice">{uiText('bots:text_f8a304338f45')}</p>
    </section>
  );
}
export function RoutineInstallChoice({
  mode,
  onChange,
  disabled,
  routines,
}: {
  mode: RoutineInstallMode;
  onChange: (value: RoutineInstallMode) => void;
  disabled: boolean;
  routines: BotBlueprint['routines'];
}) {
  if (!routines.length) return null;
  return (
    <label className="template-routine-choice">
      {uiText('bots:text_8983a65a2967')}
      <select
        value={mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as RoutineInstallMode)}
      >
        <option value="pause">{uiText('bots:text_7ee8887b6b88')}</option>
        <option value="preserve">{uiText('bots:text_8a01608a75e1')}</option>
      </select>
      <small>{uiText('bots:text_ecbd3ea906a7')}</small>
    </label>
  );
}
export function BotTemplateEditor({
  value,
  onChange,
  disabled,
}: {
  value: BotBlueprint;
  onChange: (value: BotBlueprint) => void;
  disabled: boolean;
}) {
  const profile = (key: keyof BotBlueprint['profile'], text: string) =>
    onChange({ ...value, profile: { ...value.profile, [key]: text } });
  return (
    <div className="dialog-form template-editor">
      <p className="field-help">{uiText('bots:text_732e4dcdab7c')}</p>
      <label>
        {uiText('bots:text_f7816a356dbc')}
        <input
          value={value.profile.name}
          disabled={disabled}
          maxLength={40}
          onChange={(event) => profile('name', event.target.value)}
        />
      </label>
      <label>
        {uiText('bots:text_447f856340eb')}
        <input
          value={value.profile.role}
          disabled={disabled}
          maxLength={80}
          onChange={(event) => profile('role', event.target.value)}
        />
      </label>
      <label>
        {uiText('bots:text_8131eafd0239')}
        <textarea
          rows={3}
          value={value.profile.description}
          disabled={disabled}
          maxLength={1000}
          onChange={(event) => profile('description', event.target.value)}
        />
      </label>
      <label>
        {uiText('bots:text_f34d18b15b71')}
        <textarea
          rows={7}
          value={value.profile.instructions}
          disabled={disabled}
          maxLength={16000}
          onChange={(event) => profile('instructions', event.target.value)}
        />
      </label>
      {value.avatar && (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => {
            const { avatar: _, ...rest } = value;
            onChange(rest);
          }}
        >
          {uiText('bots:text_f63480b79437')}
        </button>
      )}
      <h3>
        {uiText('bots:text_54df9705548e')}
        {value.skills.length}
        {uiText('bots:text_f9d529eacdf3')}
      </h3>
      {value.skills.map((skill, index) => (
        <details className="template-detail" key={index}>
          <summary>{skill.name}</summary>
          {(['name', 'description', 'content'] as const).map((key) => (
            <label key={key}>
              {key === 'name'
                ? uiText('bots:text_939f41f5c276')
                : key === 'description'
                  ? uiText('bots:text_4262c45dc797')
                  : uiText('bots:text_83b7ea859514')}
              <textarea
                rows={key === 'content' ? 6 : 2}
                value={skill[key]}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    skills: value.skills.map((item, i) =>
                      i === index ? { ...item, [key]: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() =>
              onChange({ ...value, skills: value.skills.filter((_, i) => i !== index) })
            }
          >
            {uiText('bots:text_5b5611ca7107')}
          </button>
        </details>
      ))}
      <h3>
        {uiText('bots:text_bca061ff418f')}
        {value.routines.length}
        {uiText('bots:text_f9d529eacdf3')}
      </h3>
      {value.routines.map((routine, index) => (
        <details className="template-detail" key={index}>
          <summary>{routine.title}</summary>
          <p className="field-help">{routineScheduleLabel(routine.schedule, routine.timeZone)}</p>
          {(['title', 'prompt'] as const).map((key) => (
            <label key={key}>
              {key === 'title'
                ? uiText('bots:text_2479560deb33')
                : uiText('bots:text_2b7e32bffda6')}
              <textarea
                rows={key === 'prompt' ? 5 : 2}
                value={routine[key]}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    routines: value.routines.map((item, i) =>
                      i === index ? { ...item, [key]: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
          ))}
          <label className="template-check">
            <input
              type="checkbox"
              checked={routine.enabled}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  routines: value.routines.map((item, i) =>
                    i === index ? { ...item, enabled: event.target.checked } : item,
                  ),
                })
              }
            />
            {uiText('bots:text_33d58c0fb594')}
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() =>
              onChange({ ...value, routines: value.routines.filter((_, i) => i !== index) })
            }
          >
            {uiText('bots:text_e7c6ce7e9043')}
          </button>
        </details>
      ))}
    </div>
  );
}
