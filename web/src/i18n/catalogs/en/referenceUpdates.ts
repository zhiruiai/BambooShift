export default {
  updatesTitle: 'Updates',
  updatesDescription:
    'View the versions currently running. GitHub is contacted only when you click Check for updates, using the repository configured by the deployer.',
  updatesAccountRequired: 'Sign in to a workspace to view update information.',
  updatesServiceVersion: 'Service version',
  updatesWebVersion: 'Web client version',
  updatesDesktopVersion: 'Desktop client version',
  updatesNotRead: 'Not available yet',
  updatesUnconfigured: 'No release repository configured',
  updatesUnavailable: 'Update status is not confirmed',
  updatesCurrent: 'No newer stable version found',
  updatesAvailable: 'A newer stable version is available',
  updatesUnknownVersion: 'Version format cannot be compared',
  updatesRepository: 'Release repository: {{repository}}',
  updatesConfigureHint:
    'The deployer can set releases.repository (owner/repo) in the private server configuration. Until then, GitHub is not contacted and no latest version is assumed.',
  updatesNotChecked: 'Updates have not been checked manually yet.',
  updatesNetwork: 'Release information could not be retrieved. Try again later.',
  updatesTimeout: 'The update check timed out. Try again later.',
  updatesRateLimited: 'GitHub is temporarily limiting requests. Try again later.',
  updatesNotFound:
    'No publicly readable stable release was found. Check the repository configuration.',
  updatesInvalidRelease:
    'The release did not meet stable-version or safe-link requirements and is not shown as an update.',
  updatesTooLarge: 'Release information exceeded the size limit and was not loaded.',
  updatesLastChecked: 'Last checked: {{time}}. Results are cached for 5 minutes.',
  updatesWebComparison: 'Web client: {{status}}',
  updatesDesktopComparison: 'Desktop client: {{status}}',
  updatesReleaseNotes: 'Release notes',
  updatesOpenRelease: 'View release on GitHub',
  updatesDesktopLinkHint:
    'In the desktop client, right-click this link, choose to open it in your browser, and confirm.',
  updatesCheck: 'Check for updates',
  updatesRefresh: 'Refresh local status',
  updatesNoInstall:
    'This page only checks versions. It never downloads, runs, or installs updates. Verify the release source and signature before you or the deployer update manually.',
  updatesInvalidResponse: 'Update information could not be validated. Read it again.',
  updatesFailed: 'Update information could not be read. Try again.',
} as const;
