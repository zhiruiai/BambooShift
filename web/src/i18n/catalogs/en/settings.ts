import type zh from '../zh-CN/settings';
export default {
  botModelLabel: 'Model for this Bot',
  botModelDefault: 'Use workspace default',
  botModelLoading: 'Loading selected model…',
  botModelUnavailable: 'Selected model unavailable',
  botModelNotConfigured: 'Not configured',
  botModelUnavailableHelp:
    'This model is no longer available. Choose a configured model or the workspace default; a different model will not be substituted automatically.',
  botModelHelp:
    'Choose a model for this Bot. The workspace default follows future changes to the default model. Changes apply to new tasks.',
  botModelEmpty: 'Configure a model in Settings → Models, then refresh this list.',
  botModelRefresh: 'Refresh models',
  botSkillsLabel: 'Skills for this Bot',
  botSkillsEnabled: '{{count}} enabled',
  botSkillsEmpty:
    'No skills enabled yet. Choose a workflow, review its instructions, then enable it for this Bot.',
  botSkillsManage: 'Choose and manage skills',
  botSkillsHint: 'Enabled skills guide this Bot’s work. You can pause or restore each skill.',
  botSkillsCatalog: 'Choose from skill library',
  botSkillsCatalogBack: 'Back to this Bot’s skills',
  botSkillsScope: 'Skills for {{name}}',
  avatarOriginalCollection: 'Built-in themes',
  avatarCollections: 'Avatar collections',
  avatarSelectedTheme: 'Selected: {{name}}',
  avatarCustomTheme: 'Custom theme',
  avatarCommunityNote: 'Community artwork · Native expressions · Works offline',
  avatarCollectionLicense: 'License',

  language: 'Language',
  languageHelp:
    'Interface language is saved in this browser or client. Messages, memories and Bot instructions keep their original language.',
  localOnly:
    'These preferences are saved only in this browser or client and do not sync to other devices.',
  storageUnavailable:
    'Preferences cannot be saved on this device right now. Changes still apply to this page.',
  appearance: 'Appearance',
  avatarSyncTitle: 'Sync avatar theme',
  avatarSyncHelp:
    'Save the selected theme and any custom design for your account in this workspace.',
  avatarSyncClearHelp:
    'Using the device theme removes the synced theme for this workspace. Each device returns to its own preference.',
  avatarSyncDevicePreferences:
    'Appearance, accent color, language and spelling are saved on this device.',
  avatarSyncLoading: 'Checking synced theme…',
  avatarSyncSaving: 'Saving the theme…',
  avatarSyncConflict: 'The synced theme changed on another device. Check it before saving again.',
  avatarSyncUnknown: 'The save could not be confirmed. Check the synced theme before trying again.',
  avatarSyncUnavailable: 'Sync status is unavailable. Check the synced theme to continue.',
  avatarSyncPreview: 'Previewing an unsaved theme in this workspace.',
  avatarSyncSaved: 'Theme synced for this workspace.',
  avatarSyncDevice: 'Using this device’s theme.',
  avatarSyncSave: 'Save theme to this workspace',
  avatarSyncClearPrompt: 'Remove the synced theme?',
  avatarSyncClearConfirm: 'Confirm and use device theme',
  avatarSyncClear: 'Use device theme',
  avatarSyncRestore: 'Restore synced theme',
  avatarSyncDiscard: 'Discard preview',
  avatarSyncCheck: 'Check synced theme',
  avatarSyncPreviewAction: 'Preview in this workspace',
  avatarTheme: 'Avatar theme',
  selected: 'Selected',
  chooseTheme: 'Choose theme',
  avatarHelp:
    'Apply one style to every Bot. Classic black uses black and white; other themes keep role colors. Uploaded pictures take priority.',
  theme: 'Theme',
  system: 'Use device setting',
  light: 'Light',
  dark: 'Dark',
  accent: 'Accent color',
  botColor: 'Bot color',
  neutral: 'Monochrome',
  spellCheck: 'Spell check',
} satisfies Record<keyof typeof zh, string>;
