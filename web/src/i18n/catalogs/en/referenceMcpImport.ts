export default {
  mcpImportOpen: 'Import MCP configuration',
  mcpImportHelp:
    'Paste mcpServers or VS Code servers JSON. Credentials and commands are removed on this device. Only names and addresses are sent to your workspace for preview; it does not contact external services. Review and submit the form to connect.',
  mcpImportInspectBusy: 'Checking addresses…',
  mcpImportInspectFailed:
    'Could not preview these addresses. Try again or enter the service manually.',
  mcpImportNeedsUpdate:
    'This workspace needs an update to preview imports. You can enter the service manually.',
  mcpImportJson: 'MCP configuration JSON',
  mcpImportInspect: 'Find remote services',
  mcpImportChoose: 'Remote service',
  mcpImportChoosePlaceholder: 'Choose a service',
  mcpImportApply: 'Use name and address',
  mcpImportCancel: 'Cancel import',
  mcpImportReplace: 'Replace current form',
  mcpImportReplaceHelp:
    'Replacing the draft clears its token and sharing confirmation. For a recognized official address, the form selects the recommended authentication method. Cancel to keep your current draft.',
  mcpImportSkipped: '{{count}} unsupported, invalid, or duplicate entries were skipped.',
  mcpImportInvalidJson: 'This is not valid JSON. Paste a complete configuration object.',
  mcpImportInvalidShape: 'Use a JSON object containing mcpServers or servers.',
  mcpImportTooLarge: 'Use a configuration of at most 65,536 characters.',
  mcpImportTooMany: 'Import at most 100 service entries at a time.',
  mcpImportNoRemote:
    'No supported remote services were found. Use public HTTPS domains with HTTP transport and no URL credentials, query, or fragment. Local commands, private addresses, and legacy SSE servers are not imported.',
};
