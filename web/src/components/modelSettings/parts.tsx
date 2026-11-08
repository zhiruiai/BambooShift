import { uiText, localizedData } from '../../i18n';
import type { AppSettings, ModelProfile } from '../../../../shared/types';
import '../SettingsDialog.css';
export interface ProfileDraft {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  vision: boolean;
  apiKey: string;
}
export const NEW_PROFILE = '__new_profile__';
export const providers = localizedData(
  () =>
    [
      ['deepseek', uiText('settings:text_b5742e19a9a7')],
      ['anthropic', 'Anthropic'],
      ['openai', 'OpenAI'],
      ['google', 'Google'],
      ['xai', 'xAI'],
      ['openrouter', 'OpenRouter'],
      ['custom', uiText('settings:text_4e4b0fb08021')],
    ] as const,
);
export const newProfile = (): ProfileDraft => ({
  name: 'DeepSeek Flash',
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseUrl: '',
  vision: false,
  apiKey: '',
});
export function fromProfile(profile: ModelProfile): ProfileDraft {
  return {
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl || '',
    vision: profile.vision,
    apiKey: '',
  };
}
export const normalizeAddress = (value: string) => value.trim().replace(/\/+$/, '');
export function changed(draft: ProfileDraft, profile?: ModelProfile) {
  if (!profile) return true;
  const original = fromProfile(profile);
  return (Object.keys(original) as (keyof ProfileDraft)[]).some(
    (key) => draft[key] !== original[key],
  );
}
export function credentialLabel(profile: ModelProfile) {
  if (profile.credentialSource === 'saved') return uiText('settings:text_3d11209d320e');
  if (profile.credentialSource === 'environment') return uiText('settings:text_d979eed5c8b6');
  if (profile.credentialSource === 'pi') return uiText('settings:text_a6c197be7024');
  return profile.configured
    ? uiText('settings:text_5eeb7f337684')
    : uiText('settings:text_f76931eb9b18');
}
export function credentialPlaceholder(profile?: ModelProfile) {
  if (profile?.credentialSource === 'saved') return uiText('settings:text_65093956b7d3');
  if (profile?.credentialSource === 'environment') return uiText('settings:text_b380c49c2bf0');
  if (profile?.credentialSource === 'pi') return uiText('settings:text_7fba9988a340');
  return uiText('settings:text_732fa9b385b0');
}
export interface SettingsDialogProps {
  settings: AppSettings;
  active?: boolean;
  workspaceId?: string;
  userId?: string;
  closeLabel?: string;
  onClose: () => void;
  onSettingsChanged: (settings: AppSettings) => void;
}
