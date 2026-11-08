import { uiText } from '../i18n';
import { type ClipboardEvent, type DragEvent } from 'react';
import type { WorkspaceFile } from '../../../shared/types';
import { fileBase64 } from '../api';
import { submissionKey, type ComposerState } from '../chatDrafts';
import { pastedFiles } from '../composer-attachments';
import { mergeDictation, type DictationCapture } from '../dictation';
import type { ComposerActionsContext } from './createComposerActions.types';
export function createComposerActions(read: () => ComposerActionsContext) {
  const api: import('../fixedWorkspaceApi').FixedWorkspaceApi = (path, method, body) =>
    read().api(path, method, body);
  function updateComposer(
    conversationId: string,
    update: (previous: ComposerState) => ComposerState,
  ) {
    const { setComposers, emptyDraft, attempts } = read();

    setComposers((all) => {
      const previous = all[conversationId] || emptyDraft.current,
        next = update(previous);
      if (submissionKey(previous) !== submissionKey(next)) attempts.current.delete(conversationId);
      return { ...all, [conversationId]: next };
    });
  }
  function setDraft(value: string | ((previous: string) => string)) {
    const { selected, composerKey = selected } = read();

    updateComposer(composerKey, (previous) => ({
      ...previous,
      text: typeof value === 'function' ? value(previous.text) : value,
    }));
  }
  function setAttachments(
    value: WorkspaceFile[] | ((previous: WorkspaceFile[]) => WorkspaceFile[]),
  ) {
    const { selected, composerKey = selected } = read();

    updateComposer(composerKey, (previous) => ({
      ...previous,
      attachments: typeof value === 'function' ? value(previous.attachments) : value,
    }));
  }
  function rememberSelection() {
    const { composerRef, selectionRef, selected, composerKey = selected } = read();

    const field = composerRef.current;
    if (!field) return;
    const previous = selectionRef.current;
    if (
      previous.conversationId !== composerKey ||
      previous.start !== field.selectionStart ||
      previous.end !== field.selectionEnd
    )
      selectionRef.current = {
        conversationId: composerKey,
        start: field.selectionStart,
        end: field.selectionEnd,
        version: previous.version + 1,
      };
  }
  function insertDictation(capture: DictationCapture, text: string) {
    const { dictationScopeRef, compositionRef, pendingDictation, selectionRef, composerKey } =
      read();

    if (capture.scope !== dictationScopeRef.current) return;
    updateComposer(composerKey ?? capture.conversationId, (previous) => {
      if (capture.scope !== dictationScopeRef.current) return previous;
      if (compositionRef.current) {
        pendingDictation.current = { capture, text };
        return previous;
      }
      return mergeDictation(previous, capture, text, selectionRef.current.version);
    });
  }
  function toggleDictation() {
    const {
      dictation,
      conversation,
      sharedUnavailable,
      compositionRef,
      sendingRef,
      selected,
      uploadingRef,
      dictationScope,
      currentUserId,
      currentComposer,
      selectionRef,
    } = read();

    if (dictation.state.phase === 'recording') {
      dictation.finish();
      return;
    }
    if (
      !conversation ||
      sharedUnavailable ||
      compositionRef.current ||
      dictation.busy ||
      sendingRef.current.has(selected) ||
      uploadingRef.current.has(selected)
    )
      return;
    rememberSelection();
    dictation.start({
      scope: dictationScope,
      userId: currentUserId,
      conversationId: selected,
      draft: currentComposer,
      selection: { ...selectionRef.current },
    });
  }
  function hasFiles(event: DragEvent<HTMLElement>) {
    const {} = read();

    return Array.from(event.dataTransfer.types).includes('Files');
  }
  function enterFiles(event: DragEvent<HTMLElement>) {
    const { modal, selected, fileDragDepth, setDraggingFiles } = read();

    if (!hasFiles(event) || modal || !selected) return;
    event.preventDefault();
    fileDragDepth.current += 1;
    setDraggingFiles(true);
  }
  function leaveFiles(event: DragEvent<HTMLElement>) {
    const { fileDragDepth, setDraggingFiles } = read();

    if (!hasFiles(event)) return;
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
    if (!fileDragDepth.current) setDraggingFiles(false);
  }
  function dropFiles(event: DragEvent<HTMLElement>) {
    const { fileDragDepth, setDraggingFiles, modal, selected, uploadingRef, setToast } = read();

    if (!hasFiles(event) && !event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepth.current = 0;
    setDraggingFiles(false);
    if (modal || !selected) return;
    if (uploadingRef.current.has(selected)) {
      setToast(uiText('workspace:text_844aaa37a588'));
      return;
    }
    void upload(event.dataTransfer.files);
  }
  function pasteFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    const { selected, modal, uploadingRef, setToast } = read();

    const files = pastedFiles(event.clipboardData);
    if (!files.length || !selected || modal) return;
    event.preventDefault();
    if (uploadingRef.current.has(selected)) {
      setToast(uiText('workspace:text_20e6f064ca59'));
      return;
    }
    void upload(files);
  }
  async function upload(list: FileList | File[] | null) {
    const {
      selected,
      composerKey = selected,
      uploadingRef,
      fileRef,
      setUploading,
      refresh,
      setToast,
      sendScope,
    } = read();
    const ticket = sendScope.ticket();
    if (!sendScope.current(ticket)) return;

    if (!list?.length || !selected || uploadingRef.current.has(selected)) return;
    const target = selected,
      files = Array.from(list);
    if (fileRef.current) fileRef.current.value = '';
    uploadingRef.current.add(target);
    setUploading(new Set(uploadingRef.current));
    try {
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024) throw new Error(uiText('workspace:text_94bfe6b151ad'));
        const result = await api<WorkspaceFile>('/files', 'POST', {
          name: file.name,
          content: await fileBase64(file),
          conversationId: target,
          type: file.type,
        });
        if (!sendScope.current(ticket)) return;
        updateComposer(composerKey, (previous) => ({
          ...previous,
          attachments: [...previous.attachments, result],
        }));
      }
      await refresh();
    } catch (error) {
      if (sendScope.current(ticket)) setToast((error as Error).message);
    } finally {
      uploadingRef.current.delete(target);
      if (sendScope.current(ticket)) setUploading(new Set(uploadingRef.current));
    }
  }
  async function copy(content: string) {
    const { setToast, sendScope } = read();
    const ticket = sendScope.ticket();
    if (!sendScope.current(ticket)) return;

    try {
      await navigator.clipboard.writeText(content);
      if (sendScope.current(ticket)) setToast(uiText('workspace:text_d533266c928e'));
    } catch {
      if (sendScope.current(ticket)) setToast(uiText('workspace:text_24d8a278e4a5'));
    }
  }
  return {
    updateComposer,
    setDraft,
    setAttachments,
    rememberSelection,
    insertDictation,
    toggleDictation,
    hasFiles,
    enterFiles,
    leaveFiles,
    dropFiles,
    pasteFiles,
    upload,
    copy,
  };
}
