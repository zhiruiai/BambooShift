import { FolderUp, Info, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { uiText, type UiTextKey } from '../i18n';
import {
  readSkillPackage,
  SkillPackageError,
  type ImportedSkillPackage,
  type SkillPackageProblem,
} from '../skillPackageImport';

const errors: Record<SkillPackageProblem, UiTextKey> = {
  folder: 'common:skillPackageInvalidFolder',
  name: 'common:skillPackageInvalidName',
  paths: 'common:skillPackageInvalidPaths',
  size: 'common:skillPackageTooLarge',
  frontmatter: 'common:skillPackageInvalidFrontmatter',
  description: 'common:skillPackageInvalidDescription',
  content: 'common:skillPackageInvalidContent',
  encoding: 'common:skillFileInvalidEncoding',
};
export const skillPackageErrorText = (cause: unknown) =>
  uiText(cause instanceof SkillPackageError ? errors[cause.problem] : 'common:skillFileReadFailed');

export function SkillPackageImport({
  disabled,
  onImport,
}: {
  disabled: boolean;
  onImport: (draft: ImportedSkillPackage) => void;
}) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const latest = useRef({ disabled, onImport });
  latest.current = { disabled, onImport };
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (error) feedback.current?.focus();
  }, [error]);
  return (
    <div className="skill-folder-import">
      <input
        ref={(element) => {
          picker.current = element;
          if (element) element.webkitdirectory = true;
        }}
        type="file"
        hidden
        aria-label={uiText('common:skillPackageImport')}
        disabled={disabled || reading}
        onChange={async (event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (!files.length || disabled || reading) return;
          const ticket = ++generation.current;
          setReading(true);
          setError('');
          try {
            const draft = await readSkillPackage(files);
            if (ticket === generation.current && !latest.current.disabled)
              latest.current.onImport(draft);
          } catch (cause) {
            if (ticket === generation.current) setError(skillPackageErrorText(cause));
          } finally {
            if (ticket === generation.current) setReading(false);
          }
        }}
      />
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || reading}
        title={uiText('common:skillPackageHelp')}
        onClick={() => picker.current?.click()}
      >
        {reading ? <Loader2 size={17} className="spin" /> : <FolderUp size={17} />}
        {uiText(reading ? 'common:skillFileReading' : 'common:skillPackageImport')}
      </button>
      {error && (
        <div className="inline-save-error" role="alert" tabIndex={-1} ref={feedback}>
          <Info size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
