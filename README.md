# PandaMate

简体中文 · [English](README.en.md)

**开源、自托管的 Grok Bot 平替。** 在 PandaMate 里组建一队 AI 同事，让他们在群聊里分工、查找资料并交付成果。做出来的网页和文件可以在对话里直接打开。

[功能演示](#功能演示) · [创作者取材](#创作者取材) · [快速开始](#快速开始) · [开发与部署](#开发与部署) · [源码导航](#源码导航) · [鸣谢与开源组件](#鸣谢与开源组件)

## 功能演示

**星港降落｜聊天里交付的小游戏，点开就能玩。** 打开包含五个文件的网页交付物，校准航向、启动反推，在预览里完成软着陆。

![从 PandaMate 聊天打开网页交付物并操纵飞船着陆](docs/demo/orbital-landing.gif)

以下演示在独立工作区录制，使用示例对话、文件和预设的模型回复。

### 三个适合拍短视频的案例

**给工作区换一支星际象群。** 描述你想要的太空大象头像，预览生成的配色，保存后回到工作区看角色换装。

![生成星际大象头像主题并在工作区应用](docs/demo/smart-theme.gif)

**七人制足球，怎么踢出法式快攻？** 把教练、前锋和数据分析师拉进一个群。在问题卡选中前场压迫和边路快攻，看教练根据选择安排打法。

![挑选三位角色并创建足球战术群聊](docs/demo/group-chat.gif)

[看教练收到战术选择后的续答](docs/demo/chat-choices.gif)

**创始人擂台。** 用 `@everyone` 问四位演绎角色「一台旧电脑，怎么做 AI 助教？」对照各自从产品、效率、安全和工程出发的点子。

![在虚构创始人群聊用全体点名发题并查看各位角色的答复](docs/demo/founder-debate.gif)

<details>
<summary>更多演示 · 用一句话招同事、组队、定时简报、技能、检索与交付</summary>

**博物馆夜班编辑。** 描述你需要怎样的短视频编导，核对生成的 Bot 档案，改名后打开新会话。

![根据一段描述生成短视频编导 Bot 并打开会话](docs/demo/smart-bot.gif)

**给全队换头像。** 在熊猫、恐龙、小鸡和大象之间切换，看看整个群聊的变化。 [头像主题 GIF](docs/demo/avatar-themes.gif)

**给新品发布拉一支小队。** 从团队模板接手三位有分工的 Bot，调整群名并创建群聊。 [团队模板 GIF](docs/demo/team-templates.gif)

**把工作日简报排进日历。** 设好星期和时间，在例行任务里核对下次执行。 [定时简报 GIF](docs/demo/scheduled-brief.gif)

**让下次调研也带上来源。** 预览内置技能的核对步骤，并给指定 Bot 保存待审核草稿。 [技能草稿 GIF](docs/demo/skill-library.gif)

**顺着答案去找原文。** 展开检索记录，核对 Bot 访问过的网页。 [网页检索 GIF](docs/demo/web-research.gif)

**一间可以点进去的书店。** 打开多文件网站，进入书单，再切到源码看样式文件。 [网站预览 GIF](docs/demo/website-preview.gif)

</details>

## 创作者取材

### 20 秒｜聊天里飞进一座星港

开场口播「我让 AI 同事交付一个小游戏，聊天里就能试玩。」

| 时间 | 画面与字幕 |
| --- | --- |
| 00–03 秒 | 先闪过飞船即将着陆的画面。字幕「聊天里也能开飞船？」 |
| 03–08 秒 | 回到对话，展示需求和网页交付卡，点开预览。字幕「交付的是可以打开的网页」。 |
| 08–16 秒 | 剪进飞船下降和调整操作，留出一拍给触地。字幕「调整推力，准备着陆」。 |
| 16–20 秒 | 停在着陆结果上。片尾字幕「PandaMate · 开源、自托管」。 |

[星港降落 GIF](docs/demo/orbital-landing.gif)

### 28 秒｜让 AI 教练为七人制足球安排法式快攻

| 时间 | 画面与字幕 |
| --- | --- |
| 00–04 秒 | 闪过教练的续答。开场口播「一支 AI 球队，会怎么安排法式快攻？」 [问题卡 GIF](docs/demo/chat-choices.gif) |
| 04–10 秒 | 选角色并创建群聊。字幕「教练、前锋、数据分析师，就位」。 [组队 GIF](docs/demo/group-chat.gif) |
| 10–18 秒 | 勾选前场压迫和边路快攻，切到教练的续答。字幕「教练收到新战术」。 [问题卡 GIF](docs/demo/chat-choices.gif) |
| 18–28 秒 | 快切熊猫、小鸡和大象主题，以换装后的群聊收尾。 [头像主题 GIF](docs/demo/avatar-themes.gif) |

另一个选题是「四位创始人角色，一台旧电脑」。让每位角色各出一招，结尾请观众选择一份方案。 [创始人擂台 GIF](docs/demo/founder-debate.gif)

剪成竖屏时，将画面裁到正在操作的区域。保留交付卡上的按钮、群聊角色名和着陆结果，便于观众在静音时看懂。

## 快速开始

下载或克隆本仓库。安装 Rust 稳定工具链、Node.js 22.19 或更高版本（推荐 24）及 npm，然后在仓库根目录运行。

```sh
npm ci
npm run configure:local
npm run dev
```

1. 打开终端显示的产品地址，注册个人或团队账号。
2. 在工作空间打开 **设置 → 模型配置**，填写模型服务地址、模型名称和 API Key。保存后点 **设为默认**。
3. 打开一个 Bot 单聊，试试「你能负责哪类任务？给我三个例子。」
4. 如果服务能通过 HTTPS 访问 Exa，在该空间的 Bot 单聊试试「查找 Pi Coding Agent 的官方文档，总结三点并附来源」。展开回复上方的检索记录可以核对来源。 [联网检索配置](server/api/deployment/README.md#execution-boundary)

`configure:local` 用于首次创建本地配置。已有配置时直接运行 `npm run dev`。首次初始化独立运营账户时，运行 `npm run dev -- --init-operator`。 [运营入口与初始化](docs/operations-console.md)

## 能做什么

| 场景 | 功能 |
| --- | --- |
| AI 同事与多智能体协作 | 支持单聊、群聊、点名 Bot、同事委派和问题卡。根据描述生成 Bot 或团队草稿，核对分工后创建。 |
| 网页检索与交付 | 搜索公开网页并回看来源。在对话里预览文档、表格、媒体和多文件网站。 [文件预览](docs/file-previews.md) |
| 工作流自动化与技能 | 按时间和时区安排例行任务，或用 Webhook 触发任务并在原会话接收结果。可以把可复用的做法保存为待审核的技能。 [Webhook](docs/routine-webhooks.md) |
| MCP 与人工审批 | 通过 Model Context Protocol（MCP）连接应用，并审批具体工具调用。浏览器操作、远程电脑和本地语音转写可以分别配置。 |

网页支持 PWA 安装。桌面端和移动端连接同一个工作空间服务。 [Electron 桌面端](docs/desktop-client.md) · [Flutter 移动端](mobile/README.md)

## 开发与部署

Rust 服务负责身份、权限、业务数据和调度，使用 SQLite 保存状态。Pi 提供 Bot 的智能体执行框架（agent harness）。MCP、文档解析和电脑操作由独立进程处理。React 产品站点和运营站点分别构建，使用不同的 API 入口与登录会话。 [架构](docs/architecture.md)

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 编译 Rust 服务，构建产品站点和运营站点 |
| `npm start` | 使用本地配置启动已构建的服务 |
| `npm run client:dev` | 运行 Electron 客户端并连接产品服务 |
| `npm test` | 运行后端、网页、执行进程与桌面客户端测试 |
| `npm run check:source` · `npm run check:privacy` | 检查源码规范与发布范围内的隐私信息 |
| `npm run backend:package -- --release --out release/backend` | 组装当前平台的发布包 |

生产部署使用 HTTPS。分别配置产品与运营入口，并把数据目录放在发布包外。模型、第三方应用、远程电脑与本地语音各有配置要求。Flutter 提供 Android 和 iOS 源码及测试流程，原生安装和真机验证单独进行。 [服务部署](server/api/deployment/README.md) · [源码发布](docs/source-release.md) · [验证范围](docs/verification.md)

首版和每日构建的下载包由 GitHub Actions 生成。 [自动发布与下载包说明](docs/source-release.md#github-自动发布)

## 源码导航

开发者和 AI 智能体可以按改动范围定位入口、实现和相关检查。

| 改动范围 | 从这里开始 | 相关检查 |
| --- | --- | --- |
| 产品界面 | [网页入口](web/src/main.tsx)、[界面源码](web/src/)、[静态资源](web/public/) | `npm run test:web` |
| 独立运营站 | [运营入口](operations/main.tsx)、[运营页面](operations/src/) | `npm run build:operations` |
| Rust API、权限与持久化 | [服务入口](server/api/src/main.rs)、[API 实现](server/api/src/)、[集成测试](server/api/tests/) | `npm run backend:test` |
| Pi、MCP、文档及电脑执行 | [server/workers/](server/workers/) 与 [server/native/](server/native/) | `npm run test:runtime` |
| Electron 与 Flutter | [desktop/](desktop/) 与 [mobile/](mobile/) | `npm run client:test` · [Flutter 检查](mobile/README.md#develop-and-verify) |
| 跨端类型与协议 | [shared/](shared/) | `npm run test:web` · `npm run test:runtime` |
| 构建、导出与隐私检查 | [scripts/](scripts/) 与 [scripts/source/](scripts/source/) | `npm run check:source` · `npm run check:privacy` |

开发命令定义在 [package.json](package.json)，持续集成流程位于 [.github/workflows/ci.yml](.github/workflows/ci.yml)。权限和任务状态由 Rust 服务判定。涉及权限或数据写入的改动，可沿 API、持久化与测试核对行为。 [贡献指南](CONTRIBUTING.md)

## 数据与外部服务

工作空间数据存储在部署者管理的服务上。模型请求发送给配置的模型服务。公开检索将关键词或公开链接发给 Exa，连接应用和执行电脑则使用各自配置的目标与权限。部署配置、模型密钥、运行数据和浏览器资料应保存在源码版本控制之外。 [外部应用](docs/app-connections.md) · [安全说明](SECURITY.md)

## 鸣谢与开源组件

感谢试用 PandaMate、报告问题、提供复现步骤以及改进文档和翻译的每一位贡献者。也感谢以下上游项目的维护者。

| 用途 | 上游项目与组件 |
| --- | --- |
| 智能体执行与工具接入 | [Pi Coding Agent](https://github.com/earendil-works/pi) 提供 Bot 执行框架，[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 用于连接外部工具。 |
| 服务端与存储 | [Tokio](https://tokio.rs/) 和 [Axum](https://github.com/tokio-rs/axum) 支撑 Rust 服务，[SQLx](https://github.com/transact-rs/sqlx) 访问 [SQLite](https://sqlite.org/)。 |
| 网页、桌面与移动端 | [React](https://react.dev/) 和 [Vite](https://vite.dev/) 用于网页开发和构建，[Electron](https://www.electronjs.org/) 和 [Flutter](https://flutter.dev/) 分别用于桌面端和移动端。 |
| 文档、图标与字体 | [PDF.js](https://mozilla.github.io/pdf.js/) 和 [Mammoth.js](https://github.com/mwilliamson/mammoth.js) 用于文档预览与解析，[Lucide](https://lucide.dev/) 提供界面图标。Flutter 网页端的中文字体派生自 [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)。 |
| Markdown 与图片 | [react-markdown](https://github.com/remarkjs/react-markdown) 和 [remark-gfm](https://github.com/remarkjs/remark-gfm) 渲染消息与技能文档，[sharp](https://sharp.pixelplumbing.com/) 用于处理图片附件。 |
| 可选执行环境 | [Playwright](https://playwright.dev/) 和 [Chromium](https://www.chromium.org/) 用于浏览器操作，[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 用于本地语音转写。 |

PandaMate 是独立开发的项目。作为产品参照，可查阅 [Grok Bot 官方介绍](https://x.ai/news/introducing-grok-bot)。

依赖版本由锁文件记录，各依赖保留原许可证。服务发布包包含所编译 Rust 与网页依赖的许可清单。 [NOTICE](NOTICE) · [第三方许可](THIRD_PARTY.md)

## 贡献与许可

欢迎提交缺陷复现、文档补充与代码改进。请使用示例数据复现问题，并注明相关验证。 [贡献指南](CONTRIBUTING.md)

PandaMate 源码采用 [Apache License 2.0](LICENSE)。
