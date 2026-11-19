export default {
  messageChannelsTitle: 'Messaging channels',
  messageChannelsIntro:
    'Start work from enterprise chat and return results to the original conversation. Choose a channel to review its setup.',
  messageChannelsChoose: 'Choose a messaging channel',
  messageChannelsNeedsSetup: 'Setup required',
  messageChannelsConnect: 'Connect {{name}} with a Bot',
  messageChannelsFlow: 'Enterprise message → dedicated Bot chat → original-message reply',
  messageChannelsDeveloper: 'Developer setup',
  messageChannelsStep1: 'Prepare an enterprise bot',
  messageChannelsCredentials_feishu:
    'Prepare the app ID, app secret and bot Open ID, then enable the persistent message connection.',
  messageChannelsCredentials_dingtalk:
    'Prepare the enterprise app AppKey and AppSecret, then enable bot Stream mode.',
  messageChannelsCredentials_wecom:
    'Prepare the AI bot Bot ID and Secret for its official persistent connection.',
  messageChannelsStep2: 'Bind employees and dedicated chats',
  messageChannelsBinding:
    'Specify allowed employees, chats and threads. Bind each to a separate Bot chat using the corresponding user’s actual permissions.',
  messageChannelsStep3: 'Check configuration and verify both directions',
  messageChannelsVerification:
    'Check the configuration offline, then start the separate bridge. Send a test in the enterprise app and verify the reply reaches its original conversation.',
  messageChannelsBoundary:
    'Templates do not connect enterprise accounts automatically. Text messages are supported; approvals stay in aihubot and external messages cannot increase permissions.',
  messageChannelsGuide: 'Read the setup guide',
  messageChannelsCopy: 'Copy check command',
  messageChannelsCopied: 'Check command copied',
  messageChannelsTechnical: 'Protocol and open-source dependencies',
  messageChannelsProtocol:
    'Uses each platform’s official messaging protocol. The bridge runs separately from MCP tool connections and A2A agent communication.',
  messageChannelsUpstream: 'View the official SDK',
  environmentModelReady: 'Configured and ready to work',
  composerApps: 'Connect apps',
  composerAppsHint: 'Browse providers and review your workspace connections.',
  composerAppsKeywords:
    'apps connect MCP authorization Notion Linear GitHub GitLab Sentry Jira Confluence Atlassian Slack Microsoft Learn Cloudflare Docs DeepWiki Context7 AWS Knowledge',
  providerCatalog: 'App directory',
  providerCatalogHelp:
    'Choose a provider, review its details, then connect it. Some services ask you to authorize an account.',
  providerCategories: 'App categories',
  providerCategory_all: 'All',
  providerCategory_productivity: 'Productivity',
  providerCategory_code: 'Code',
  providerCategory_noAuth: 'No sign-in',
  providerAuth_none: 'No sign-in required',
  providerAuth_oauth: 'Browser sign-in',
  providerAuth_bearer: 'Access token',
  providerNotion: 'Search and organize pages in the Notion workspace you authorize.',
  providerLinear: 'Read issues and projects through Linear’s read-only service.',
  providerGitHub: 'Read repositories and issues. Supply a token with the permissions you need.',
  providerSentry: 'Investigate errors and issues in the Sentry projects you authorize.',
  providerSlack: 'Search public Slack channels and read their threads.',
  providerAtlassian:
    'Search Jira work and Confluence pages you can access. Your site may require admin approval.',
  providerGitLab:
    'Work with issues and merge requests in your authorized GitLab.com groups. The top-level group must allow MCP.',
  providerMicrosoftLearn: 'Search official Microsoft and Azure docs and code examples.',
  providerCloudflareDocs: 'Search official Cloudflare developer docs.',
  providerDeepWiki: 'Explore documentation and architecture for public GitHub repositories.',
  providerContext7: 'Look up current library documentation and version-specific code examples.',
  providerAwsKnowledge:
    'Search official AWS docs, architecture guidance, and regional availability.',
  providerDocumentation: 'Provider instructions',
  providerDocumentationLabel: '{{name}} provider instructions',
  providerConnectedLabel: 'View connected {{name}}',
  providerConfigureLabel: 'Configure {{name}}',
  providerConnected: 'Connected',
  providerContinue: 'Continue',
  providerConfigure: 'Add',
  providerNoResults: 'No providers match this search.',
  providerDraftRetained:
    'Your unfinished connection details are preserved. Open Add connection to finish them, or close this dialog to discard the draft before choosing another app.',
};
