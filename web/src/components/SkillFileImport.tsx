import { FileUp, Info, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { uiText, type UiTextKey } from '../i18n';
import {
  readSkillFile,
  SkillFileError,
  type ImportedSkillDraft,
  type SkillFileProblem,
} from '../skillFileImport';

const errors: Record<SkillFileProblem, UiTextKey> = {
  file: 'common:skillFileInvalidFile',
  size: 'common:skillFileTooLarge',
  encoding: 'common:skillFileInvalidEncoding',
  format: 'common:skillFileInvalidFormat',
  name: 'common:skillFileInvalidName',
  description: 'common:skillFileInvalidDescription',
  content: 'common:skillFileInvalidContent',
};

export function SkillFileImport({
  disabled,
  onImport,
}: {
  disabled: boolean;
  onImport: (draft: ImportedSkillDraft) => void;
}) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const current = useRef({ disabled, onImport });
  current.current = { disabled, onImport };
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (error) {
      feedback.current?.focus();
      feedback.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [error]);
  return (
    <div>
      <input
        ref={picker}
        type="file"
        accept=".md"
        hidden
        disabled={disabled || reading}
        onChange={async (event) => {
          const files = event.currentTarget.files;
          const file = files?.[0];
          const count = files?.length;
          event.currentTarget.value = '';
          if (!file || disabled || reading) return;
          const ticket = ++sequence.current;
          setReading(true);
          setError('');
          try {
            if (count !== 1) throw new SkillFileError('file');
            const draft = await readSkillFile(file);
            if (ticket === sequence.current && !current.current.disabled)
              current.current.onImport(draft);
          } catch (cause) {
            if (ticket === sequence.current)
              setError(
                uiText(
                  cause instanceof SkillFileError
                    ? errors[cause.problem]
                    : 'common:skillFileReadFailed',
                ),
              );
          } finally {
            if (ticket === sequence.current) setReading(false);
          }
        }}
      />
      <button
        type="button"
        className="add-detail-row"
        disabled={disabled || reading}
        onClick={() => picker.current?.click()}
      >
        {reading ? <Loader2 size={17} className="spin" /> : <FileUp size={17} />}
        {uiText(reading ? 'common:skillFileReading' : 'common:skillFileImport')}
      </button>
      <p className="field-help">{uiText('common:skillFileHelp')}</p>
      {error && (
        <div className="inline-save-error" role="alert" tabIndex={-1} ref={feedback}>
          <Info size={15} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
