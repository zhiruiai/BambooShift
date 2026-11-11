/** Exact service-owned status text only; unknown and user-authored values remain unchanged. */
export const serviceMessages: Readonly<Record<string, string>> = {
  '选中的应用已变更或断开。请移除后重新选择。':
    'The selected app changed or disconnected. Remove it and choose again.',
  '选中的工作空间应用只能用于本地 Bot。':
    'Workspace app selection is available for local Bots only.',
  '本次任务仅可使用用户选中的应用。': 'Only the selected app can be used for this task.',
  '应用选择参数无效。': 'The app selection is invalid.',
  '所选技能已停用、更新，或不属于此 Bot。请移除后重新选择。':
    'This skill was disabled, changed, or belongs to another Bot. Remove it and choose again.',
  '应用连接失败，请检查服务地址、凭据或服务状态后重试。':
    'The application could not connect. Check its address, credentials, and service status.',
  '应用连接已失效或工具已变更，请刷新连接后重新确认。':
    'The connection or tools changed. Refresh the connection and review the action again.',
  '上次授权刷新被中断，请重新进行网页登录授权。':
    'The previous authorization refresh was interrupted. Sign in to authorize again.',
  '授权刷新结果未确认，请重新进行网页登录授权。':
    'The authorization refresh could not be confirmed. Sign in to authorize again.',
  '应用授权未完成，请回到原窗口重新开始。':
    'Authorization was not completed. Return to the original window to start again.',
  '授权已失效，请重新开始。': 'Authorization is no longer valid. Start again.',
  '无法准备网页登录授权，请检查应用及客户端配置后重试。':
    'Browser authorization could not be prepared. Check the application and client configuration.',
  '授权未能确认完成，请重新开始；不会自动重试兑换。':
    'Authorization completion could not be confirmed. Start again; the exchange will not be retried automatically.',
  '授权已取消。': 'Authorization was cancelled.',
  '服务已重启，请重新开始授权。': 'The service restarted. Start authorization again.',
  '服务已重启，原审批已取消。': 'The service restarted and the previous approval was cancelled.',
  '发起账户权限或应用授权已变化，原审批已取消。':
    'The requester or application authorization changed. The previous approval was cancelled.',
  '应用操作审批已过期。': 'Approval for this application action has expired.',
  '空间拥有者拒绝了这次应用操作。': 'The workspace owner rejected this application action.',
  '发起任务的成员拒绝了这次应用操作。': 'The requester rejected this application action.',
  '任务已停止，未执行的应用操作已取消。':
    'The task stopped. Application actions that had not started were cancelled.',
  '应用连接已撤销，原审批已失效。':
    'The application connection was revoked and the previous approval is no longer valid.',
  '应用操作已停止。': 'The application action stopped.',
  '应用操作未执行。': 'The application action was not executed.',
  '应用操作等待发起人批准。': 'The application action is waiting for the requester’s approval.',
  '应用操作正在执行。': 'The application action is running.',
  '应用已返回结果。': 'The application returned a result.',
  '应用连接或工具已更改，原审批已失效。':
    'The connection or tool changed. The previous approval is no longer valid.',
  '应用操作结果未确认，可能已在应用中产生效果；不会自动重试。':
    'The result could not be confirmed. The application may already have changed; no automatic retry will occur.',
  '来源应用或工具已变化，等待拥有者重新确认。':
    'The source application or tools changed. The owner must approve the new version.',
  '来源内容已变化，等待拥有者确认新版本。':
    'The source content changed. The owner must approve the new version.',
  '来源资料已变化或暂不可用，请由拥有者核对。':
    'The source file changed or is unavailable. Ask its owner to review it.',
  '此Bot的分享或团队权限已不可用；你的历史会话仍保留。':
    'This Bot’s sharing or team access is unavailable. Your chat history is retained.',
  '账号、空间或应用连接已变化，或授权已过期，请重新开始授权。':
    'The account, workspace, or application connection changed, or authorization expired. Start authorization again.',
  '账户或空间权限已变化，方案生成已停止。':
    'Account or workspace access changed. Team planning stopped.',
  '团队方案生成超时。目标已保留，请稍后重试。':
    'Team planning timed out. Your goal is retained; try again later.',
  '团队方案未能生成。请检查模型连接与账户权限后重试，目标已保留。':
    'The team plan could not be generated. Check the model connection and account access. Your goal is retained.',
  '方案生成未完成，目标已保留，请重新生成。':
    'Team planning did not complete. Your goal is retained; generate a new plan.',
  '服务已重启，原操作结果未知；请先核对电脑，不要自动重试。':
    'The service restarted and the action’s result is unknown. Check the computer before taking another action.',
  '服务已重启，原审批已失效。':
    'The service restarted and the previous approval is no longer valid.',
  '正在人工接管 · Bot 电脑操作暂停': 'Manual takeover active · Bot computer actions paused',
  '整机桌面已启用 · 每次操作需要批准': 'Desktop enabled · Every action requires approval',
  整机桌面权限不可用: 'Desktop permission is unavailable',
  '本机工作区已连接 · 浏览器尚未打开': 'Local workspace connected · Browser not yet opened',
  未连接电脑: 'No computer connected',
  已连接: 'Connected',
  已断开连接: 'Disconnected',
  等待连接: 'Waiting for a connection',
  浏览器已就绪: 'Browser ready',
  浏览器不可用: 'Browser unavailable',
  '请选择已分配给 Bot 的独立画面。': 'Select the dedicated screen assigned to this Bot.',
  '受管 Linux 浏览器不可用，请检查专用桌面、Chrome 和隔离配置。':
    'The managed Linux browser is unavailable. Check the dedicated desktop, Chrome, and isolation configuration.',
  '无法确认浏览器进程已停止，当前画面需要维护。':
    'The browser could not be confirmed stopped. Recover this screen before continuing.',
  '浏览器清理记录不可用，画面需要维护。':
    'The browser cleanup record is unavailable. Recover this screen before continuing.',
  浏览器尚未启动: 'Browser has not started',
  电脑已关闭: 'Computer closed',
  '服务正在关闭，原电脑操作已取消。':
    'The service is closing. Previous computer actions were cancelled.',
  '原电脑操作清理尚未确认，请维护后重新连接。':
    'Cleanup of the previous computer action is unconfirmed. Recover the computer before reconnecting.',
  '画面暂不可用，请检查连接。': 'The screen is unavailable. Check the connection.',
  '请继续处理此画面的原维护记录。': 'Continue the existing recovery operation for this screen.',
  '尚未分配独立画面。请选择准备此 Bot 画面。':
    'This Bot has no screen yet. Choose to prepare its screen.',
  '尚未连接支持独立画面的电脑。': 'No computer supporting independent screens is connected.',
  '所有 Bot 共用一个本机独立浏览器；任务按顺序执行。':
    'Bots share an isolated browser on the server computer and use it in turn.',
  '工作电脑已切换，请刷新后再提交操作。':
    'The work computer changed. Refresh before submitting this action.',
  '平台执行空间不能控制宿主整机桌面。':
    'Platform workspaces cannot control the host computer’s desktop.',
  '用户已拒绝此电脑操作。': 'The requester rejected this computer action.',
  '用户已停止或补充要求，尚未执行的操作已取消。':
    'The user stopped or updated the task. Actions that had not started were cancelled.',
  '任务已取消；已开始的操作可能已在原电脑产生效果。':
    'The task was cancelled. Actions that had started may already have affected the original computer.',
  '发起账户权限已失效，原审批已取消。':
    'The requester’s access expired and the previous approval was cancelled.',
  '发起账户权限已失效；已开始的操作可能产生效果，不能自动重试。':
    'The requester’s access expired. Started actions may have taken effect and will not be retried automatically.',
  '云电脑私有配置不可用，请联系空间管理员。':
    'The cloud computer configuration is unavailable. Contact the workspace administrator.',
  '当前有任务、电脑请求或接管尚未结束，请稍后刷新。':
    'A task, computer request, or manual takeover is still active. Refresh later.',
  '启动请求可能已发送，请刷新状态确认；不会自动重试。':
    'The start request may have been sent. Refresh to confirm its status; it will not be retried automatically.',
  '云电脑已连接；已申请至少两小时，原有更晚期限会保留。不会自动续期。':
    'The cloud computer is connected. At least two hours were requested; any later existing expiry is retained. Renewal is not automatic.',
  '服务器尚未启用可用的本地语音识别。': 'Local speech recognition is not available on the server.',
  '主动跟进时区或时间无效，请重新设置。':
    'The check-in time or time zone is invalid. Update its settings.',
  '此次主动跟进未确认完成，本日不会自动重试。':
    'This check-in did not finish with confirmation. It will not be retried automatically today.',
  '任务已停止，已完成的工作保留。': 'The task stopped. Completed work is retained.',
  '任务未确认完成，请核对聊天记录。': 'Completion was not confirmed. Review the original chat.',
  '运行中断，未自动重试。': 'The run was interrupted and was not retried automatically.',
  '本次运行已停止，已执行的操作不会自动撤回。':
    'The run stopped. Completed actions are not automatically undone.',
  '账户或 Bot 的访问权限已失效，本次运行已停止。':
    'Account or Bot access expired and the run stopped.',
  '本次运行未能启动，请检查 Bot、聊天和访问权限。':
    'The run could not start. Check the Bot, chat, and access permissions.',
  '尚未配置模型服务，请配置后明确重新运行。':
    'No model service is configured. Configure one, then explicitly run the task again.',
  '模型当前不可用，请检查模型配置后重新运行。':
    'The model is unavailable. Check its configuration before running again.',
  '本次运行未能完成，请打开原对话查看详情。':
    'The run did not complete. Open the original chat for details.',
  '电脑操作的清理状态尚未确认，请先检查执行电脑。':
    'Computer-action cleanup is unconfirmed. Check the execution computer first.',
  '服务已重启，方案生成已中断。你的目标已保留，请重新生成。':
    'The service restarted and team planning was interrupted. Your goal was retained; generate a new plan.',
  '任务已停止，消息未确认送达。': 'The task stopped before message delivery could be confirmed.',
  '本轮任务未完成，消息未确认送达，请重新发送。':
    'The task did not complete and message delivery is unconfirmed. Send the message again.',
  '服务已重启，消息未确认送达，请重新发送。':
    'The service restarted before delivery was confirmed. Send the message again.',
};
