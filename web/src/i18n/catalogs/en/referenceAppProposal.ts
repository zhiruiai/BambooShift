export default {
  appProposalTitle: 'Suggested connection: {{provider}}',
  appProposalCustomEndpoint: 'Suggested MCP server address',
  appProposalCustomReview:
    'Review this custom MCP address and decide how it should be shared before connecting.',
  appProposalCustomOwner:
    'Only the requester can review a custom MCP server from a personal chat with a local Bot.',
  appProposalCustomForm:
    'This address is fixed to the suggestion you opened. Choose the authentication method and confirm workspace sharing to connect.',
  appProposalReview: 'Review the service and sharing scope before confirming the connection.',
  appProposalConnectedHelp: 'You can attach this connected app to a new message.',
  appProposalExistingHelp: 'Open the saved connection to continue setup or authorization.',
  appProposalOpen: 'Review and connect',
  appProposalManage: 'Open connection',
  appProposalAuthorize: 'Continue authorization',
  appProposalReviewConnection: 'Review connection',
  appProposalNotConnected: 'Not connected',
  appProposalRetry: 'Retry review',
  appProposalChecking: 'Checking the current workspace connection…',
  appProposalExisting: 'This service already has a connection in this workspace.',
  appProposalOwner:
    'Only the owner who requested this task can proceed. The Bot and chat must still be available.',
  appProposalUnavailable:
    'This suggestion is unavailable. Check your account, workspace permissions and Bot.',
} as const;
