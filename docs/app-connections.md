# 应用连接

侧栏“连接应用”管理真实的 MCP HTTP 服务。列表、搜索、新增、详情、工具说明、重新授权、断开和移除共用现有弹窗与表单。工作空间文件、电脑和模型保留在“工作环境”区域。应用目录提供已登记服务商的官方 MCP 地址及文档。连接状态以实际授权和工具发现为准。

目录的“无需登录”筛选可以找到支持匿名连接的服务。应用卡在连接前显示认证方式，在连接后显示实际状态。

网页、桌面和移动端的“添加连接”支持粘贴 `mcpServers` 或 VS Code `servers` 配置。客户端只提取名称和 HTTPS 地址，交给当前工作空间服务预览；不会发送原始配置中的密钥、请求头或环境变量，也不会在预览时连接外部服务。从支持的项目中选择一项后，表单会填入可编辑的名称和地址。完整地址匹配官方目录时，表单会预选推荐的认证方式。修改地址会清空已填令牌和共享确认；替换现有草稿需要重新确认。格式、边界与接口详见[配置导入](mcp-configuration-import.md)。

## 使用范围

空间拥有者提供服务名称、HTTPS 地址，选择无需认证、Bearer 访问凭据或网页登录授权，并确认与当前空间的 Bot 共享。连接成功后显示实际发现的工具和最后检查时间。凭据无效会进入“需要重新授权”；最初选择无需认证的连接也可补充凭据。断开清除本地保存的凭据与可用工具，重新使用需要再次连接；移除还会删除连接记录，历史操作消息保留。

网页登录授权需要服务支持 MCP OAuth 发现和授权码流程，不是输入任意网站即可接入。打开授权页面后，先用发起连接的同一个 BambooShift 账号登录，确认空间和权限范围，再进入服务商页面。回到最初的窗口点击“完成连接”，服务端才兑换授权码并读取实际工具。只有授权信息保存成功并不保证服务当前可用；工具连接状态另行显示。桌面客户端仅通过专用入口打开同源授权页面，不接受任意外部地址。

授权支持预注册客户端、公开客户端元数据或动态客户端注册，使用 S256 PKCE；服务有要求时可填写 Client ID 和 Secret。远程部署须配置固定 HTTPS 公共来源，本机默认回调为 `http://127.0.0.1:3001/api/app-oauth/callback`。服务商是否允许本机回调取决于其配置。授权码、校验值和访问凭据不进入公开状态；账号退出、空间权限变化、连接修改、取消、过期或重启都会终止未完成流程。

有刷新令牌的授权可在调用前刷新，同一连接并发请求合并为一次刷新。刷新失败或结果不明时要求重新授权；工具请求返回 401 不自动刷新并重放操作。断开后立即停止本地使用，并尝试服务声明的撤销接口；界面区分已撤销、不支持撤销及撤销失败，后两种情况可以去服务商处移除授权。

连接属于当前个人或团队空间。同一空间的 Bot 可以请求使用，普通团队成员可以查看连接和工具，并批准自己发起任务的操作；只有空间拥有者能管理连接。其他个人或团队空间不能仅凭连接 ID 访问此连接；通过共享 Bot 使用来源连接需要下述明确工具授权。独立平台运营会话不会因此获得空间凭据或工具权限。这一版不提供团队内每位成员的私人应用授权。

每次工具调用都在聊天中展示应用、工具名称和原始参数。默认由任务发起者“批准一次”后才能发出，包括声称只读的工具。空间拥有者可为服务器计划触发的本地 Bot 任务明确设置一项[精确只读应用授权](app-routine-policies.md)；只有原任务、原工具及完全相同的参数匹配时自动批准，并保留实际操作卡。拥有者不能代替其他成员审批；定时任务由空间拥有者身份负责。拒绝、停止自己的任务、本人补充新要求、原登录失效、审批过期或服务重启会使尚未执行的审批失效。其他成员发言排队，不取消这次审批。凭据、连接版本或工具说明发生变化后，旧审批也不能执行。审批有效期为五分钟。

执行后丢失响应或被取消时，外部服务可能已经完成操作。界面显示结果未知，不自动重新调用；取消请求、终止 MCP 会话和断开连接都不代表撤销外部副作用。先到服务中核对结果，再决定后续任务。

## 服务商设置

### Slack 公开频道

在 Slack 创建组织内部应用，或使用已获准的 Marketplace 应用。注册当前 BambooShift 公共 HTTPS 地址加 `/api/app-oauth/callback` 作为 OAuth 回调，配置用户权限 `search:read.public`、`channels:read` 和 `channels:history`。有审批策略的 Slack 工作区由管理员批准应用。在 BambooShift 选 Slack 后，在网页登录授权的高级选项填写该应用的 Client ID 和 Client Secret。工具目录限定公开检索、查找频道和读取线程。已积累额外权限的 Slack 授权需要在 Slack 撤销后重新授权。当前流程仍待使用已获授权的 Slack 测试工作区验收。[Slack MCP 说明](https://docs.slack.dev/ai/slack-mcp-server/) · [OAuth 配置](https://docs.slack.dev/authentication/installing-with-oauth/)

### Gmail 开发者预览

Google 将 Gmail MCP 列为开发者预览，并将该阶段限制在获准的测试范围内。预览项目需开启 Gmail API 和 Gmail MCP API，再登记启用 AI 代理选项的 Web OAuth 客户端。邮件搜索和读取支持单独使用 `gmail.readonly`，需要离线刷新时应请求 `access_type=offline`。公开应用目录将在 Gmail MCP 正式发布后评估接入。[Google 预览条款](https://developers.google.com/workspace/preview) · [Gmail MCP 配置](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) · [邮件搜索权限](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads)

已正式发布的 Gmail REST API 仍将 `gmail.readonly` 列为受限权限。为个人邮箱提供应用连接时，需要逐人保存授权、明确邮件使用及保留规则，并按 Google 要求完成 OAuth 验证和适用的安全评估。当前 BambooShift 空间连接面向空间内的 Bot 和成员。[Gmail 权限说明](https://developers.google.com/workspace/gmail/api/auth/scopes) · [Google Workspace 用户数据政策](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

### GitLab.com

先在 GitLab.com 顶级群组开启 MCP，再从 BambooShift 应用目录选择 GitLab 并完成网页登录授权。GitLab 通过 `mcp` 权限提供由账号和群组配置决定的工具。核对 BambooShift 聊天中的具体工具和参数后逐次批准。公开 OAuth 发现已使用现有执行器验证，账户授权与群组工具仍需使用获准的测试账号验收。[GitLab MCP 文档](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)

### Microsoft Learn

Microsoft Learn 提供公开的微软与 Azure 文档检索、文档读取和代码示例搜索。选择“无需认证”即可连接，具体工具调用遵循 BambooShift 审批流程。已通过 BambooShift MCP 执行器验证工具发现和官方文档检索。[Microsoft Learn MCP 文档](https://learn.microsoft.com/en-us/training/support/mcp)

### Context7 和 AWS Knowledge

Context7 可查询开发库的最新文档和指定版本的代码示例。AWS Knowledge 可检索 AWS 官方文档、架构指引及服务的区域可用性。两者都可以匿名连接，服务商会限制匿名请求频率。工具请求仍按聊天中的应用审批规则处理。[Context7 文档](https://context7.com/docs/installation) · [AWS Knowledge MCP 文档](https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server)

## 通过共享 Bot 提供应用

来源拥有者可在 Bot 的共享设置中，从已连接应用里逐项选择工具，查看说明和参数后“保存并共享”。选择固定连接版本和各工具的完整定义摘要；新工具不会自动加入。最多授权 20 个连接、每个连接最多 64 项工具，已选工具说明及参数合计不超过 512 KiB。浏览目录不发布授权，也不会发起远端调用。

接收者加入自己的个人空间后，在“连接应用”的“发布者提供的应用”区域查看，只读使用已经批准的工具；自己的连接保留在独立区域。应用使用发布者的来源账户，但每次调用仍由当前任务发起者批准一次，来源拥有者不能代批。审批明确标注来源和参数；参数会发送给对应外部服务。成员不能修改来源连接、查看来源地址或凭据，也不能借已选工具的 ID 调用未选工具。

来源重连、换凭据、重新网页登录授权及工具说明或参数变化会使旧授权失效。拥有者需要查看新版、明确更新选择并保存；移除授权、撤销分享或成员资格变化立即限制后续调用，已发出的操作依然可能结果未知。正常 OAuth 刷新只更新服务端令牌，在主体和授权范围保持一致时不改变共享连接版本，不要求重新选择工具；刷新失败或范围变化则停止使用。

实际调用在来源服务端复用已有连接和凭据，个人空间只保存本人的审批与结果。相同连接 ID 也不会把来源操作改投个人连接。没有自动初始化来源空间、复制凭据或让接收者继承来源电脑登录；来源服务不可用时明确提示失败。发布者来源应用不使用个人例行任务的只读预授权，仍逐次审批，不提供“始终允许”或自动扩大授权工具范围。分享范围、私人会话和撤权规则详见[共享 Bot](shared-bots.md)。

## 实现

- [Rust 连接服务](../server/api/src/apps/connections.rs)保存空间连接，投影公开元数据并检查版本。[MCP 执行器](../server/workers/mcp-worker/README.md)使用锁定的官方 SDK，仅承担协议和网络执行，不持有业务数据库。
- [Rust 操作服务](../server/api/src/apps/actions.rs)持久化审批与操作卡，绑定可信运行身份；先记录批准，再最多发出一次调用。重启不重放待批准或结果未知的请求。
- [Rust OAuth 服务](../server/api/src/apps/oauth.rs)与[事务存储](../server/api/src/apps/oauth_store.rs)保存空间内的短期授权事务，绑定原窗口和授权浏览器的会话、空间、连接版本及一次性浏览器 Cookie。跨站回调只接收结果，再跳转到无查询参数的固定页面；明确完成前不兑换。终态清除临时秘密。[OAuth 执行适配器](../server/workers/mcp-worker/oauth-provider.ts)及[网络策略](../server/workers/mcp-worker/oauth-network.ts)限制发现、兑换、刷新与撤销；独立授权服务器可使用与 MCP 不同的公网来源。
- Pi 通过 `app_list`、`app_tools`、`app_call` 接入。目录支持检索，单次最多十项并限制返回大小；模型不能自行添加服务、修改凭据或批准请求。服务描述和返回数据按外部资料处理，不给予采样、文件根目录或反向工具调用能力。
- 共享来源应用使用独立的 `shared_app_list`、`shared_app_tools`、`shared_app_call`。[Rust 来源应用读取器](../server/api/src/shared_bots/source_apps.rs)只读核对来源目录；中央分享记录只保存连接与所选工具的版本清单，不保存完整 schema 或凭据。Rust 应用服务为每个操作固定可信执行器与发起者；来源变化会同时复核个人运行及其审批，子任务完成后仍保留整个根任务的来源版本检查。
- 连接和动作分别存于当前空间 SQLite 的 `app_connections`、`app_actions` 表，位于 Bot 可访问的 `workspace/` 之外。凭据保存在空间私有 `config/apps.private.json`，数据库只保存引用；旧内联凭据由受控初始化迁移。不进入 Bootstrap、工具目录、审批参数或消息结果。私有目录及 `0600` 文件权限不是独立加密保管库，服务器管理员仍须保护配置和备份。
- HTTP 仅允许公网 HTTPS 默认端口，无用户名、密码、查询参数或片段。DNS 解析设置时限并固定解析结果；拒绝所有跳转和内网地址，不读取环境代理，不提供自定义请求头或本地命令入口。生产请求不能启用测试地址例外。
- 每空间最多二十个连接；每连接最多六十四个工具，目录总计不超过 512 KiB；调用参数不超过 16 KiB，HTTP 响应不超过 1 MiB。返回的文本和结构化结果先隐藏已知凭据，再截断过长结果；非文本资源、图片和外部链接不会被自动读取。

API 位于当前空间路径 `/api/workspaces/:workspaceId` 下：`GET/POST /apps`、`GET /apps/:id/tools`、`POST /apps/:id/reconnect`、`POST /apps/:id/disconnect`、`DELETE /apps/:id`、`POST /app-actions/:id/decision`。账号模式下写入携带 `X-OpenBot-Expected-User`；服务端同时核对当前会话、成员关系，以及连接管理的拥有者或操作审批的发起者身份，异步执行前后再次核对权限。前端请求固定账号与空间，切换或卸载后丢弃迟到响应。

来源授权的 owner 目录位于 `GET /agents/:agentId/sharing/apps` 与 `GET /agents/:agentId/sharing/apps/:connectionId`，共享设置在原 `PUT /agents/:agentId/sharing` 中一并保存。成员通过 `GET /api/shared-bots/:shareId/apps` 和 `GET /api/shared-bots/:shareId/apps/:connectionId/tools` 查看获准内容。这些读取也固定 `X-OpenBot-Expected-User` 并验证当前分享资格；不会返回服务地址或密钥。

任务发起者、停止与撤权规则见[共享 Bot](shared-bots.md)。当前团队空间的应用与会话仍团队可见；加入个人空间后的聊天、审批和结果保持私有。使用明确授权的来源工具不把来源应用凭据复制到个人空间。

## 验证与剩余范围

真实本地 MCP HTTP/SSE 服务、临时 SQLite、生产 Pi 运行时和受控模型端点用于验证协议、审批和任务生命周期。使用合成凭据和合成操作，没有登录真实第三方账户或调用付费模型；React 源码渲染与处理函数测试不替代产品浏览器视觉验收。完整结果见[验收记录](verification.md)。

来源应用另通过真实平台 HTTP、生产 Pi 与自有 MCP 服务检查发布者/成员权限、所选工具目录、个人与来源同 ID 连接的隔离、本人逐次审批、正常令牌刷新、连接变更和执行中撤权。上述非 GUI 验收不代表共享选择页面、手机操作或真实第三方账户已经完成产品验收。

服务商目录只提供真实连接入口，不自动安装应用。尚未包含每成员私人连接、私网批准连接、stdio 服务、MCP 文件资源下载或 DPoP。OAuth 协议、账号绑定、刷新和撤销已有本地服务回归，真实第三方账户授权及产品浏览器操作仍未验收。远程电脑内的网站登录与本功能分别管理。
