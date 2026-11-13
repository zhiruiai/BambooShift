import { useEffect, useRef, useState } from 'react';
import { uiText, type UiTextKey } from '../../i18n';
import {
  parseRemoteMcpImport,
  readRemoteMcpPreview,
  type RemoteMcpCandidate,
  type RemoteMcpPreview,
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
  draftVersion,
  onInspect,
  onApply,
}: {
  disabled: boolean;
  hasDraft: boolean;
  draftVersion: unknown;
  onInspect: (projection: {
    candidates: RemoteMcpCandidate[];
    skipped: number;
  }) => Promise<RemoteMcpPreview>;
  onApply: (candidate: RemoteMcpCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [candidates, setCandidates] = useState<RemoteMcpCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<UiTextKey>();
  const [replacement, setReplacement] = useState<{ version: unknown }>();
  const replace = !!replacement && Object.is(replacement.version, draftVersion);
  const [inspecting, setInspecting] = useState(false);
  const lifecycle = useRef({
    epoch: 0,
    active: false,
    disabled,
    pending: false,
    hasDraft,
    draftVersion,
  });
  lifecycle.current.disabled = disabled;
  lifecycle.current.hasDraft = hasDraft;
  lifecycle.current.draftVersion = draftVersion;
  const renderEpoch = lifecycle.current.epoch;
  useEffect(
    () => () => {
      lifecycle.current.epoch++;
      lifecycle.current.active = false;
    },
    [],
  );
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  function cancel() {
    lifecycle.current.epoch++;
    lifecycle.current.active = false;
    lifecycle.current.pending = false;
    setOpen(false);
    setSource('');
    setCandidates([]);
    setSelected('');
    setError(undefined);
    setReplacement(undefined);
    setInspecting(false);
  }
  async function inspect() {
    const current = lifecycle.current;
    if (current.disabled || current.pending || !current.active || current.epoch !== renderEpoch)
      return;
    const result = parseRemoteMcpImport(source);
    // Pasted configuration may contain secrets. Keep only the parser's safe projection.
    setSource('');
    setSelected('');
    setReplacement(undefined);
    if (!result.ok) {
      setCandidates([]);
      setError(errorKeys[result.reason]);
      return;
    }
    setError(undefined);
    setCandidates([]);
    const ticket = ++current.epoch;
    current.pending = true;
    setInspecting(true);
    const valid = () => current.active && !current.disabled && current.epoch === ticket;
    try {
      const preview = readRemoteMcpPreview(
        await onInspect({ candidates: result.candidates, skipped: result.skipped }),
      );
      if (!valid()) return;
      if (preview.error === 'empty') setError(errorKeys.empty);
      else {
        setCandidates(preview.candidates);
        setSkipped(preview.skipped);
      }
    } catch (cause) {
      if (valid())
        setError(
          (cause as { status?: number })?.status === 404
            ? 'workspace:mcpImportNeedsUpdate'
            : 'workspace:mcpImportInspectFailed',
        );
    } finally {
      if (valid()) {
        current.pending = false;
        setInspecting(false);
      }
    }
  }
  function apply() {
    const candidate = candidates.find((entry) => entry.url === selected);
    const current = lifecycle.current;
    if (
      current.disabled ||
      current.pending ||
      !current.active ||
      current.epoch !== renderEpoch ||
      !candidate
    )
      return;
    if (
      current.hasDraft &&
      (!replacement || !Object.is(replacement.version, current.draftVersion))
    ) {
      setReplacement({ version: current.draftVersion });
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
        onClick={() => {
          if (lifecycle.current.disabled) return;
          lifecycle.current.epoch++;
          lifecycle.current.active = true;
          setOpen(true);
        }}
      >
        {uiText('workspace:mcpImportOpen')}
      </button>
    );
  return (
    <section className="apps-mcp-import" aria-label={uiText('workspace:mcpImportOpen')}>
      <p className="field-help">{uiText('workspace:mcpImportHelp')}</p>
      {error && <p role="alert">{uiText(error)}</p>}
      {inspecting && <p role="status">{uiText('workspace:mcpImportInspectBusy')}</p>}
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
                setReplacement(undefined);
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
            rows={5}
            disabled={disabled || inspecting}
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
        <button type="button" className="secondary-button" onClick={cancel}>
          {uiText('workspace:mcpImportCancel')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || inspecting || (!candidates.length ? !source.trim() : !selected)}
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
