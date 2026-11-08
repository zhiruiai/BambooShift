import { uiText } from '../../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AppSettings,
  ModelProfile,
  ModelProfileMutationResult,
  ModelProfilesResponse,
} from '../../../../shared/types';
import { createAppConnectionScope } from '../../appConnections';
import '../SettingsDialog.css';
import {
  changed,
  fromProfile,
  NEW_PROFILE,
  newProfile,
  normalizeAddress,
  ProfileDraft,
  SettingsDialogProps,
} from './parts';
export function useModelSettingsDialog({
  settings,
  onClose,
  onSettingsChanged,
  showManagement,
  workspaceId,
  userId,
  closeLabel,
  active: visible = true,
}: SettingsDialogProps & { showManagement: boolean }) {
  const identity = useRef({ workspaceId, userId });
  identity.current = { workspaceId, userId };
  const [scope] = useState(() =>
    createAppConnectionScope({
      workspaceId,
      userId,
      identity: () => identity.current,
    }),
  );
  const [list, setList] = useState<ModelProfilesResponse | null>(null);
  const [selected, setSelected] = useState('');
  // Unsaved values stay with their selected profile until this dialog is closed.
  // Existing credentials are never returned by the API or copied into these drafts.
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'save' | 'activate' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestSequence = useRef(0);
  const pendingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const profile = list?.profiles.find((item) => item.id === selected);
  const draft = drafts[selected] || (profile ? fromProfile(profile) : undefined);
  const dirty = draft ? changed(draft, profile) : false;
  const isDefault = !!profile && profile.id === list?.activeProfileId;
  const active = list?.profiles.find((item) => item.id === list.activeProfileId);
  const locked = loading || pending !== null;
  const endpointChanged = !!(
    profile &&
    draft &&
    (profile.provider !== draft.provider ||
      normalizeAddress(profile.baseUrl || '') !== normalizeAddress(draft.baseUrl))
  );

  useEffect(() => {
    if (visible) scope.resume();
    else scope.suspend();
    return () => scope.suspend();
  }, [scope, visible]);

  useEffect(() => {
    if (error || notice) feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error, notice]);

  async function loadProfiles() {
    const ticket = scope.ticket();
    if (pendingRef.current || !scope.current(ticket)) return;
    const request = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await scope.request<ModelProfilesResponse>('/model-profiles');
      if (request !== requestSequence.current || !scope.current(ticket)) return;
      setList(result);
      setSelected((previous) =>
        previous === NEW_PROFILE || result.profiles.some((item) => item.id === previous)
          ? previous
          : result.activeProfileId || result.profiles[0]?.id || NEW_PROFILE,
      );
      if (!result.profiles.length) {
        setDrafts((previous) => ({
          ...previous,
          [NEW_PROFILE]: previous[NEW_PROFILE] || newProfile(),
        }));
      }
    } catch (cause) {
      if (request === requestSequence.current && scope.current(ticket))
        setError((cause as Error).message);
    } finally {
      if (request === requestSequence.current && scope.current(ticket)) setLoading(false);
    }
  }

  useEffect(() => {
    if (!visible) return;
    void loadProfiles();
    return () => {
      requestSequence.current++;
    };
  }, [
    visible,
    settings.profileId,
    settings.profileName,
    settings.provider,
    settings.model,
    settings.baseUrl,
    settings.vision,
    settings.configured,
    settings.hasApiKey,
  ]);

  function edit(patch: Partial<ProfileDraft>) {
    if (!draft || locked) return;
    setDrafts((previous) => ({ ...previous, [selected]: { ...draft, ...patch } }));
    setError('');
    setNotice('');
  }
  function choose(id: string) {
    setSelected(id);
    setError('');
    setNotice('');
  }
  function add(copy = false) {
    const value =
      copy && draft
        ? {
            ...draft,
            name: uiText('settings:profileCopyName', { name: draft.name.slice(0, 70) }),
            apiKey: '',
          }
        : drafts[NEW_PROFILE] || newProfile();
    setDrafts((previous) => ({ ...previous, [NEW_PROFILE]: value }));
    setSelected(NEW_PROFILE);
    setError('');
    setNotice(copy ? uiText('settings:text_e70a7ae921d9') : uiText('settings:text_80a2718f6d8d'));
    requestAnimationFrame(() => nameRef.current?.focus());
  }
  function resetDraft() {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[selected];
      return next;
    });
    setError('');
    setNotice('');
  }
  function updateResult(profile: ModelProfile, nextSettings: AppSettings) {
    setList((previous) => ({
      activeProfileId: nextSettings.profileId,
      profiles: previous?.profiles.some((item) => item.id === profile.id)
        ? previous.profiles.map((item) => (item.id === profile.id ? profile : item))
        : [...(previous?.profiles || []), profile],
    }));
    onSettingsChanged(nextSettings);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const ticket = scope.ticket();
    if (!scope.current(ticket) || !draft || locked || pendingRef.current) return;
    pendingRef.current = true;
    requestSequence.current++;
    setPending('save');
    setError('');
    setNotice('');
    const sourceId = selected;
    try {
      const result = await scope.request<ModelProfileMutationResult>('/model-profiles', 'POST', {
        ...(profile ? { id: profile.id } : {}),
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model.trim(),
        baseUrl: draft.baseUrl.trim(),
        vision: !!draft.baseUrl.trim() && draft.vision,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        activate: false,
      });
      if (!scope.current(ticket)) return;
      updateResult(result.profile, result.settings);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[sourceId];
        delete next[result.profile.id];
        return next;
      });
      setSelected(result.profile.id);
      setNotice(
        result.profile.id === result.settings.profileId
          ? uiText('settings:text_a196c0a91779')
          : uiText('settings:text_dfd3457aa5c0'),
      );
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      pendingRef.current = false;
      if (scope.current(ticket)) setPending(null);
    }
  }
  async function activate() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || !profile || dirty || locked || pendingRef.current) return;
    pendingRef.current = true;
    requestSequence.current++;
    setPending('activate');
    setError('');
    setNotice('');
    try {
      const next = await scope.request<AppSettings>(
        `/model-profiles/${encodeURIComponent(profile.id)}/activate`,
        'POST',
      );
      if (!scope.current(ticket)) return;
      setList((previous) =>
        previous ? { ...previous, activeProfileId: next.profileId } : previous,
      );
      onSettingsChanged(next);
      setNotice(uiText('settings:text_f30339e1f0d9', { value0: profile.name }));
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      pendingRef.current = false;
      if (scope.current(ticket)) setPending(null);
    }
  }

  return {
    visible,
    pendingRef,
    scope,
    onClose,
    active,
    settings,
    locked,
    loadProfiles,
    add,
    loading,
    list,
    selected,
    choose,
    drafts,
    isDefault,
    profile,
    dirty,
    activate,
    pending,
    error,
    notice,
    feedbackRef,
    draft,
    save,
    nameRef,
    edit,
    endpointChanged,
    resetDraft,
    showManagement,
    closeLabel,
  };
}
