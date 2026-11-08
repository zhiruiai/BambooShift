export default {
  'appPolicies.title': '例行任务只读授权',
  'appPolicies.explanation':
    '仅对你已保存并启用的例行任务，自动执行你明确确认的一项可信只读工具。普通聊天、立即运行、共享来源和写入操作仍需逐次审批。',
  'appPolicies.refresh': '核对授权',
  'appPolicies.unknown':
    '授权结果待核实。先核对原请求；取消会撤销已接纳的授权，或阻止尚未接纳的旧请求稍后生效。',
  'appPolicies.cancelUnknown': '取消本次授权',
  'appPolicies.status.active': '有效',
  'appPolicies.status.invalidated': '范围已变化，需重新确认',
  'appPolicies.status.revoked': '已撤销',
  'appPolicies.revoke': '撤销授权',
  'appPolicies.routine': '已保存的例行任务',
  'appPolicies.chooseRoutine': '选择例行任务',
  'appPolicies.noRoutines': '先为本地 Bot 保存并启用一个例行任务，再来确认授权。',
  'appPolicies.tool': '可信只读工具',
  'appPolicies.chooseTool': '选择实际工具',
  'appPolicies.noTools': '此连接没有声明为只读的可选工具。未知或写入工具仍需逐次审批。',
  'appPolicies.arguments': '固定参数（JSON 对象）',
  'appPolicies.exactScope':
    '仅当工具、参数和任务配置完全匹配时自动执行。参数变化将重新询问；编辑任务、连接或工具会使原授权失效。注解是服务商声明，不保证工具实际只读。',
  'appPolicies.confirm':
    '我信任此服务，并确认该工具只读取以上参数指定的资料，不执行写入或其他操作。',
  'appPolicies.create': '确认此只读授权',
  'appPolicies.argumentsInvalid': '请输入不超过 16 KiB 的有效 JSON 对象参数。',
  'appPolicies.storageUnavailable':
    '无法保留本次授权的核对标识，暂不能创建新授权。现有授权不受影响。',
  'appPolicies.failed': '授权请求未完成，请核对原结果。',
  'appPolicies.changed': '任务或应用工具已变化。请先核对原请求，再查看当前范围并重新确认授权。',
  'appPolicies.closed': '这次授权请求已取消。请先核对或结束原请求，再开始新的授权。',
  'appPolicies.audit':
    '按 {{owner}} 为“{{routine}}”确认的固定只读范围执行；此卡保留实际参数和结果。',
  'appPolicies.you': '你',
  'appPolicies.owner': '空间拥有者',
} as const;
