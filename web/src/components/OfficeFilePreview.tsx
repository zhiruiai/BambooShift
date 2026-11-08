import { useEffect, useState } from 'react';
import { uiText } from '../i18n';
import {
  readOfficeFilePreview,
  type OfficePreview,
  type OfficePreviewBlock,
  type OfficePreviewFormat,
} from '../officeFilePreview';
import './OfficeFilePreview.css';

type Props = { bytes: Uint8Array; format: OfficePreviewFormat };
type Result = Props & { preview?: OfficePreview };

function Table({ rows, columns }: Extract<OfficePreviewBlock, { kind: 'table' }>) {
  return (
    <div className="office-preview-table">
      <table>
        {columns && (
          <thead>
            <tr>
              <td aria-hidden="true" />
              {columns.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.number !== undefined && <th scope="row">{row.number}</th>}
              {row.cells.map((cell, position) => (
                <td key={position}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OfficeFilePreview({ bytes, format }: Props) {
  const [result, setResult] = useState<Result>();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setIndex(0);
    void readOfficeFilePreview(bytes, format, signal).then(
      (preview) => {
        if (!signal.aborted) setResult({ bytes, format, preview });
      },
      () => {
        if (!signal.aborted) setResult({ bytes, format });
      },
    );
    return () => controller.abort();
  }, [bytes, format]);
  if (!result || result.bytes !== bytes || result.format !== format) {
    return <p role="status">{uiText('workspace:filePreviewLoading')}</p>;
  }
  const { preview } = result;
  if (!preview) return <p role="alert">{uiText('workspace:filePreviewError_type')}</p>;
  const { pages, limited } = preview;
  const current = pages[index] ?? pages[0];
  const label = (page: (typeof pages)[number]) =>
    page.name ||
    uiText(
      format === 'xlsx' ? 'workspace:filePreviewOfficeSheet' : 'workspace:filePreviewOfficeSlide',
      {
        number: page.number,
      },
    );
  const visible = current?.blocks.filter(
    (block) => block.kind === 'paragraph' || block.rows.length,
  );
  return (
    <div className="office-preview">
      <p className="office-preview-note">
        {uiText(limited ? 'workspace:filePreviewOfficePartial' : 'workspace:filePreviewOfficeNote')}
      </p>
      {pages.length > 1 && (
        <nav className="office-preview-pages" aria-label={uiText('workspace:filePreviewMode')}>
          {pages.map((page, position) => (
            <button
              type="button"
              key={page.number}
              aria-current={current === page ? 'page' : undefined}
              onClick={() => setIndex(position)}
            >
              {label(page)}
            </button>
          ))}
        </nav>
      )}
      {current && format !== 'docx' && <h3>{label(current)}</h3>}
      {visible?.length ? (
        visible.map((block, position) =>
          block.kind === 'paragraph' ? (
            <p key={position}>{block.text}</p>
          ) : (
            <Table key={position} {...block} />
          ),
        )
      ) : (
        <p>{uiText('workspace:filePreviewOfficeEmpty')}</p>
      )}
    </div>
  );
}
