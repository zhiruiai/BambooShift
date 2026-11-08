export default {
  notificationsTitle: '通知',
  notificationsDescription:
    '只在应用位于后台或未聚焦时提醒。客户端必须保持运行；关闭应用后不会收到推送。',
  notificationsAccountRequired: '登录工作空间后可设置本人的通知。',
  notificationsEnable: '在此设备开启通知',
  notificationsDeviceScope: '仅保存当前账户、当前空间的设备偏好，不影响其他成员或设备。',
  notificationsPermissionPrompt: '尚未允许系统通知。开启偏好后，点击下方按钮授权。',
  notificationsPermissionGranted: '已允许发送通知。实际显示仍取决于系统通知设置与勿扰模式。',
  notificationsPermissionDenied: '系统通知未获允许。可重新确认，或在浏览器与系统设置中调整。',
  notificationsUnsupported: '此环境不支持系统通知。你仍可在聊天中查看结果与待确认操作。',
  notificationsAllow: '允许系统通知',
  notificationsRequesting: '正在确认…',
  notificationsCheck: '重新检查',
  notificationsStorageBlocked:
    '通知偏好或去重记录无法保存，已暂停通知。请检查浏览器存储后重新检查。',
  notificationsFailed: '本次通知未能显示，请检查系统通知设置。',
  notificationsEvents: '提醒内容',
  notificationsCompleted: '我的任务完成',
  notificationsApprovals: '需要我确认的应用或电脑操作',
  notificationsBots: '允许提醒的 Bot',
  notificationsNoBots: '当前空间尚无 Bot。',
  notificationsPrivacy:
    '通知仅显示 Bot 名称与状态，不包含聊天正文、任务内容或操作参数。打开历史与重复消息不会补发通知。',
  notificationsBot: 'Bot',
  notificationsCompletedTitle: '{{bot}} · 任务完成',
  notificationsApprovalTitle: '{{bot}} · 需要你确认',
} as const;
