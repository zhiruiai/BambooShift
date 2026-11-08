import { currentLanguage } from '../i18n';
import { uiText } from '../i18n';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, Maximize2 } from 'lucide-react';
import { workspaceApiUrl } from '../workspace-scope';
import { Dialog } from './UI';
import './ComputerFrame.css';

type Frame = {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  mimeType: 'image/webp';
};

function frameTime(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!parts) return false;
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function computerFrameMetadata(value: unknown): Frame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (
    typeof frame.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(frame.id) ||
    frame.mimeType !== 'image/webp' ||
    !frameTime(frame.createdAt) ||
    typeof frame.width !== 'number' ||
    typeof frame.height !== 'number' ||
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width > 32768 ||
    frame.height > 32768 ||
    frame.width * frame.height > 67108864
  )
    return null;
  return {
    id: frame.id,
    createdAt: frame.createdAt,
    width: frame.width,
    height: frame.height,
    mimeType: 'image/webp',
  };
}

function FrameUnavailable({ children }: { children: string }) {
  return (
    <div className="computer-frame-unavailable" role="status">
      <ImageOff size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function ComputerFrame({ frame, unavailable }: { frame?: unknown; unavailable?: unknown }) {
  const metadata = computerFrameMetadata(frame);
  if (!metadata) {
    if (typeof unavailable === 'string' && unavailable.trim())
      return (
        <FrameUnavailable>
          {uiText('computer:text_fbf31a4d24d2', { value0: unavailable.trim().slice(0, 240) })}
        </FrameUnavailable>
      );
    if (frame != null)
      return <FrameUnavailable>{uiText('computer:text_54f2c99dcb03')}</FrameUnavailable>;
    return null;
  }
  const url = workspaceApiUrl(`/api/computer/frames/${metadata.id}`);
  return <SavedComputerFrame key={url} frame={metadata} url={url} />;
}

function SavedComputerFrame({ frame, url }: { frame: Frame; url: string }) {
  const [open, setOpen] = useState(false),
    [failed, setFailed] = useState(false);
  const capturedTime = new Intl.DateTimeFormat(currentLanguage(), {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(frame.createdAt));
  const label = uiText('computer:text_0f0d555ec6ed', { value0: capturedTime });
  const failure = uiText('computer:text_61facf6d08cf');
  const picture = (expanded: boolean) => (
    <img
      src={url}
      alt={uiText('computer:text_f0bcbc228bd7', { value0: label })}
      width={frame.width}
      height={frame.height}
      loading="lazy"
      decoding="async"
      className={expanded ? 'computer-frame-full' : 'computer-frame-thumbnail'}
      onError={() => setFailed(true)}
    />
  );
  return (
    <figure className="computer-frame">
      <div
        className="computer-frame-preview"
        style={{ aspectRatio: `${frame.width}/${frame.height}` }}
      >
        {failed ? (
          <FrameUnavailable>{failure}</FrameUnavailable>
        ) : (
          <button
            type="button"
            className="computer-frame-open"
            aria-label={uiText('computer:text_7617d58bd357', { value0: label })}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            {picture(false)}
            <span className="computer-frame-expand" aria-hidden="true">
              <Maximize2 size={13} />
              {uiText('computer:text_80f8fbcfa011')}
            </span>
          </button>
        )}
      </div>
      <figcaption>
        <span>
          {uiText('computer:text_c5c74e22f7b2')}
          <time dateTime={frame.createdAt}>
            {capturedTime}
            {uiText('computer:text_0a17ae0c291a')}
          </time>
        </span>
        <small>{uiText('computer:text_cfaac338c92b')}</small>
      </figcaption>
      {open &&
        createPortal(
          <Dialog
            title={uiText('computer:text_a264c5dcc640')}
            subtitle={uiText('computer:text_3ab80b63b30c', { value0: capturedTime })}
            onClose={() => setOpen(false)}
            wide
            className="computer-frame-dialog"
          >
            {failed ? (
              <FrameUnavailable>{failure}</FrameUnavailable>
            ) : (
              <div
                className="computer-frame-scroll"
                role="region"
                aria-label={uiText('computer:text_909feb863228')}
                tabIndex={0}
              >
                {picture(true)}
              </div>
            )}
            <p className="computer-frame-note">{uiText('computer:text_c476ea7315ad')}</p>
          </Dialog>,
          document.body,
        )}
    </figure>
  );
}
