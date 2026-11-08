export default {
  notificationsTitle: 'Notifications',
  notificationsDescription:
    'Notify only while the app is in the background or unfocused. The client must stay open; there is no push delivery after you close it.',
  notificationsAccountRequired: 'Sign in to a workspace to configure your notifications.',
  notificationsEnable: 'Enable notifications on this device',
  notificationsDeviceScope:
    'Saved for this account and workspace on this device only. Other members and devices are unaffected.',
  notificationsPermissionPrompt:
    'System notifications have not been allowed. Enable the preference, then use the button below to grant permission.',
  notificationsPermissionGranted:
    'Notifications are allowed. Delivery still depends on system notification settings and Do Not Disturb.',
  notificationsPermissionDenied:
    'System notifications were not allowed. You can try again or adjust your browser and system settings.',
  notificationsUnsupported:
    'System notifications are unavailable here. Results and approval requests remain available in chat.',
  notificationsAllow: 'Allow system notifications',
  notificationsRequesting: 'Confirming…',
  notificationsCheck: 'Check again',
  notificationsStorageBlocked:
    'Notification preferences or deduplication records could not be saved, so notifications are paused. Check browser storage and try again.',
  notificationsFailed:
    'This notification could not be shown. Check your system notification settings.',
  notificationsEvents: 'Notify me about',
  notificationsCompleted: 'My completed tasks',
  notificationsApprovals: 'App or computer actions that need my approval',
  notificationsBots: 'Bots allowed to notify me',
  notificationsNoBots: 'There are no Bots in this workspace yet.',
  notificationsPrivacy:
    'Notifications include only the Bot name and status, never chat text, task content, or action arguments. Opening history and replayed messages do not trigger catch-up notifications.',
  notificationsBot: 'Bot',
  notificationsCompletedTitle: '{{bot}} · Task complete',
  notificationsApprovalTitle: '{{bot}} · Needs your approval',
} as const;
