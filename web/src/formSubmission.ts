import { uiText } from './i18n';
export type FormSaveResult = { ok: true } | { ok: false; error: string };

/** A form stays editable after failure; only a confirmed write may reset its draft. */
export function createFormSubmission() {
  let pending = false;
  return {
    get pending() {
      return pending;
    },
    async submit(
      work: () => Promise<FormSaveResult>,
      saved: () => void,
    ): Promise<FormSaveResult | null> {
      if (pending) return null;
      pending = true;
      try {
        let result: FormSaveResult;
        try {
          result = await work();
        } catch (cause) {
          result = {
            ok: false,
            error: cause instanceof Error ? cause.message : uiText('common:text_072387ead00b'),
          };
        }
        if (result.ok) saved();
        return result;
      } finally {
        pending = false;
      }
    },
  };
}
