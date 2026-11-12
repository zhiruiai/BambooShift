export default {
  mcpImportOpen: 'Import MCP configuration',
  mcpImportHelp:
    'Paste an mcpServers or VS Code servers JSON object. Only the name and public HTTPS address are copied. Credentials and commands are ignored. Nothing connects until you review and submit the form below.',
  mcpImportJson: 'MCP configuration JSON',
  mcpImportInspect: 'Find remote services',
  mcpImportChoose: 'Remote service',
  mcpImportChoosePlaceholder: 'Choose a service',
  mcpImportApply: 'Use name and address',
  mcpImportCancel: 'Cancel import',
  mcpImportReplace: 'Replace current form',
  mcpImportReplaceHelp:
    'This replaces the current name and address, clears its token, and resets authentication and sharing consent. Cancel import to keep your current form.',
  mcpImportSkipped: '{{count}} unsupported, invalid, or duplicate entries were skipped.',
  mcpImportInvalidJson: 'This is not valid JSON. Paste a complete configuration object.',
  mcpImportInvalidShape: 'Use a JSON object containing mcpServers or servers.',
  mcpImportTooLarge: 'Use a configuration of at most 65,536 characters.',
  mcpImportTooMany: 'Import at most 100 service entries at a time.',
  mcpImportNoRemote:
    'No supported remote services were found. Use public HTTPS domains with HTTP transport and no URL credentials, query, or fragment. Local commands, private addresses, and legacy SSE servers are not imported.',
};
