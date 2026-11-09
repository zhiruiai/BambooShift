# 参考界面与功能核对

本页核对用户提供的 19 张截图、[教程视频](https://www.youtube.com/watch?v=q1IwR88mhaA)的章节、字幕与关键画面，记录当前源码的真实范围。视频与截图用于分析交互；PandaMate 使用自己的品牌、头像与实现，不分发参考媒体。当前仍处于整合验收阶段，不能将某个模块通过等同于整个版本已完成。

## 界面和交互

| 参考体验 | PandaMate 实现与核对 |
| --- | --- |
| 三栏协作 | 同事与群聊侧栏、聊天工作区、详情/资料库/电脑/记忆或成员面板；统一紫灰主题。 |
| 开始聊天 | 搜索实际存在的 Bot/群聊，键盘选择；名字完全匹配优先，创建 Bot/群聊/智能组队共用既有流程。 |
| 输入快捷操作 | `/` 显示有效技能、设置、电脑、应用和任务入口。`@` 可按光标选择实际 Bot 或已连接应用，保留前后草稿、附件和引用，并处理输入法。群聊可选择多个 Bot，或用 `@everyone` 点名当前成员。 |
| 对话操作 | Bot 可以在单聊、群聊或回复线程发一张单选或多选问题卡。原任务发起者提交后，答案回到提问的 Bot，普通消息草稿继续保留。单聊和群聊的气泡附近提供表情、引用与更多操作；键盘、触控、右键可操作。群聊保留发言者归属，引用和消息链接定位到原消息。连续消息共用头像和时间，委派可展开看指令，任务等待时不留下空白或重复闪动的回复气泡。参见 [Grok Bot 官方协作说明](https://docs.x.ai/grok-bot/chat-and-collaboration)。 |
| 设置 | 账户卡片、外观/强调色/语言/拼写检查，独立工作设置、记忆、用量、通知、设备、模型及更新类别。 |
| 原创形象 | 伙伴、熊猫、恐龙、小鸡、大象五套角色主题。Flutter 可在外观设置预览和确认 AI 设计，也能审阅聊天中的主题提案。Web、桌面和 Flutter 可选择把头像主题同步到自己在当前空间的账号。个人和团队空间分别保存，团队成员的选择各自独立。已上传头像优先显示。聊天、名单、群聊组合头像与上传裁剪共用权限校验。Android 和 iOS 的头像编辑在设备相机可用时提供拍照入口，拍照后通过同一裁剪和保存流程应用。 |
| 例行任务 | 支持频率、时区、开关、编辑、删除和运行历史。个人空间本地 Bot 的单聊之间可以转交任务，保留计划与历史。空间拥有者可为本地 Bot 的单聊任务授权固定公开查询，也可设置 [Webhook 触发](routine-webhooks.md)。 |
| 文件 | [文件预览](file-previews.md)支持 Markdown 排版与源码、HTML 章节/折叠/图示/答题、PDF 分页、Office 内容、表格和媒体；聊天、资料库和电脑传输结果共用预览，保留原件下载。 |
| 智能创建与外观 | Web、桌面和 Flutter 的新建 Bot 与外观设置支持自然语言草稿。空间拥有者可在本地单聊让 Bot 提议新角色或头像主题。单 Bot 草稿经核对进入可编辑的创建表单，确认后才会建立新会话。主题可先预览，确认同步时仅保存所选主题和结构化设计。Grok Bot 的单 Bot 外观入口包含形状、图片生成和上传。参见 [Grok Bot 官方创建说明](https://docs.x.ai/grok-bot/bots)。 |
| 连接应用与弹框 | 连接应用展示分类、搜索、连接状态和实际操作，长内容在弹框内部滚动；宽屏目录并排展示，窄屏头像选择能完整点到。 |
| 多端布局 | 响应式 Web/PWA、Electron 桌面端和独立 Flutter 移动端。真机验收状态见下文。 |

## 桌面与移动端功能差距

对照 Grok Bot 官方桌面和移动文档，优先核对聊天、历史工作、文件和设备能力。

| 场景 | 本轮完善 | 仍有差距 |
| --- | --- | --- |
| 查找历史工作 | Web、桌面和 Flutter 按会话、消息、文件、例行任务、链接和网站分类搜索。Web 与桌面可在当前会话或工作空间内查找，并可逐批查看更多结果。Flutter 的「全部」提供分类预览，点进分类可查看完整匹配。网站命中打开对应的交付版本，链接命中跳到原消息或回复线程。会话资料库汇总本会话中最近出现的链接。 | 历史范围限于当前登录者可访问的工作空间。 [桌面搜索](https://docs.x.ai/grok-bot/chat-and-collaboration#find-prior-work) · [移动搜索](https://docs.x.ai/grok-bot/mobile#search-and-review-prior-work) |
| 聊天与语音 | Web、桌面和 Flutter 的独立回复线程各有草稿和消息记录。Pi 读取线程根消息和线程历史，主聊天和其他线程的任务独立排队。群聊可以点名多个 Bot 或 `@everyone`，每位 Bot 独立排队，原消息可展开查看每位接收方的交付状态。同一提交重试沿用原接收名单。Flutter 支持 Markdown、引用和回跳、表情回应。iOS 和 Android 原生代码已接入系统分享，允许选择会话并把内容加入草稿。Bot 单聊支持前台语音通话。个人空间可选择让本地 Bot 用语音留言回复，音频与文字稿保存在原会话，三个客户端支持播放和暂停。 | iOS 签名和真机流程、跨会话继续通话、断线恢复、语音留言逐词高亮与点击定位。 [移动聊天](https://docs.x.ai/grok-bot/mobile#message-a-bot) · [语音留言](https://docs.x.ai/grok-bot/chat-and-collaboration#play-a-voice-memo) · [更新日志](https://x.ai/changelog/bot) |
| 桌面客户端 | 「帮助 → 键盘快捷键」列出已支持的按键，支持 `⌘/` 和 `Ctrl+/`。macOS 从 Dock 重开已关闭的窗口时恢复原服务。 | Dock 未读角标、设备间通知分流、离线推送和签名自动更新。 [快捷键](https://docs.x.ai/grok-bot/chat-and-collaboration#keyboard-shortcuts) · [通知](https://docs.x.ai/grok-bot/settings-and-notifications#control-notifications) |
| 文件和网站项目 | Web、桌面和 Flutter 均可从聊天卡片或会话资料库打开多文件网站，查看预览、源码和历史版本，导出源码 ZIP。Flutter 支持全屏。网站可分享给指定成员、当前团队或持有公开链接的人，也可撤回链接。 | 手机端更多富文档格式、原生 WebView 实机验收及公网部署。 [文件与 Pages](https://docs.x.ai/grok-bot/files-and-results#share-a-page) |
| 电脑与审批 | 云电脑、本地工作进程、公开网页检索、手动接管和聊天审批已有入口。私密接管期间，只有当前接管窗口可刷新该画面。其他团队成员、普通预览和 Bot 观察会暂停。Flutter 手动输入默认遮挡。 | 即时电脑画面、通用审批规则、Vault 和保密表单。手机系统日历、联系人与快捷指令仍需单独接入系统权限。 [电脑与应用](https://docs.x.ai/grok-bot/computer-and-apps) · [审批](https://docs.x.ai/grok-bot/approvals-security-and-privacy) · [手机应用](https://docs.x.ai/grok-bot/mobile#let-a-bot-use-your-phones-apps) |

## 执行电脑与头像状态

[Grok Bot 的电脑说明](https://docs.x.ai/grok-bot/computer-and-apps)区分持久云电脑和本机能力。PandaMate 保留这个区分：内置工作浏览器由服务所在电脑运行；绑定到一个空间的独立 Worker 可以放在自有云服务器上，也可由拥有者部署到自己的电脑。默认模式不读取日常桌面。配置和授权要求见[电脑执行层](computer.md)。Grok Bot 的托管电脑、凭据 Vault、专用外部渠道和组织级策略仍是单独的产品能力，不能从电脑连接或聊天交互推断已经对齐。

头像使用 PandaMate 原创图形。进入待机会话时，当前 Bot 轻眨眼睛；工作中轻微起伏，需要当前用户操作时短暂倾斜，刚完成时短暂回弹。历史消息中的头像保持静止。开启减少动态效果后仍可通过文字了解状态。Web 和桌面共用同一界面，Flutter 有独立实现。

## 工作流程

### Bot 提问

本地 Bot 在人工对话中可通过 Pi 的 `ask_question` 发一张待回答卡。一次运行最多一张，允许单选或多选，提供 2 至 6 个选项。卡片会留在原会话或回复线程，原运行可以结束。只有原任务发起者能提交。选择会和一条精确送给提问 Bot 的后续消息一起保存。同一答案可跨设备核对，已答后不能替换。后续运行回读原请求和已选择的选项，选择本身不授予应用或电脑操作权限。当前卡片收集预设选项，连续问卷和自由输入仍待补齐。 [Grok Bot 群聊问题说明](https://docs.x.ai/grok-bot/chat-and-collaboration#direct-a-message) · [多选问题更新记录](https://x.ai/changelog/bot)

### 公网搜索、模板与连接

- Pi 的 `web_search` 直接调用公开搜索服务。一个任务及其子 Bot 共享 12 次新查询，同一查询和结果数的成功结果在任务内复用。失败会释放新查询名额，外部请求仍有独立的硬上限。上游限流、重试耗尽和任务查询用尽各有提示。搜索结果缺少标题时使用已校验的公开网址作显示文字。输入具体公开链接可交给独立的 `web_fetch`。隔离账户验收使用真实 Exa，让 Pi 连续取得 12 个不同查询的结果，确认第 13 个新查询触发本地额度、已有结果仍可复用，且另起任务后恢复额度。公开网页检索卡由 Rust 根据实际工具回执生成，同一 Bot 本轮的查询、缓存和已读网页合并展示。不同任务限额和上游限流有独立说明，展开可查看来源。原始查询、网页正文和服务错误详情不写入卡片。
- Web、桌面和 Flutter 共用七个中英文原创 Bot 模板，均可搜索、按类别筛选、查看长期指令和编辑后创建。空间拥有者可在各端的模板库预览六个原创团队模板，覆盖产品发布、财务月结、客户支持、课后学习、短视频与会议跟进。核对分工后可载入并编辑成员和负责人，载入模板无需连接模型。 [Grok Bot 工作场景](https://docs.x.ai/grok-bot/use-cases)
- Web、桌面与 Flutter 可用 `@` 为本地 Bot 的单次任务选择一个已连接应用。请求固定应用版本，版本变化或断开后会拒绝执行。个人空间拥有者可在单聊中为 GitHub 官方只读连接的一个 Issue 保存「始终允许」。同一 Bot、同一会话、相同仓库与编号再次命中时会留下使用记录。可在「连接应用 → 已保存的应用权限」撤销。其他聊天操作继续由任务发起者审批，例行任务使用独立规则。 [Grok Bot 审批说明](https://docs.x.ai/grok-bot/approvals-security-and-privacy) · [GitHub 官方只读端点](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- 个人空间拥有者可在本地 Bot 的单聊或回复线程提供自定义公网 HTTPS MCP 地址，收到待核对卡。Bot 只能建议原消息直接给出的完整地址，引用、代码块和历史链接不能替代原消息。打开卡片后，拥有者核对锁定的地址，选择认证并明确确认共享，随后才发起连接。相同完整地址复用已有连接，自定义路径的尾斜线会保留。团队仍由拥有者在「连接应用」中手动添加。 [Grok Bot 自定义工具说明](https://docs.x.ai/grok-bot/how-grok-bot-works#add-your-own-tools)
- 「连接应用」的应用详情支持逐个启停工具。所有者可修改，普通成员可查看。停用会移出 Pi 的工具列表，原待审批操作、例行授权和共享范围中对应的权限随之失效。同一连接里的其他工具可继续工作。重新启用后需要重新授权。 [Grok Bot 连接应用](https://docs.x.ai/grok-bot/settings-and-notifications#connected-apps)
- 本地 Bot 可在人工会话里按应用名称、产品关键词或类别查询官方目录，查询结果只含识别信息和当前空间的连接状态。原任务由空间拥有者发起时，Bot 可留下连接建议。Web、桌面和 Flutter 的卡片会随连接状态更新，核对后打开对应的新建表单、已有连接或授权页面。实际连接仍由拥有者确认共享范围。 [Grok Bot 聊天连接卡片](https://docs.x.ai/grok-bot/computer-and-apps#connect-an-app)
- Web、桌面和 Flutter 在「连接应用」中提供七套中英文内置技能。成员可搜索并预览完整指令。空间拥有者选择本地 Bot 后可编辑草稿，提交后等待单独审核，批准后才可执行。Web、桌面与 Flutter 的团队技能目录支持发布和同步已审核技能。团队成员可预览并把固定版本导入自己拥有的个人空间 Bot，团队拥有者也可导入到本团队的本地 Bot。团队导入保留版本来源并进入待审核状态。团队拥有者可撤回发布，撤回后禁止新导入。移动应用目录支持按类别搜索、查看连接状态和填入连接草稿。 [Grok Bot 技能与例行任务](https://docs.x.ai/grok-bot/skills-routines-and-automations#save-a-skill) · [连接应用](https://docs.x.ai/grok-bot/computer-and-apps#connect-an-app)
- 个人空间的「连接应用 → 私有技能」汇总已审核且启用的原始技能。拥有者可核对全文，选择同空间的另一个本地 Bot，启用固定版本。源技能更新或删除时，已启用的版本仍可单独停用。碰到同名的已启用技能时，需要先处理该 Bot 原有的版本。 [Grok Bot 私有技能](https://docs.x.ai/grok-bot/skills-routines-and-automations#save-a-skill)
- 从「私有技能」可以向有权限的团队发布已审核原版。团队默认只允许拥有者发布，拥有者可开放成员发布。成员可同步或撤回自己的发布，拥有者可撤回其他成员发布并阻止同一来源重新发布。团队链接需当前成员登录，随同步保留，撤回后永久失效。先前导入的副本仍保留审核版本。 [Grok Bot 技能分享](https://docs.x.ai/grok-bot/skills-routines-and-automations#share-a-skill-with-your-team)
- 内置连接预设覆盖 Notion、Linear、GitHub、Sentry、Atlassian、Slack、GitLab、Microsoft Learn、Cloudflare Docs 和 DeepWiki。后三项可在无需登录的情况下查询微软文档、Cloudflare 开发文档或公开 GitHub 仓库的文档。GitLab 已验证官方 OAuth 发现，真实账号仍待授权。Slack 需要注册应用和公开 HTTPS 回调，提供公开消息搜索、频道搜索及读取会话串。Gmail MCP 受 Google 开发者预览发布限制，未进入公开目录。 [Microsoft Learn](https://learn.microsoft.com/en-us/training/support/mcp) · [Cloudflare Docs](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) · [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp) · [GitLab](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) · [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/) · [Google 预览规则](https://developers.google.com/workspace/preview)

### 多文件网站的交付

Grok Bot 把附件和 Pages 分成两类。单个 HTML 附件可以查看预览和源码。Pages 则是资料库中的持久对象：聊天里先出现打开卡片，桌面端在页面旁保留对话，用户可以继续让 Bot 修改同一页，旧卡片也会指向新版。Pages 默认私有，用户可以选择分享范围。官方文档建议把制作过程的多份文件放进共享电脑的项目目录，但没有说明 Pages 会交付保留目录结构的源码；更新日志记录的共享页面下载格式是 PDF。[文件与 Pages](https://docs.x.ai/grok-bot/files-and-results) · [Grok Bot 更新日志](https://x.ai/changelog/bot)

对需要完整源码和运行环境的站点，公开资料给出另一条路径：Grok Bot 可以把编程工作交给 Cloud Agent；Cursor 的 Cloud Agent 在独立电脑中运行项目，可以通过端口转发在浏览器预览，可将源码保存到仓库，并在选择发布后得到公开地址。这些是 Cursor 公布的能力，不能据此认定 Grok Bot 的 Pages 附件具备同样的源码交付或发布流程。[Cloud Agent 项目预览与发布](https://cursor.com/docs/cloud-agent/setup)

PandaMate 的「网站项目」卡片保留入口页、相对路径和每次交付的版本。桌面可以一边预览一边在聊天里要求 Bot 修改项目，也可以浏览源码或下载保留目录结构的 ZIP。资料库展示每个项目的最新版本，聊天里的旧卡片保留历史版本。Flutter 从卡片全屏打开，可查看来源版本或切换到同一会话的最新版本，并校验文件清单和 SHA-256。预览支持包内静态资源、站内链接和部分 JavaScript 交互，包括 WebGL 画布。需要完整浏览器 API、外部依赖或后端服务的项目可下载源码并在相应环境运行。

项目默认保留在工作空间。创建人或空间拥有者可以把明确选定的交付版本分享给指定成员、团队或持有公开链接的人。公开前需要确认预览版本。切换到新版本需明确更新，同一链接地址可继续使用；撤回或更换链接后，旧链接与其资源请求失效。分享者在现有 Web 服务上提供预览，跨设备访问依赖该服务的网络可达性。

[视频 1:20 的建 Bot](https://www.youtube.com/watch?v=q1IwR88mhaA&t=80s)对应可编辑的名称、角色、简介、长期指令和头像。原创模板提供完整工作方式的预览，确认后仍走原来的持久创建请求，不带入虚构历史、模型密钥或已运行任务。用户发布模板与实时共享 Bot 保持不同语义，见[模板](bot-templates.md)和[共享](shared-bots.md)。

[视频 5:12 的教学](https://www.youtube.com/watch?v=q1IwR88mhaA&t=312s)对应电脑面板中的人工演示：用户先接管，记录成功操作概要，检查/删改步骤与补充说明，再明确生成一份待审核技能。录制绑定 Bot、会话、画面与接管租约，不收集输入正文、密码或截图。生成不自动启用技能，也不自动重放操作。

[视频 6:37 的同事沟通](https://www.youtube.com/watch?v=q1IwR88mhaA&t=397s)对应真实 Pi 子会话：个人主 Bot 在合法人工私聊中可调用已有同事，同事在自己的已有单聊工作，主 Bot 获得本次结果；群聊仍限定本组成员。记忆、技能、任务发起者和取消代际均有服务端边界，见[个人 Bot 协作](personal-bot-coordination.md)。

[视频 7:16 的例行任务](https://www.youtube.com/watch?v=q1IwR88mhaA&t=436s)支持每天、工作日、每周选定日期和固定间隔，使用 IANA 时区，保存真实 nextRunAt 和运行终态。未知响应只核对原请求；不会用自动重发来掩盖不确定结果。转交支持个人空间本地 Bot 的唯一单聊之间，运行或排队时拒绝转交。

Grok Bot 的例行任务要求确认输入来源与审批边界。PandaMate 的拥有者可给本地 Bot 的单聊例行任务授权最多四条固定公开查询。Pi 直接通过 Exa 搜索，并可读取本轮返回的公开网页，无需分配电脑。转交会清除授权。 [Grok Bot 例行任务](https://docs.x.ai/grok-bot/skills-routines-and-automations#create-a-routine)

[视频 3:03 的应用连接](https://www.youtube.com/watch?v=q1IwR88mhaA&t=183s)对应真实 MCP/OAuth/Bearer 连接。目录预设使用 [Notion](https://developers.notion.com/guides/mcp/get-started-with-mcp)、[Linear](https://linear.app/docs/mcp) 和 [GitHub](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) 的官方端点；选择预设只填表，不连接账户。工具调用默认由真实发起者审批；拥有者可明确授予一个例行任务、一个工具和固定参数的只读权限，见[精确只读授权](app-routine-policies.md)。真实第三方账户授权仍需部署者亲自完成。

## 数据、权限与客户端

Rust 业务后端已经替代 Node 业务服务；Pi、MCP、电脑和文档仍以独立 SDK 工作进程运行。账户、个人与团队空间、邀请、模型、文件、审批和持久化复用领域服务，代码目录和执行边界见[架构](architecture.md)。

平台运营站点独立构建和监听，管理全平台用户与空间，使用运营专属会话。团队拥有者不自动成为运营人员。普通产品入口不挂载运营 API，运营入口不挂载聊天 API。

实际模型用量来自 Pi 返回的 token 报告；未报告轮次与费用未知会明确显示。没有根据模型名称编造账单或共享额度。通知默认关闭，只提醒新完成任务或本人待审批事项，不含聊天正文；客户端需要保持运行。普通听写先进入可编辑草稿，由用户确认发送。开启语音通话后，工作空间服务用本地 Whisper 将短段音频转写，随后通过 Pi 提交文字消息，终态回复由设备的离线声线朗读。每轮转写的临时音频在请求结束时清除。挂断停止采音、转写与朗读，Pi 已接收的任务按原规则继续。通话绑定当前会话与前台页面，工具审批规则沿用文字聊天。

版本检查支持部署者配置自己的 GitHub 仓库，用户明确检查后查询稳定发行版。未配置时不联网，不显示“已经最新”。没有假设已经完成发行签名、公证或自动安装更新。

## 当前仍需完成或配置

- 已在隔离环境验证 Web 到 Rust、Pi 的线程提交与上下文边界，使用 390px 浏览器验证点名多位 Bot 和 `@everyone`。网站实测从 Pi 交付到匿名浏览，确认样式、站内跳转和撤回后的资源权限。Flutter 浏览器验收了全屏网站预览和站内跳转，并用合成账户数据验证公开确认和撤回请求。原生客户端和干净开源目录的发行验收仍单独记录。[验证记录](verification.md)
- 在打包后的 Web 和独立启动的 macOS Electron 客户端实际打开了跨会话的旧网站版本，并从搜索和资料库跳到原回复线程。Flutter 用窄屏测试验证相同的版本、资源与权限校验。
- 联网有头 Linux 浏览器源码已完成本机协议、代理与双 Chrome 检查，但未完成该版本的远端 Linux 内核隔离和部署验收；自动审批拒绝了恢复实例并执行检查，等待明确授权。不能沿用旧离线桌面证据当作新能力已经上线。
- 真实第三方 OAuth、设备麦克风/声线/系统通知取决于用户设备或账户授权；本机合成服务测试不代表这些外部授权已经完成。
- Android arm64 调试包已通过构建和签名检查。Android 11 模拟器实测了冷启动和前台的分享意图，以及从独立应用传入具有读取授权的文件。两次文字进入各自会话的草稿，跨应用文件分享保留原会话状态，只有明确点击上传后才产生服务器文件，下载字节与原文件一致。iOS 分享扩展与 Flutter 桥接通过类型检查和本机暂存测试，仍需签名和 iOS 设备验收。
- 公网部署、邮件验证/邮件找回、SSO、计费、离线推送、桌面正式签名与自动安装更新没有作为已完成能力。源码许可证和可配置更新检查不等于正式发行已上线。

旧阶段的记录保留在证据目录并标明时间；其中的测试数量、源码路径或当时的待办不代表当前完整版本。
