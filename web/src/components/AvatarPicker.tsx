import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, Loader2, RotateCcw } from 'lucide-react';
import { botColors, botShapes, botShapeNames, type BotProfileDraft } from '../botProfiles';
import {
  avatarActivity,
  constrainCrop,
  createAvatarEditor,
  cropPixels,
  initialCropView,
  type AvatarEditActivity,
  type AvatarEditorState,
} from '../avatarImages';
import { Avatar } from './Avatar';
import './AvatarPicker.css';

type Props = {
  draft: BotProfileDraft;
  disabled?: boolean;
  workspaceId?: string;
  userId?: string;
  onChange: (patch: Partial<BotProfileDraft>) => void;
  onActivity?: (state: AvatarEditActivity) => void;
};
export function AvatarPicker(props: Props) {
  return <AvatarPickerContent key={`${props.userId}:${props.workspaceId}`} {...props} />;
}
function AvatarPickerContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [tab, setTab] = useState<'original' | 'upload'>(
    props.draft.avatarImageId ? 'upload' : 'original',
  );
  const [state, setState] = useState<AvatarEditorState>({ phase: 'idle' }),
    [view, setView] = useState(initialCropView),
    [discard, setDiscard] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    frame = useRef<HTMLDivElement>(null),
    drag = useRef<{ pointerId: number; x: number; y: number; start: typeof view } | null>(null);
  const [editor] = useState(() =>
    createAvatarEditor({
      ...props,
      identity: () => latest.current,
      enabled: () => !latest.current.disabled,
      onState(value) {
        setState(value);
        latest.current.onActivity?.(avatarActivity(value));
        if (value.phase === 'editing')
          setView((previous) => constrainCrop(value.source!.width, value.source!.height, previous));
      },
      onAsset(asset) {
        latest.current.onChange({ avatarImageId: asset.id });
      },
    }),
  );
  useEffect(() => {
    editor.resume();
    return () => {
      editor.suspend();
      latest.current.onActivity?.({ pending: false, busy: false });
    };
  }, [editor]);
  const activity = avatarActivity(state),
    locked = !!props.disabled || activity.busy;
  function cancel() {
    drag.current = null;
    editor.cancel();
    setDiscard(false);
    setView(initialCropView());
  }
  function original() {
    if (locked) return;
    if (activity.pending) {
      setDiscard(true);
      return;
    }
    editor.cancel();
    setTab('original');
    latest.current.onChange({ avatarImageId: null });
  }
  function select(files: FileList | File[] | null) {
    if (props.disabled || !files?.length) return;
    setTab('upload');
    setView(initialCropView());
    setDiscard(false);
    drag.current = null;
    void editor.select(files[0]);
  }
  function move(next: typeof view) {
    if (!state.source || locked) return;
    setView(constrainCrop(state.source.width, state.source.height, next));
  }
  const source = state.source,
    ratio = source ? Math.min(source.width, source.height) : 1;
  return (
    <div className="bot-avatar-picker">
      <div
        className="avatar-picker-tabs"
        role="tablist"
        aria-label={uiText('common:text_3432fa8a8ce8')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'original'}
          disabled={locked}
          onClick={original}
        >
          {uiText('common:text_a244b5a62ed9')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'upload'}
          disabled={locked}
          onClick={() => setTab('upload')}
        >
          {uiText('common:text_9fbb4750bb39')}
        </button>
      </div>
      {tab === 'original' ? (
        <div className="avatar-picker bot-identity-picker">
          <Avatar
            key={`${props.draft.avatar}:${props.draft.color}`}
            agent={props.draft}
            size={68}
            motion="preview"
          />
          <div className="avatar-picker-options">
            <p className="field-help">{uiText('common:text_e3b5c7f70826')}</p>
            <div className="color-choices">
              {botColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={props.disabled}
                  aria-label={uiText('common:text_336fee5cdabd', { value0: color })}
                  aria-pressed={props.draft.color === color}
                  className={props.draft.color === color ? 'chosen' : ''}
                  onClick={() => props.onChange({ color, avatarImageId: null })}
                >
                  <span style={{ background: color }}>
                    {props.draft.color === color && <Check size={13} />}
                  </span>
                </button>
              ))}
            </div>
            <div className="shape-choices">
              {botShapes.map((avatar) => (
                <button
                  key={avatar}
                  type="button"
                  disabled={props.disabled}
                  aria-label={uiText('common:text_be7d146c133c', { value0: botShapeNames[avatar] })}
                  aria-pressed={props.draft.avatar === avatar}
                  className={props.draft.avatar === avatar ? 'chosen' : ''}
                  onClick={() => props.onChange({ avatar, avatarImageId: null })}
                >
                  <Avatar agent={{ color: props.draft.color, avatar }} size={29} />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            className="avatar-upload"
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!locked) select(event.dataTransfer.files);
            }}
          >
            <Avatar agent={props.draft} size={64} />
            <div>
              <strong>{uiText('common:text_d44799eac0cd')}</strong>
              <small>{uiText('common:text_1db584c5352b')}</small>
              <button
                type="button"
                className="secondary-button"
                disabled={locked}
                onClick={() => file.current?.click()}
              >
                <ImagePlus size={15} />
                {source || props.draft.avatarImageId
                  ? uiText('common:text_4c5bfb10fc88')
                  : uiText('common:text_9ad12a1ab4f6')}
              </button>
              <span>{uiText('common:text_2dbf9cb1fe93')}</span>
            </div>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={uiText('common:text_7f63a0f093b0')}
              hidden
              disabled={locked}
              onChange={(event) => {
                select(event.target.files);
                event.target.value = '';
              }}
            />
          </div>
          {activity.busy && (
            <p className="avatar-upload-status" role="status">
              <Loader2 size={15} className="spin" />
              {state.phase === 'uploading'
                ? uiText('common:text_66e45c966355')
                : uiText('common:text_550911f43fae')}
              <button type="button" className="secondary-button" onClick={cancel}>
                {uiText('common:text_2cd0f3be8738')}
              </button>
            </p>
          )}
          {source && state.previewUrl && (
            <div className="avatar-crop-editor">
              <div
                ref={frame}
                className="avatar-crop-frame"
                tabIndex={locked ? -1 : 0}
                role="group"
                aria-label={uiText('common:text_d2fd9c3aae62')}
                onPointerDown={(event) => {
                  if (locked || event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    start: view,
                  };
                }}
                onPointerMove={(event) => {
                  const start = drag.current;
                  if (!start || start.pointerId !== event.pointerId || locked) return;
                  const width = event.currentTarget.getBoundingClientRect().width;
                  if (width > 0)
                    move({
                      ...view,
                      x: start.start.x + (event.clientX - start.x) / width,
                      y: start.start.y + (event.clientY - start.y) / width,
                    });
                }}
                onPointerUp={(event) => {
                  if (drag.current?.pointerId === event.pointerId) {
                    drag.current = null;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                }}
                onKeyDown={(event) => {
                  if (locked) return;
                  const step = event.shiftKey ? 0.1 : 0.02;
                  if (
                    ![
                      'ArrowLeft',
                      'ArrowRight',
                      'ArrowUp',
                      'ArrowDown',
                      '+',
                      '=',
                      '-',
                      'Home',
                    ].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  if (event.key === 'Home') move(initialCropView());
                  else if (event.key === '+' || event.key === '=')
                    move({ ...view, zoom: view.zoom + 0.1 });
                  else if (event.key === '-') move({ ...view, zoom: view.zoom - 0.1 });
                  else
                    move({
                      ...view,
                      x:
                        view.x +
                        (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
                      y:
                        view.y +
                        (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
                    });
                }}
              >
                <img
                  src={state.previewUrl}
                  alt={uiText('common:text_6d3d644dbc76')}
                  draggable={false}
                  style={{
                    width: `${(source.width / ratio) * view.zoom * 100}%`,
                    height: `${(source.height / ratio) * view.zoom * 100}%`,
                    left: `${50 + view.x * 100}%`,
                    top: `${50 + view.y * 100}%`,
                  }}
                />
                <span className="avatar-crop-circle" />
              </div>
              <label className="avatar-zoom">
                {uiText('common:text_b762aec769a3')}
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.05}
                  value={view.zoom}
                  aria-valuetext={uiText('common:text_b47846ab4132', {
                    value0: view.zoom.toFixed(2),
                  })}
                  disabled={locked}
                  onChange={(event) => move({ ...view, zoom: Number(event.target.value) })}
                />
              </label>
              <p className="field-help">{uiText('common:text_13e606568d19')}</p>
              <div className="avatar-crop-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => move(initialCropView())}
                >
                  <RotateCcw size={14} />
                  {uiText('common:text_c017d513c029')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={cancel}
                >
                  {uiText('common:text_7c6e92794008')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={locked}
                  onClick={() => void editor.confirm(cropPixels(source.width, source.height, view))}
                >
                  {uiText('common:text_460ae3a78f16')}
                </button>
              </div>
            </div>
          )}
          {state.error && (
            <p className="error-text" role="alert">
              {state.error}
            </p>
          )}
          {state.error && source && (
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={() => void editor.reupload()}
            >
              {uiText('common:text_6c09b627a62c')}
            </button>
          )}
          {state.phase === 'error' && (
            <button type="button" className="secondary-button" onClick={cancel}>
              {uiText('common:text_74966e20df2e')}
            </button>
          )}
          <p className="field-help">{uiText('common:text_5ec4bce1f359')}</p>
        </>
      )}
      {discard && (
        <div className="bot-form-notice" role="alert">
          <p>{uiText('common:text_02e0d63aabd6')}</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setDiscard(false)}>
              {uiText('common:text_a4c57985701d')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                cancel();
                setTab('original');
                latest.current.onChange({ avatarImageId: null });
              }}
            >
              {uiText('common:text_aceb1e720d44')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
