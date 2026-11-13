export default {
  mcpImportOpen: '导入 MCP 配置',
  mcpImportHelp:
    '粘贴 mcpServers 或 VS Code servers JSON。凭据和命令在本机移除，仅将名称、地址交给当前工作空间预览，不访问外部服务。核对并提交表单后才会连接。',
  mcpImportInspectBusy: '正在检查地址…',
  mcpImportInspectFailed: '暂时无法预览地址，请重试或手动填写服务。',
  mcpImportNeedsUpdate: '当前工作空间需要更新才能预览导入，你可以先手动填写服务。',
  mcpImportJson: 'MCP 配置 JSON',
  mcpImportInspect: '识别远程服务',
  mcpImportChoose: '远程服务',
  mcpImportChoosePlaceholder: '选择一个服务',
  mcpImportApply: '填入名称和地址',
  mcpImportCancel: '取消导入',
  mcpImportReplace: '替换当前表单',
  mcpImportReplaceHelp:
    '替换草稿会清空令牌和共享确认。识别到官方地址时，表单会预选推荐的认证方式。取消导入可保留当前草稿。',
  mcpImportSkipped: '已跳过 {{count}} 个不支持、无效或重复的条目。',
  mcpImportInvalidJson: 'JSON 格式不正确，请粘贴完整的配置对象。',
  mcpImportInvalidShape: '请使用包含 mcpServers 或 servers 的 JSON 对象。',
  mcpImportTooLarge: '配置最多包含 65,536 个字符。',
  mcpImportTooMany: '每次最多导入 100 个服务条目。',
  mcpImportNoRemote:
    '未找到支持的远程服务。请使用 HTTP 传输的公网 HTTPS 域名，地址不能包含凭据、查询参数或片段。不导入本地命令、内网地址和旧式 SSE 服务。',
};
