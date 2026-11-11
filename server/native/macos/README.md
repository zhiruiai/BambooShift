# macOS 原生桌面助手

此模块通过 ScreenCaptureKit 截取主显示器，并通过 CoreGraphics 发送鼠标、Unicode 文字和白名单快捷键。它是整个桌面的控制能力，需用户在产品中明确选择「整机桌面」并在 macOS 中人工授予权限。默认关闭。它不会把浏览器截图冒充桌面截图。

## 构建与只读检查

需要 macOS 14+ 与 Apple Xcode Command Line Tools。构建命令不截图、不发送输入、不请求权限，也不修改系统配置：

```sh
npm run desktop:build
npm run desktop:check
```

构建产物位于 `data/native/`，完整路径由构建命令输出。BambooShift Desktop Helper 的应用标识为 `com.openbot.desktop-helper`。编译缓存、纯测试可执行文件及签名均留在 `data/native`。本地使用 ad-hoc 签名；分发时需要正式 Developer ID 签名及公证。路径稳定不保证 macOS 在重新编译后保留授权。macOS 可能把进程权限归属到启动它的宿主应用；以 `desktop:check` 的有效权限及系统设置展示为准。

用户自行打开「系统设置 → 隐私与安全性」，将助手或系统显示的启动宿主加入「屏幕与系统音频录制」和「辅助功能」。完成后按 macOS 要求重启助手/宿主，再刷新状态。程序只调用 `CGPreflightScreenCaptureAccess` 和 `AXIsProcessTrusted` 检查，不调用权限请求接口，不打开设置，不自动授权。

`desktop:check` 仅返回权限、主屏尺寸及显示器布局元信息，不枚举窗口标题，不读取屏幕内容。`available` 表示助手/系统可用，`authorized` 表示屏幕录制和辅助功能均已授权；它们不代表产品已启用控制。

## 协议与坐标

Node `createDesktopAdapter()` 默认禁用。产品层完成明确确认后才能调用 `setEnabled(true)`。每次操作启动短生命周期助手，stdin 为一个 JSON，stdout 为一个 JSON，随后退出。支持 `status`、`capture`、`input`，后两项还必须显式 `enabled:true` 并通过原生权限预检查。协议不接受 shell、JavaScript、AppleScript、任意可执行文件或剪贴板命令。

截图只覆盖主屏，保留宽高比且不超过 1600 × 1000 像素，不落盘。所有输入坐标以返回截图像素为单位；helper 根据主屏 `CGDisplayBounds` 将其映射到 Quartz 左上角原点的逻辑坐标，包含 Retina 缩放及显示器原点偏移。`status.width/height` 为预期截图尺寸；`displays[].logicalWidth/Height` 与 `pixelWidth/Height` 为源屏幕元数据。

执行输入前必须已取得截图。输入附带助手生成的屏幕几何标识；主屏、尺寸或缩放变化时拒绝旧截图坐标，要求重新截图。该标识仅描述屏幕布局，不能证明某个窗口内容未变化。

输入支持：

- `click {x,y,button?:'left'|'right',clickCount?:1|2}`。
- `drag {x,y,toX,toY,durationMs?:100..2000}`，默认 400ms，左键拖动。
- `type {text}`，最多 20,000 个 UTF-16 单元，以 Unicode 事件输入；不会读写系统剪贴板。个别不接受 Unicode CGEvent 的应用可能需要用户自行输入。
- `key {key}`，字母、数字、常用标点、Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、Space、F1–F12，可组合 `ControlOrMeta`、`Meta`/`Command`、`Control`、`Alt`/`Option`、`Shift`。快捷键使用 Apple ANSI 虚拟键码；不同键盘布局可能影响标点位置。文本请使用 `type`。
- `scroll {deltaY,deltaX?}`，每轴 ±4000 像素，正值代表向下/向右滚动。

文字和快捷键发往当前获得焦点的应用，滚动作用于当前光标位置；操作前请先点击截图内的目标。多显示器环境暂时不能查看次屏，应把需要操作的窗口移到主屏。

截图为 PNG，返回真实尺寸和 UTC 时间戳。Node 同时检查协议、PNG 文件头/尺寸、8MB 图片上限，拒绝未知操作字段。原生 helper 独立验证输入、请求 128KB 上限、权限及屏幕布局。

## 取消与验证范围

Node 对每个进程设置时限（状态 5 秒、截图 15 秒、输入 10 秒），取消先发 SIGTERM，等待 500ms 后以 SIGKILL 兜底，并在进程退出后才结束 Promise。helper 在正常路径和 SIGTERM/SIGINT 中释放已按下的鼠标/按键；拖动最长 2 秒。强制杀进程或操作系统异常无法绝对保证事件交付，用户始终可在本机结束接管。关闭或切换控制表面会禁用适配器、清空截图几何并取消正在进行的命令；后续明确启用可重新使用。

纯 Swift 测试验证 Retina/偏移映射、过期截图、键位和操作边界；Node 单测用独立 fake helper 验证默认关闭、权限拒绝、PNG 校验、TERM 清理、KILL 兜底及等待进程退出。测试不会对真实桌面截图或发输入。真实操作应由用户授权后，通过产品 UI 在可控的测试窗口人工验证；构建成功并不代表当前机器已授予权限或已完成真实输入验证。

官方参考：[SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)、[CGPreflightScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())、[CGEvent Unicode 输入](https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:))。实际签名同时以本机 Apple macOS SDK 的 ScreenCaptureKit、CoreGraphics、HIServices 头文件为准。
