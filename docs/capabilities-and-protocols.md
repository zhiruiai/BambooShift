# 能力、协议与实际交付范围

本文对应当前源码；模板、技能包、工具连接和企业消息渠道有各自的配置条件。初始化完成不代表模型、第三方账号或电脑权限已经可用。

## 从哪里开始

| 需要做的事 | 当前入口与结果 |
| --- | --- |
| 开始工作 | 在「设置 → 模型」配置模型并设为空间默认；Bot 可继承默认或选择自己的已配置模型。 |
| 招聘与组队 | Bot 广场有 **16 个 Bot 模板**，另有团队模板。包括招聘助理、技能专家、连接器工程师、工程负责人、界面设计师及三家企业 IM 助理。模板预设职责和技能；自定义资料后仍继承模板技能，在最终创建时一起安装。模板不包含企业凭据。 |
| 使用基础能力 | 本地 Bot 初始化 **4 个完整技能包**：`web-research`、`browser-use`、`computer-use`、`agent-desktop`。初始 Bot、手动创建、招聘、模板和团队采用相同初始化；现有本地 Bot 一次性补齐缺项。共享 Bot 保留来源定义，已有自编/停用技能不被覆盖，之后主动删除或停用的基础包不会在重启时复活。 |
| 安装领域技能 | 在 Bot 设置「选择技能」预览并安装；中英文目录均有 **27 个包**。支持研究、设计、开发、数据核对、写作和协作等工作流。每包包含 `SKILL.md` 和实际资源文件；不是每包都含可执行脚本。 |
| 找技能、制作技能 | 对技能专家描述任务。`find_skills` 只检索内置目录，返回来源、许可、兼容条件及资源路径；外部候选需另行检索核实。`propose_skill` 为当前 Bot 保存含资源文件的新版本草稿，由拥有者审核后启用，不会自动安装依赖或执行代码。 |
| 连接业务工具 | 「连接应用」配置 MCP 服务及所需授权；连接器工程师可以帮助准备接口方案、代码和验证清单。生成方案不会自动部署插件或接通账号。 |
| 接收企业消息 | 「连接应用 → 消息渠道」查看飞书、钉钉、企业微信的待配置状态、准备项和开发者命令。按[接入说明](im-connectors.md)独立安装并启动桥接程序。 |

基础包使用产品已有的 `web_search` / `web_fetch`、Playwright 浏览器和获授权的本机操作。Agent Desktop CLI 需在执行电脑另行安装并具备 `local-shell-v1` 能力；它是可选执行路径。安装任何技能均不会授予电脑权限、安装 CLI、添加模型密钥或连接企业账号。[模型、技能与脚本执行](bot-models-and-skills.md)

## 协议实现到哪一步

| 规范或机制 | 已实现范围 | 明确边界 |
| --- | --- | --- |
| [Agent Skills](https://agentskills.io/specification) | 导入含 `SKILL.md` 的目录；校验名称、YAML frontmatter 与相对路径；保存 `scripts/`、`references/`、`assets/` 等文件；按版本审核、读取和 ZIP 导出。保留 `license`、`compatibility`、`metadata` 和实验性 `allowed-tools` 字段。 | `allowed-tools` 是保留的元数据，不授予工具权限。不自动发现并执行磁盘上的任意技能，不承诺兼容所有第三方宿主扩展。 |
| MCP | 官方 **`@modelcontextprotocol/client` 2.4.0**，HTTPS Streamable HTTP；`tools/list` 与 `tools/call`；支持手动令牌与 OAuth 流程，包括 PKCE、刷新、撤销。测试覆盖 **2026-07-28** 和与 **2025-11-25** 服务端的协商。 | 当前产品连接器消费工具，未提供通用 resources/prompts、sampling 或任意本机 stdio 服务入口。结果读取文本和 `structuredContent`；其他内容类型显示未读取提示。 |
| Worker 插件 | **`@cordisjs/core` 3.18.1** 管理静态引入、经过审查的 Worker 插件、依赖注入和释放；Pi 是唯一内置生产引擎。 | Cordis 是采用的开源插件机制，不是统一的“国际 plugin 规范”。没有任意第三方插件一键安装或动态执行入口；Rust 始终负责权限、凭据和执行决策。 |
| A2A | [设计提案](bot-federation.md)以 Agent2Agent v1.0.1 为目标。 | **尚未实现** Agent Card、跨服务器任务传输或独立实现互操作。当前同空间 Bot 委派、共享 Bot 和 IM 桥接均不等于 A2A。 |
| 企业 IM | 飞书 `@larksuiteoapi/node-sdk` **1.73.0**、钉钉 `dingtalk-stream` **2.1.7-beta.1**、企微 `@wecom/aibot-node-sdk` **1.0.7**；官方长连接收文本，经显式会话绑定调用 Rust API，再回原消息目标。 | 使用各平台消息协议，独立于 MCP 和 A2A。目前是独立开发者入口，未随客户端打包或自动启动；**企业账号尚未实测**，不能标为已连接。 |

技能按需加载：模型先看到已启用技能的目录信息，使用 `read_skill` 读取说明，再由 `read_skill_resource` 读取所需文件。`run_skill_script` 可在获授权的 macOS 本机执行端运行已审核包内 `scripts/` 下的 `.py` / `.mjs`，固定包版本并返回退出码和输出；Python 脚本需要执行电脑安装 Python 3。草稿、停用版本和其他 Bot 的技能不能通过该入口执行。

IM 已通过 **11 项协议/HTTP 合约 fixture 测试**和官方 SDK 构造/释放检查，覆盖三家双向文字路由、发送者/聊天/话题限制、持久去重、撤销、取消及凭据日志隔离。HTTP fixture 模拟 Rust 会话契约；不代表真实企业账号、真实模型或断线恢复已做完整线上验收。当前没有扫码接入、附件收发、跨平台卡片审批或主动广播。IM 文本不能直接批准动作。[完整配置与验证边界](im-connectors.md)

实现细节：[MCP 执行器](../server/workers/mcp-worker/README.md) · [Cordis 引擎契约](../server/workers/plugin-runtime/README.md) · [架构与授权](architecture.md)

## 本轮验收范围

Web 界面覆盖 1280×800、960×720、390×844 与 320×560，包括 Bot 广场、创建与组队、技能文件和版本切换、设置、消息渠道、电脑权限、网站历史及变更。macOS 本机客户端使用固定签名身份更新，已验证辅助功能仍可用、完整授权时间不变，并以真实模型执行包内脚本和网站交付。公开动画使用虚构数据，逐帧检查个人信息与模型信息；等待及调试过程经过剪辑。

Windows 的平台提示和浏览器布局已检查，未在 Windows 实机验收原生窗口；Flutter 原生应用未完成构建与设备验收。企业 IM 的账号连接和 A2A 范围仍以本文上表为准。

## 开源复用与许可证

- BambooShift 自有代码采用 [MIT](../LICENSE)。依赖与导入技能保留各自许可证；不能将整个分发包都标成 MIT。
- Superpowers 使用 MIT：工程包保留选定固定版本的完整调试、测试驱动开发、评审反馈和完成验证目录及哈希清单，作为包内参考；不自动安装 hooks 或执行上游辅助脚本。Awesome Copilot、Matt Pocock 等改编工作流也保留出处和 MIT 许可。
- Frontend Design 包保留 Anthropic 上游完整设计说明及 Apache-2.0 许可，连同 BambooShift 新增部分标为 **MIT AND Apache-2.0**。Agent Desktop 改编包是 **Apache-2.0**，未捆绑其 CLI 或原生运行时。[固定版本、来源与许可清单](../legal/third-party/community-skills/SOURCES.json)
- IM 参考了 MIT 的 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 实际渠道源码，直接复用官方 SDK。另核对 MIT 的 `shaobeichen/dsh-im-bridge` 和 Apache-2.0 的 `liushutan/dsh-im-connect`，没有复制其宿主集成代码。飞书/钉钉 SDK 为 MIT；依赖树还包含 BSD-3-Clause 与 Apache-2.0。企微 SDK 1.0.7 发布包声明 MIT，但未附 LICENSE 正文，当前只独立从 npm 安装，不内嵌再分发到桌面包。

开发者可以先在本地运行 `node --test server/workers/im-runtime/*.test.mjs` 验证消息桥接契约；真实账号上线仍需按接入文档验证身份、文本往返、原话题、重复事件和撤销行为。测试使用虚构数据，不会向企业账号发消息。
