import { uiText } from '../../i18n';
import { Download, FileText } from 'lucide-react';
import { workspaceApiUrl } from '../../workspace-scope';
import { FileCard } from '../FileCard';
import '../ComputerFiles.css';
import { object, transferFileSize } from './types';
export function computerFileDownload(result: unknown): string | undefined {
  const value = object(result);
  if (typeof value.fileId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.fileId))
    return workspaceApiUrl(`/api/files/${value.fileId}/download`);
  if (
    typeof value.downloadUrl === 'string' &&
    /^\/api\/files\/[A-Za-z0-9_-]{1,200}\/download$/.test(value.downloadUrl)
  )
    return workspaceApiUrl(value.downloadUrl);
}
export function ComputerFileSummary({
  type,
  payload,
  result,
}: {
  type: string;
  payload: Record<string, unknown>;
  result?: unknown;
}) {
  const value = object(result),
    download = computerFileDownload(result);
  const name =
    typeof payload.sourceName === 'string'
      ? payload.sourceName
      : typeof value.name === 'string'
        ? value.name
        : typeof payload.path === 'string'
          ? payload.path.split('/').pop() || ''
          : '';
  const path =
    typeof value.path === 'string'
      ? value.path
      : typeof payload.path === 'string'
        ? payload.path
        : '';
  const size =
    typeof value.size === 'number'
      ? value.size
      : typeof payload.size === 'number'
        ? payload.size
        : undefined;
  const resultName = typeof value.name === 'string' && value.name.trim() ? value.name : name;
  return (
    <div className="computer-file-summary">
      {name && !download && (
        <span>
          <FileText size={13} />
          {name}
          {size !== undefined && <small>{transferFileSize(size)}</small>}
        </span>
      )}
      {path && (
        <p>
          {type === 'upload_file'
            ? uiText('computer:text_cf90552e346e')
            : uiText('computer:text_b29e92365875')}
          {uiText('common:punct_f114611cd610')}
          <code>{path}</code>
        </p>
      )}
      {download &&
        (resultName ? (
          <FileCard name={resultName} size={size || 0} href={download} />
        ) : (
          <a className="computer-file-download" href={download} download>
            <Download size={13} />
            {uiText('computer:text_5f097da3c79b')}
          </a>
        ))}
    </div>
  );
}
