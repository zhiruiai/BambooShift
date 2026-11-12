export default {
  mcpImportOpen: '导入 MCP 配置',
  mcpImportHelp:
    '粘贴包含 mcpServers 或 VS Code servers 的 JSON 配置。只填入名称和公网 HTTPS 地址，忽略凭据与命令。核对并提交下方表单之前，不会连接任何服务。',
  mcpImportJson: 'MCP 配置 JSON',
  mcpImportInspect: '识别远程服务',
  mcpImportChoose: '远程服务',
  mcpImportChoosePlaceholder: '选择一个服务',
  mcpImportApply: '填入名称和地址',
  mcpImportCancel: '取消导入',
  mcpImportReplace: '替换当前表单',
  mcpImportReplaceHelp:
    '这会替换当前名称和地址，清空令牌，并重置认证方式和共享确认。取消导入可保留当前表单。',
  mcpImportSkipped: '已跳过 {{count}} 个不支持、无效或重复的条目。',
  mcpImportInvalidJson: 'JSON 格式不正确，请粘贴完整的配置对象。',
  mcpImportInvalidShape: '请使用包含 mcpServers 或 servers 的 JSON 对象。',
  mcpImportTooLarge: '配置最多包含 65,536 个字符。',
  mcpImportTooMany: '每次最多导入 100 个服务条目。',
  mcpImportNoRemote:
    '未找到支持的远程服务。请使用 HTTP 传输的公网 HTTPS 域名，地址不能包含凭据、查询参数或片段。不导入本地命令、内网地址和旧式 SSE 服务。',
};
