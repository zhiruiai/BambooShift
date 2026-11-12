import { useState } from 'react';
import { uiText, type UiTextKey } from '../../i18n';
import {
  MAX_MCP_IMPORT_LENGTH,
  parseRemoteMcpImport,
  type RemoteMcpCandidate,
} from '../../remoteMcpImport';
import './RemoteMcpImport.css';

const errorKeys = {
  json: 'workspace:mcpImportInvalidJson',
  shape: 'workspace:mcpImportInvalidShape',
  size: 'workspace:mcpImportTooLarge',
  count: 'workspace:mcpImportTooMany',
  empty: 'workspace:mcpImportNoRemote',
} satisfies Record<string, UiTextKey>;

export function RemoteMcpImport({
  disabled,
  hasDraft,
  onApply,
}: {
  disabled: boolean;
  hasDraft: boolean;
  onApply: (candidate: RemoteMcpCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [candidates, setCandidates] = useState<RemoteMcpCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<UiTextKey>();
  const [replace, setReplace] = useState(false);
  function cancel() {
    setOpen(false);
    setSource('');
    setCandidates([]);
    setSelected('');
    setError(undefined);
    setReplace(false);
  }
  function inspect() {
    if (disabled) return;
    const result = parseRemoteMcpImport(source);
    // Pasted configuration may contain secrets. Keep only the parser's safe projection.
    setSource('');
    setSelected('');
    setReplace(false);
    if (!result.ok) {
      setCandidates([]);
      setError(errorKeys[result.reason]);
      return;
    }
    setError(undefined);
    setCandidates(result.candidates);
    setSkipped(result.skipped);
  }
  function apply() {
    const candidate = candidates.find((entry) => entry.url === selected);
    if (disabled || !candidate) return;
    if (hasDraft && !replace) {
      setReplace(true);
      return;
    }
    onApply(candidate);
    cancel();
  }
  if (!open)
    return (
      <button
        type="button"
        className="secondary-button apps-import-open"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {uiText('workspace:mcpImportOpen')}
      </button>
    );
  return (
    <section className="apps-mcp-import" aria-label={uiText('workspace:mcpImportOpen')}>
      <p className="field-help">{uiText('workspace:mcpImportHelp')}</p>
      {error && <p role="alert">{uiText(error)}</p>}
      {candidates.length ? (
        <>
          <label>
            {uiText('workspace:mcpImportChoose')}
            <select
              aria-label={uiText('workspace:mcpImportChoose')}
              value={selected}
              disabled={disabled}
              onChange={(event) => {
                setSelected(event.target.value);
                setReplace(false);
              }}
            >
              <option value="">{uiText('workspace:mcpImportChoosePlaceholder')}</option>
              {candidates.map((candidate) => (
                <option key={candidate.url} value={candidate.url}>
                  {candidate.name} — {candidate.url}
                </option>
              ))}
            </select>
          </label>
          {selected && <p className="apps-import-address">{selected}</p>}
          {skipped > 0 && (
            <p className="field-help">{uiText('workspace:mcpImportSkipped', { count: skipped })}</p>
          )}
          {replace && <p role="status">{uiText('workspace:mcpImportReplaceHelp')}</p>}
        </>
      ) : (
        <label>
          {uiText('workspace:mcpImportJson')}
          <textarea
            value={source}
            maxLength={MAX_MCP_IMPORT_LENGTH}
            rows={5}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setSource(event.target.value);
              setError(undefined);
            }}
          />
        </label>
      )}
      <div className="apps-import-actions">
        <button type="button" className="secondary-button" disabled={disabled} onClick={cancel}>
          {uiText('workspace:mcpImportCancel')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || (!candidates.length ? !source.trim() : !selected)}
          onClick={candidates.length ? apply : inspect}
        >
          {uiText(
            candidates.length
              ? replace
                ? 'workspace:mcpImportReplace'
                : 'workspace:mcpImportApply'
              : 'workspace:mcpImportInspect',
          )}
        </button>
      </div>
    </section>
  );
}
