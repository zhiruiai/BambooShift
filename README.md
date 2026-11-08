# PandaMate

给自己组一支 AI 小队。PandaMate 支持 Bot 群聊、例行任务、联网检索和文件交付。网页、Electron 客户端和 Flutter 移动端共用 Rust 后端，Bot 由 Pi 执行。界面支持中文和英文。

[English quick start](docs/quickstart.en.md) · [架构](docs/architecture.md) · [功能核对](docs/reference-audit.md) · [验证范围](docs/verification.md) · [Apache 2.0](LICENSE)

## 功能演示

### 外观与创意群聊

**切换头像主题 · 约 7 秒**

预览熊猫、恐龙、小鸡和大象主题。选定大象后，回到群聊看整队换装。

![预览四套头像主题，保存大象主题并返回群聊](docs/demo/avatar-themes.gif)

<details>
<summary>法国足球战术室 · 约 6 秒</summary>

选中战术教练、锋线球员和数据分析师，组成自己的法国足球战术小队。

![选中三位足球角色，创建法国足球战术室并查看成员](docs/demo/group-chat.gif)

试试在群里问：「半场 0 比 1 落后，对方把禁区挤满了。教练怎么改阵？前锋往哪跑？分析师拿什么数据判断调整有效？」

</details>

<details>
<summary>临场改战术 · 约 6 秒</summary>

点名战术教练，从问题卡勾选「前场压迫」和「边路快攻」。教练收到选择后，在群里接着布置战术。

![点名教练，提交两项战术选择，并在群里查看教练的续答](docs/demo/chat-choices.gif)

</details>

<details>
<summary>AI 创始人擂台 · 约 6 秒</summary>

梁文锋、Sam Altman、Dario Amodei 和 Elon Musk 的演绎角色同台。用 `@everyone` 发同一道题，看四个 Bot 分别从效率、产品、安全和压力测试出招。对话为虚构演绎。

![向四个虚构演绎角色发出同一道题，查看各自的回答](docs/demo/founder-debate.gif)

试试把题目换成：「一间乡村教室只有一台旧电脑。你会怎样做一个 AI 助教？每人给一招，再说说愿意牺牲什么。」

</details>

### 工作与交付

<details>
<summary>团队模板 · 约 6 秒</summary>

选择发布小组模板，查看三位 Bot 的分工，确认后创建团队群聊。

![选择发布小组模板，核对角色并创建团队群聊](docs/demo/team-templates.gif)

</details>

<details>
<summary>工作日简报 · 约 5 秒</summary>

把项目简报设为工作日任务，选择执行时间，查看保存后的下一次执行。

![设定工作日项目简报的频率和时间，并确认下次执行](docs/demo/scheduled-brief.gif)

</details>

<details>
<summary>给 Bot 加一项调研技能 · 约 6 秒</summary>

在内置技能库预览调研步骤，选定 Bot，将技能保存为待审核草稿。

![从内置技能库预览调研指令，为指定 Bot 保存待审核草稿](docs/demo/skill-library.gif)

</details>

<details>
<summary>网站项目 · 约 6 秒</summary>

从聊天打开多文件网站，跳转站内页面，再查看源码目录。

![在聊天中打开网站项目，预览书单并查看三个源文件](docs/demo/website-preview.gif)

</details>

<details>
<summary>网页检索 · 约 5 秒</summary>

展开聊天里的检索记录，核对已读网页和公开来源。

![展开公开网页检索记录，查看 Pi 官方文档来源](docs/demo/web-research.gif)

</details>

演示使用独立工作空间和示例数据。

## 本地运行

需要 Rust 1.85+、Node.js 22.19+ 和 npm，推荐 Node.js 24。Node 负责 SDK 工作进程和前端工具；账户、业务接口、权限、SQLite、审批与调度由 Rust 负责。

```sh
npm ci
npm run configure:local
npm run dev -- --init-operator
```

- 产品：[http://127.0.0.1:5173/login](http://127.0.0.1:5173/login)，个人与团队共用注册登录。
- 平台运营：[http://127.0.0.1:5174/admin/setup](http://127.0.0.1:5174/admin/setup)，运营人员管理全部用户和空间，使用独立登录。
- Rust 分别监听 `3001` 产品接口和 `3002` 运营接口，两个站点分别构建为 `dist` 和 `operations-dist`。

首次部署的运营人员从本机 `data/platform/operator-setup-code` 取得一次性初始化码，建立自己的运营账户。之后省略 `--init-operator`，访问 `/admin/login`。普通注册不能获得运营权限。两个入口共用一个 Rust 进程和调度器，分别只挂载自己的接口。见[运营部署](docs/operations-console.md)。

在“设置 → 模型”添加模型地址与 API Key，再明确设为默认。每个空间独立配置模型；新账户不会继承部署者的密钥、电脑或第三方应用账户。兼容接口可以保存为独立模型配置，例如 GLM 与 DeepSeek。

```sh
npm run build           # Build Rust and both web applications
npm start               # Serve the built applications
npm test                # Backend, web, runtime and client checks
npm run backend:package # Assemble a separate deployment package
```

## 协作与工作

- Bot 设置、个人主 Bot、真实同事委派与群聊分工。可以用文字生成单个 Bot 或整组 Bot 的草稿，审核后创建。
- 五套原创头像（伙伴、熊猫、恐龙、小鸡、大象）。Web、桌面和 Flutter 都可生成并预览自定义主题，也可将主题保存到自己在当前空间的账号，在其他设备使用。已上传的 Bot 头像优先显示。
- 流式聊天、附件、引用、表情回应、消息菜单、搜索和新聊天选择。输入 `/` 打开快捷操作；在草稿任意位置输入 `@`，可选择实际 Bot。
- 在普通 Bot 的单聊或群聊中，询问最新资讯可搜索公网，贴公开文章或文档链接可直接读取正文。Pi 调用工具完成，无需分配浏览器、逐个批准或配置搜索密钥。搜索词或公开链接会发送给 Exa，请勿提交私有或一次性链接。
- 记忆管理、个人背景导入、技能提案与版本审核，人工演示核对后生成待审核技能。
- 「技能与成长」提供技术调研、系统排障、行为验收和前端设计模板。选取模板填入可编辑草稿，保存后通过现有审核流程启用。工作方法参考 [Superpowers](https://github.com/obra/superpowers)、[Matt Pocock Skills](https://github.com/mattpocock/skills) 和 [Anthropic Frontend Design](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)。
- 例行任务、时区、暂停、运行历史及丢响应后的原请求恢复。
- 公网 MCP 应用、OAuth/Bearer 授权、工具审批与明确授予的精确例行只读权限。
- 文件库及 [Markdown、HTML、文档、表格和媒体预览](docs/file-previews.md)、电脑文件收发、独立浏览器与可选远程执行电脑。
- 真实 token 用量、本地听写、可用的本地声线朗读和明确开启的工作通知。

团队只设拥有者和成员；拥有者邀请与移除成员，平台运营人员管理整个平台。共享 Bot 的私人会话、记忆与来源授权见[共享说明](docs/shared-bots.md)。远程电脑与本地听写需要额外配置 Worker、whisper.cpp 和模型。任务在后台服务运行，客户端退出不会主动取消任务。各项实际能力和验证范围见[功能核对](docs/reference-audit.md)。

## 多端

网页适配桌面和手机，可作为 PWA 使用。Electron 是连接同一服务的薄客户端：

```sh
npm run client:dev
npm run client:test
npm run client:package -- --platform darwin --arch arm64
```

远程连接使用 HTTPS，本机可用 `http://127.0.0.1:3001`。客户端与执行电脑是两个组件，详见[桌面客户端](docs/desktop-client.md)。Flutter 源码位于 `mobile/`，安装包构建和真机验收按当前计划后置。

## 目录

```text
web/                    React 产品站点
  src/                  界面、状态、组件和语言资源
  public/               头像、图标和静态资源
operations/             独立运营站点
desktop/                Electron 客户端与本地连接页
mobile/                 Flutter 客户端
server/
  api/                  Rust HTTP、权限、SQLite、审批与调度
  workers/              Pi、MCP、文档与电脑执行进程
  native/               原生电脑控制助手
shared/                 跨端接口和领域类型
scripts/                启动、构建和测试工具
  source/               源码检查、隐私扫描和发布导出
docs/                   架构、功能、部署与验证说明
  demo/                 README 功能演示素材
```

业务服务由 Rust 管理，Node SDK 与执行适配位于 `server/workers/`。历史迁移详见[清理记录](docs/evidence/node-retirement.json)。自有代码单文件最多 500 行，注释使用英文，界面文字至少 12px。

## 配置与开源

个人邮箱、实际部署地址和端口、模型密钥及电脑凭据放在忽略版本管理的 `config/private/` 或 `data/`。运维记录和构建产物留在本机的 `.local/`、`release/` 等忽略目录。公开示例位于 `server/api/deployment/`，架构与模块边界见[架构文档](docs/architecture.md)。

```sh
npm run check:source
npm run check:privacy
npm run source:export -- --out release/source/pandamate-v0.1.0
```

导出排除运行数据、密钥、依赖、工具链、构建缓存和历史图片，包含逐文件校验清单；发现已知私密值就停止。使用干净目录建立 GitHub 仓库，详见[开源交付](docs/source-release.md)。工具不会创建仓库或上传代码。

PandaMate 是独立项目，采用 [Apache License 2.0](LICENSE)。请保留 [NOTICE](NOTICE) 和[第三方许可说明](THIRD_PARTY.md)。欢迎按[贡献说明](CONTRIBUTING.md)提交改进。
