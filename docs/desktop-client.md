# PandaMate 桌面客户端

PandaMate 客户端是连接现有 PandaMate 服务的独立桌面窗口。它包括本地连接页与 Electron 窗口，不包含 Pi、API 服务、SQLite、用户工作区或原生电脑控制助手。先单独运行本机服务，或准备可访问的远程服务，再在客户端连接页填写地址；客户端不会自动启动服务或授予系统权限。

## 开发运行

项目需要 Node.js 22.19 或更新版本。根目录安装锁定的开发依赖后，运行：

```sh
npm run client:dev
```

该命令通过项目已有的 Node 启动器运行 `scripts/run-client.mjs`，再启动项目安装的 Electron。它不接受任意 Electron 参数。连接设置在客户端页面内完成；连接后使用产品账户登录并选择自己的空间，客户端不能代替服务端认证。

Electron 45 的 npm 包在首次开发启动时才按需下载可执行文件，因此第一次 `client:dev` 可能等待下载。开发启动与 Packager 共用 `release/client/.electron-cache` 下载缓存；Electron 自身会把开发用运行时安装到其 `node_modules/electron/dist`。这不是服务启动或用户数据复制。只验证打包产物时无需再运行 `client:dev`，可避免重复安装开发用运行时。

开发启动只继承系统会话所需环境变量，不透传根目录 `.env` 中的模型 API 密钥。可选的 `OPENBOT_CLIENT_URL` 仅提供连接页建议地址，不自动连接；`OPENBOT_CLIENT_DATA_DIR` 可为测试指定独立的客户端设置/浏览器会话目录。没有配置时，客户端使用操作系统的 Electron 用户数据目录。登录凭据和客户端偏好属于运行时数据，不会进入构建产物。

成功连接后，连接记录只记住服务地址。下次冷启动会尝试重连该地址一次；失败后保留地址并显示重试，不循环尝试。首次启动、环境变量提供的新地址以及菜单中的“更换工作空间”仍需手动连接。不同服务来源使用隔离的浏览器会话；同一服务的个人/团队空间由产品内账户菜单选择，业务请求显式带空间 ID 并核验成员权限。

在 macOS 上关闭已连接的窗口后，可点击 Dock 图标重新打开刚才的服务。主动选择“更换空间”会清除本次重开的目标。

在「帮助 → 键盘快捷键」或按 `⌘/`（Windows、Linux 上为 `Ctrl+/`）可以查看当前客户端的快捷键。工作空间连接后，列表会加入搜索会话、新建群聊、打开设置和输入框操作。

## 客户端语言

本地连接页、应用菜单、右键菜单、连接错误和文件保存提示支持简体中文与英文。首次使用按系统首选语言选择；连接页右上角或原生“客户端语言 / Client language”菜单可明确切换。偏好以版本化 `client-language.json` 保存在当前客户端用户目录，仅含语言枚举，不包含账户、密钥或服务地址。存储失败仍保留本次选择，连接页会说明未能保存。

客户端语言不修改工作空间网页的语言、用户输入或已登录会话。产品内语言继续由网页设置管理；切换客户端语言不会重连、更换服务或清空连接页的地址草稿。连接后使用产品账户登录，首次使用可选择个人或团队注册，不需要在此页输入设备配对码。

macOS 麦克风用途说明提供 `en` 与 `zh-Hans` 本地化资源；系统权限面板使用 macOS 的应用语言或系统偏好，客户端开关不改变系统语言或权限。原生编辑菜单保留系统角色，连接、来源隔离和文件下载验证没有放宽。

## 打包

```sh
# 当前系统与架构；本机默认 darwin / arm64
npm run client:package

# 只显示计划，不创建文件、下载或启动应用
npm run client:package -- --platform darwin --arch arm64 --dry-run

# 其它目标示例；尚未在这些目标系统上运行验证
npm run client:package -- --platform darwin --arch x64
npm run client:package -- --platform win32 --arch x64
npm run client:package -- --platform linux --arch arm64
```

支持的参数仅为 `--platform darwin|win32|linux`、`--arch arm64|x64`、`--dry-run` 和 `--help`；未指定时采用当前系统和架构。参数不允许输出目录覆盖、路径穿越或任意命令转发。

macOS Apple Silicon 的应用和清单位于 `release/client/`。从 `manifest-darwin-arm64.json` 的 `bundles` 列表找到应用所在目录。

同一目标重新打包会先在临时目录完成构建和签名，再替换同平台、同架构的旧产物。发布失败会恢复旧包；若恢复本身失败则保留恢复目录并报告位置。其它目标的产物保留。中间文件和下载缓存均放在 `release/client` 内；正常结束后删除临时目录。清单记录客户端源文件、Electron 版本、架构及输出路径，方便检查交付内容。

系统和客户端窗口显示 PandaMate。原安装标识及用户数据目录继续沿用，macOS bundle identifier 为 `com.openbot.client`。此客户端与 `com.openbot.desktop-helper` 原生控制助手是两个独立应用；原有 `npm run desktop:build` / `desktop:check` 仍专用于控制助手，不能用来打包客户端。

## 打包边界

脚本先从 `desktop` 复制下列白名单内容到独立暂存目录，再调用官方 `@electron/packager` 的 `packager(options)` API，使用已安装并由根 lockfile 锁定的 Electron 版本：

- `package.json`、`main.cjs`、`preload.cjs`、`security.cjs`。
- `ui` 下的普通网页、脚本、样式、图像与字体文件。

`.env`、隐藏文件、测试文件、`data`、`server`、`node_modules` 不会从项目复制到应用；客户端目录中的符号链接直接拒绝。客户端 manifest 不允许声明服务端 npm 依赖。文件总数与体积有上限，避免误把服务数据混入客户端。

应用代码封装为 `app.asar`。Electron 自身的运行时、许可文件及支持库仍是正常产物的一部分；ASAR 只是一种归档格式，不是加密或保密措施。不要把服务 API Key 写入客户端源码或连接页。

macOS 图标从项目 `web/public/favicon.svg` 生成多尺寸 PNG，再使用系统 `iconutil` 生成 ICNS。Windows 生成多尺寸 ICO。Linux 不使用 Packager 的嵌入图标选项，窗口图标尚未单独适配。这些转换仅处理已有项目素材，不修改源图。

macOS 构建完成后，脚本使用官方 `@electron/osx-sign` 从内部组件到整个应用依次进行本地 ad-hoc 签名，并通过 `codesign --verify --deep --strict` 校验资源完整性；失败时构建直接报错。签名不使用开发者证书或时间戳服务，清单中记录 `localSignature: "ad-hoc"`。生成的客户端保留 hardened runtime 与 V8 JIT 权限；由于 ad-hoc 没有 Apple Team ID，附带库使用进程内的 library-validation 例外，Plugin helper 另保留 Electron 所需的 executable-memory 权限。这些设置不会授予屏幕录制、辅助功能或相机权限。

听写新增 `com.apple.security.device.audio-input` entitlement 与 `NSMicrophoneUsageDescription` 用途说明，允许应用向系统请求麦克风；它们不等于已获得用户同意。仅当前前台同源主框架在近期原生点击、Enter/Space 或 Cmd/Ctrl+D 后可请求一次 `mediaTypes: ['audio']`。相机、屏幕/系统声音捕获、子框架、连接页与后台请求仍拒绝。录音由网页完成，语音模型运行在连接的服务端。

## 平台和发布限制

macOS 图标生成依赖 `iconutil`，因此 macOS 目标需要在 macOS 主机上构建。Windows/Linux 参数表示可准备对应 Electron 产物；跨平台构建仍受 Electron/Packager 的平台工具要求限制，建议在对应系统 CI 上分别构建和验证。当前不能把支持参数当作跨平台运行已验证。

例如从 macOS 构建 Windows 时，特定版本或元数据处理可能需要 rcedit/Wine 等额外工具。本轮不会安装 Wine，也不以这些参数声称已经交付 Windows/Linux 客户端；建议直接在 Windows/Linux 主机或对应 CI 完成打包、运行及安装验收。本轮实际产物验收目标仅为本机 macOS arm64。

产物是应用目录，并非 DMG、MSI、AppImage 或应用商店安装包。本地 ad-hoc 签名只供自建测试，不能证明发行者身份，也不等同于 Developer ID 签名或公证。脚本没有配置发行代码签名、公证、自动更新或安装系统服务；不同机器上的 Gatekeeper/系统发行检查尚需正式发布流程处理。脚本不会移除系统隔离属性、绕过安全检查或修改屏幕录制/辅助功能权限。

服务端负责真实工作、模型配置和电脑操作审批。关闭客户端会取消未完成的听写，但不停止服务端 Pi 任务；需要在应用中停止任务，或单独关闭服务。新注册空间禁止控制平台宿主整机桌面；原有空间兼容的原生整机助手仍必须由用户在 macOS 设置中授予权限，并在产品里明确启用。

## 验证

2026-11-06 桌面连接壳双语版已重新打包 macOS arm64，58 项测试通过（原有 50 项加 8 项语言测试）。实际连接页脚本的 DOM 事件测试覆盖中英文标签与属性、地址草稿保留、错误提示、存储失败和关闭后的迟到响应；主进程测试覆盖原生菜单、严格语言 IPC 和下载提示。16 个白名单包文件均已核对，代码/UI 与当前源码逐字节一致，两个系统用途说明资源及严格 ad-hoc 签名检查通过。这些检查没有启动产品窗口，也不冒充新版原生窗口 GUI 验收。见 [双语客户端构建证据](evidence/desktop-language-client-package.json)。

2026-11-05 听写版 macOS arm64 包已重新生成并通过严格签名校验；包内代码与当前源文件逐字节一致，麦克风用途说明及 audio-input entitlement 均已读取核实，没有相机 entitlement。未启动窗口或请求麦克风，不能把打包检查当成真实录音验收。见 [speech-client-package.json](evidence/speech-client-package.json)。

`npm run client:test` 最新 11 项纯逻辑测试已通过，覆盖来源限制、连接页桥接、资源与下载边界、会话隔离、连接失败与一次性恢复、原生编辑路由、一次性剪贴板写权限和听写麦克风权限。新增检查包括纯音频类型、原生激活、过期、前后台、旧连接及来源限制；不启动 Electron 或录音。

macOS arm64 已实际打包、严格校验签名，并通过原生窗口验证连接页、错误提示、重试、冷启动重连、消息复制/粘贴、系统下载保存框和附件选择上传。系统保存框通过原生编辑菜单完成全选和粘贴；自动化工具直接发送组合键的结果不稳定，未将其作为该面板快捷键通过的依据。独立的本机模拟模型完成一分钟真实 Pi 任务，客户端退出后后台仍完成任务，重新打开可见完整结果。测试空间随后关闭并清理，客户端回到正式本机空间。详细证据见 [验收记录](verification.md)。

新版平台的空间文件下载路径已纳入桌面策略检查。账户、团队与平台运营页面在原生窗口中的实际操作仍待验收，上述早期窗口验证不覆盖这些新增页面。Windows、Linux、macOS x64、桌面客户端中的公网账户登录与实际远程部署尚未实机验证；此前服务端的 HTTPS 配对测试不代替这些验收。

2026-11-05 重新生成 macOS arm64 客户端，严格签名校验通过。包内 8 个客户端文件均与白名单对应，7 个代码/UI 文件与当前源文件逐字节相同，`package.json` 仅移除了发布标记。已直接验证包内空间下载规则，未启动窗口。暂存发布与失败恢复的 4 个临时目录场景通过。首次图标转换因受限执行环境失败，同一输入在正常构建权限下成功；没有修改系统权限或图标内容。证据见 [platform-client-package.json](evidence/platform-client-package.json)。

官方参考：[Electron Packager JavaScript API](https://packages.electronjs.org/packager/v20.2.0/functions/packager.html)、[Packager 参数与平台图标说明](https://packages.electronjs.org/packager/v20.2.0/interfaces/Options.html)、[Electron 应用打包概念](https://www.electronjs.org/docs/latest/tutorial/application-distribution)、[官方 macOS 签名工具](https://github.com/electron/osx-sign)、[Electron Builder 关于 ad-hoc 与 hardened runtime 的说明](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。
