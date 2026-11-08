const moved: Record<string, Record<string, string>> = {
  'BotTemplateDialog.tsx': {
    TemplateSource: 'templates/TemplateSource.tsx',
    TemplateManager: 'templates/TemplateManager.tsx',
    TemplateLibrary: 'templates/TemplateLibrary.tsx',
  },
  'SharedBotsDialog.tsx': { ManageSharedBotContent: 'sharing/ManageSharedBotDialog.tsx' },
  'SidebarRoster.tsx': {
    RosterDialogContent: 'roster/RosterManagementDialog.tsx',
    RosterActions: 'roster/RosterActions.tsx',
  },
  'ComputerFiles.tsx': { TransferHarness: 'computerFiles/useComputerTransfer.tsx' },
};

/** Locate the production component now responsible for the behavior under test. */
export function componentSource(file: string, exportedNameOrSource: string) {
  const basename = file.split('/').at(-1)!;
  for (const [name, target] of Object.entries(moved[basename] || {})) {
    if (new RegExp(`\\b${name}\\b`).test(exportedNameOrSource))
      return file.slice(0, file.length - basename.length) + target;
  }
  return file;
}
