# BambooShift 电脑执行层

BambooShift 把聊天服务与执行电脑分开。Web、Electron 和 Flutter 都通过同一套工作空间 API 查看画面和提交操作。Pi 请求电脑工具，Rust 核验权限、目标和审批，再调用相应的 Worker。关闭查看窗口会停止客户端观察，后台任务的生命周期由服务端和执行电脑决定。

当前平台按空间创建独立电脑控制器。下文单空间实现中的 `/api/computer/*`，在产品入口实际使用 `/api/workspaces/<workspaceId>/computer/*` 并要求产品账户及空间成员身份；Worker 自身路径不变。连接、断开、重新连接与环境设置由空间拥有者管理，成员可参与已有电脑的工作、审批和接管。默认本机模式使用隔离浏览器。打包桌面应用可通过明确选择启用本机整机控制；配置了专用 Worker 后，拥有者也可以开启已授权的 macOS 整机桌面或通过会话校验的 Linux 虚拟桌面。

## 桌面应用的本机工作空间

首次打开包含本地运行环境的安装包，选择“在这台电脑开始”，应用会启动自己的 Rust 服务、Pi 和电脑 Worker，使用独立的个人数据目录，自动建立本机账户会话。无需手动启动服务或填写账户密码；模型连接仍由用户配置。退出应用会停止这套本地运行环境，对话与工作区文件保留在本机。选择“连接已有工作空间”则继续使用已有服务的账户与数据；本机个人数据不会自动同步到团队或手机。

带内置运行环境的源码开发预览包含本机服务与 Node，不另附 Chrome。聊天、工作区文件，以及明确启用后的本机命令与已获系统授权的原生桌面，不依赖独立浏览器启动；独立浏览器任务仍要求执行电脑已安装 Chrome，缺少时会提示安装。Electron 自带的页面显示引擎不作为 Bot 的独立浏览器使用。当前自动发布仍提供 macOS 和 Windows 连接客户端，内置运行环境尚待原生依赖再分发材料与安装包验收。Linux 的 `--with-runtime` 开发打包路径要求同平台同架构，且不包含原生宿主桌面控制。

需要操作原生应用或执行本机命令时，在开始前勾选“允许整机操作”。这个选项会持久保存，原生桌面画面仍须在电脑面板中显式启用，每条 Bot 输入和本机命令仍须批准。未勾选、安装包没有相应组件、或连接团队服务时，不会通过这个入口开启宿主整机能力。已有空间可以连接独立 Worker 或云电脑，沿用原有配对与审批。

本机服务只监听回环地址，应用用私有启动凭据交换正常的账户会话；凭据不进入网页、聊天或模型工具。`localDesktop` 是应用生成的私有服务配置，不能通过聊天 API 修改，且不能与 `publicOrigin`、`webOrigin` 或运营服务配置并用。`hostControl` 默认为 `false`；明确启用后，`desktopDriver` 指向随包驱动和由 Electron 创建的私有 Unix socket：

```json
{
  "localDesktop": {
    "bootstrapToken": "<应用每次启动生成的 64 位十六进制凭据>",
    "hostControl": true,
    "desktopDriver": {
      "kind": "cua",
      "executablePath": "<随包驱动的绝对路径>",
      "socketPath": "<当前启动周期的私有连接绝对路径>"
    }
  }
}
```

这段配置用于说明部署边界，用户无需手工填写。`local-shell-v1` 表示已明确允许在当前用户账户下执行命令，`workspace-host-desktop-v1` 表示已配置宿主桌面适配器；后者不表示 macOS 已授予屏幕录制和辅助功能权限，真正就绪状态来自健康响应中的 `desktop.available` 与 `desktop.authorized`。

## 选择执行位置

Web 或 Electron 中，在「设置 → 电脑」管理连接。「你的电脑」可以配对设备或选用服务所在电脑的隔离浏览器。「Bot 的电脑」显示已绑定的托管云电脑和自有工作电脑入口。也可以从会话的显示器图标查看所选 Bot 的画面，并在面板顶部切换执行位置。打开设置或查看状态不会启动电脑或切换连接。

此处选择的是浏览器、文件和电脑操作的执行位置。Pi 使用哪个模型服务由工作空间的模型配置决定。

| 入口 | 实际运行位置 |
| --- | --- |
| 本机 | BambooShift 服务所在电脑的执行器。默认使用隔离浏览器；桌面应用明确启用整机能力后，也可切换已授权的原生桌面。服务和客户端同机时才是当前设备。 |
| 云电脑 | 已由部署者绑定的托管云电脑。尚未绑定时，空间拥有者可以进入连接自有云服务器的表单。 |
| 其他电脑 | 自有云服务器或另一台已启动独立 Worker 的电脑。当前 Mac 的原生应用也通过此处连接，需要在 Mac 上开启相应系统权限。 |

每个空间当前使用一个活动工作电脑。配置好的云电脑和服务所在电脑都可以显式选择，切到服务所在电脑时会保留已保存的远程连接。浏览器和手机上的“服务所在电脑”指运行 BambooShift 服务的机器。桌面应用的个人工作空间可使用随包原生桌面；从团队服务操作另一台 Mac、物理电脑或自有云服务器时，在目标设备运行独立 Worker 并连接。已配置的云电脑离线时，Bot 会报告状态，用户可以显式恢复。

电脑面板分别显示执行位置与画面类型。服务所在电脑和绑定到空间的单画面 Worker 由 Bot 轮流使用。启用画面池的 Worker 可为 Bot 分配独立画面。Web 和 Electron 的电脑面板会在工作期间自动更新截图，可随时暂停。Flutter 可从聊天查看位置、云状态和当前画面。拥有者可在手机上启动已绑定的云电脑并分配可用画面。手机会区分观看和手动接管，并在服务端确认后提示控制权已归还。Worker 地址和连接凭据在 Web 或桌面端管理。

切换前由服务端检查任务、待执行操作和接管，必要时要求释放已分配的画面。每次连接有独立的 `targetRevision`，用于客户端及时丢弃旧画面与接管状态；真正的操作仍受 Worker 实例、画面会话和服务端审批校验。若以后允许多台电脑同时为同一空间工作，目标身份必须贯穿任务、画面绑定、审批、接管和文件传输，再按目标隔离维护和清理。现有客户端可以继续使用默认目标的 API。

## 已配置的云电脑

运维可以为一个空间绑定已有 CubeSandbox 电脑，电脑面板显示真实状态、到期时间及连接状态。只有拥有者可以点击启动或恢复并连接；服务申请从现在起至少两小时，不缩短已有更晚期限，不自动续期。团队成员只查看状态和使用已有工作电脑。

`GET /api/workspaces/<workspaceId>/cloud-computer` 只查询 CubeAPI，不探测 Worker 或调用恢复。`POST …/cloud-computer/start` 只接受空请求体，使用服务端固定的空间与实例绑定，浏览器不能指定实例 ID、地址、路径或凭据。启动前同步阻止新的任务和电脑操作；若已有任务、待审批操作、人工接管或电脑请求，返回冲突并保留原工作。运行中的远端接管也会复核，不能仅依赖本端缓存。恢复成功后重新验证 Worker 协议及连接绑定，旧审批不重放。

私有绑定位于 `<spaceDir>/computer/cloud.json`，文件权限 `0600`，必须与平台登记的空间 ID 对应。新空间需单独分配执行电脑。当前接入使用明确的 loopback CubeAPI 入口与预先保存的 Worker 连接。绑定声明 `autoResume: false`，状态查询只读取实例状态。基础设施地址和凭据留在服务端。接入步骤见 [CubeSandbox 说明](cubesandbox.md)。

启动请求发出后发生超时或连接失败，会提示实例可能已恢复、需要刷新确认，不宣称已经撤销恢复。关闭服务会中止等待并释放维护状态；身份失效后不再保存连接。现阶段不提供实例创建、删除、暂停或批量分配入口，SSH 隧道及连接桥仍需保持运行。

## 本机运行

拥有者选择服务所在电脑后，Worker 使用该空间的工作目录。可以列出和读取工作区文件，执行 `pwd`、`ls`、`date`、`uname` 四个只读命令。写入文件、操作工作浏览器和输入会生成待批准操作。在聊天卡片核对参数后，可允许本次操作或拒绝，也可打开电脑面板查看画面。通过隔离检查的远程 Worker 可使用下文的 `remote_shell`；本机终端限于上面的只读命令。

浏览器使用 `playwright-core` 启动本机 Chrome 的独立用户目录 `data/browser-profile`，不会导入个人 Chrome 的登录信息。首次使用可在电脑面板点击人工接管，或请求 Bot 打开网址并批准。截图来自这一个真实浏览器页面，没有打开时返回明确错误，不使用示意图冒充直播。

可选环境变量：

- `OPENBOT_BROWSER_EXECUTABLE`：自备 Chromium/Chrome 的可执行文件路径。
- `OPENBOT_BROWSER_HEADLESS=false`：显示独立浏览器窗口，供手动登录或接管；默认在后台运行。
- `OPENBOT_BROWSER_ALLOWED_ORIGINS`：仅用于你控制的本地测试网页，填写逗号分隔的完整 origin，例如 `http://127.0.0.1:48080`。不能包含 BambooShift 控制面常用端口。

独立浏览器默认拒绝访问本机、私有网络与云元数据地址；HTTP CONNECT 代理逐个连接检查并固定目标 IP，因此页面重定向和子请求也会受限。Chromium 的隐式 loopback 绕过已关闭，原生自动下载默认禁用，Service Worker 被禁用；明确批准的 `browser_download` 通过有界读取保存导出文件。不要为不可信页面增加内网例外。外部页面仍可能产生联网副作用，因此浏览器操作需要批准。

远程部署时，聊天服务和 Worker 都必须设置同一 `OPENBOT_PUBLIC_ORIGIN`。这个控制台域名在所有端口上都被浏览器硬性拒绝，测试白名单也不能覆盖；连接时聊天服务核对 Worker 声明的受保护域名，不一致则拒绝连接。这样即使控制台使用公网域名，Bot 也无法通过工作浏览器打开控制台自行批准操作。

当前 Worker 协议为 `openbot-computer-v2`。聊天服务在连接时记录 Worker 本次启动的随机实例 ID 与完整控制台 origin，并在每次操作、截图、接管和状态请求前重新核对健康声明。请求同时携带期望实例与 origin，Worker 在接收及串行队列开始执行时再次校验，防止健康检查后恰好重启而执行旧审批。实例 ID 是连接约束，不代替 Bearer 令牌认证。

健康检查失败、实例变化或隔离声明变化会使原连接失效，撤销未完成审批、待执行队列和本端接管凭据；网络恢复不会自动复活旧连接，需用户重新连接。旧实例的延迟清理请求只能被拒绝，不能撤销新实例上的接管。已开始的操作可能已产生效果，失效不代表回滚。旧版 Worker 会被明确拒绝，请同时升级聊天服务和 Worker，再重新连接。

默认模式覆盖远程浏览器、文件和受控终端。另有明确启用的 macOS 主屏适配，以及已在唯一 VM 实测的 [Linux 专用虚拟桌面](linux-desktop.md)；这些界面均使用截图，不提供音频/视频串流。

## macOS 整机桌面

打包的 macOS 桌面应用使用随包附带的 Cua Driver 0.47.8 独立二进制，通过 Electron 管理的私有连接执行原生桌面操作，无需用户安装编译工具。上游将[这个固定版本](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.47.8)标记为预发布；项目固定制品及校验值，不自动跟随上游更新。它沿用 Rust 的任务审批和接管权限；驱动路径与连接地址不会成为模型工具参数。权限检查不会截屏、请求授权或运行直接捕获探测。当前接入仅支持 macOS 主屏，Windows、Linux 原生宿主桌面尚未接入此适配器。

安装或勾选“允许整机操作”不会代替系统授权。用户需在 macOS 系统设置中为实际列出的桌面应用授予“屏幕与系统音频录制”和“辅助功能”，按系统要求重新打开应用后，再在电脑面板选择“整机桌面”并确认。录屏权限未授予时，驱动可以报告状态，但截图和输入均被拒绝。

Cua 点击绑定一次性截图标识；拖动与滚动先复核主屏尺寸，再将缩略图坐标换回原始屏幕像素。每次输入后须重新获取截图，滚动距离按驱动的滚轮档位取整（macOS 每档约 120 像素）。驱动未报告可用于固定主屏身份的稳定显示器 ID，因此目前只能检查主屏尺寸和缩放变化，无法辨别尺寸完全相同的主屏替换。实现按 [固定版本的公开输入协议](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.8/libs/cua-driver/rust/crates/cua-driver-contract/src/inputs.rs) 适配，未引入 Cua 的独立代理循环、云平台或额外权限系统。

保留的独立 Swift 助手用于原有手动部署与配对路径：在 macOS 14+ 的工作电脑安装 Apple Command Line Tools 后，运行 `npm run desktop:build` 构建，`npm run desktop:check` 检查权限与主显示器信息。

1. 在自己的 Mac 上按照下节启动独立 Worker，同时设置 `OPENBOT_WORKER_ALLOW_HOST_DESKTOP=true` 和 `OPENBOT_WORKER_WORKSPACE_ID`。可用 `OPENBOT_MACOS_DESKTOP_HELPER` 指定助手可执行文件的绝对路径。
2. 打开专用工作空间的电脑面板，在远程 Worker 连接设置填入地址和令牌。如果 BambooShift 服务也在这台 Mac 上，可用 Worker 的本机监听地址。
3. 在 Mac 上授予系统权限后，回到电脑面板选择“整机桌面”，检查两项权限并点击“使用整机桌面”。

用户需要在 macOS 的“屏幕与系统音频录制”和“辅助功能”中允许助手或系统列出的启动应用。整机范围包括主屏上的原生应用，具有该空间权限且已登录的设备可查看截图。视觉模型观察时，截图会发给用户配置的模型。请使用只包含有权操作这台 Mac 的成员的专用空间。完整权限步骤、协议和源码参考 [原生助手说明](../server/native/macos/README.md)。

| 接口                         | 作用                                             |
| ---------------------------- | ------------------------------------------------ |
| `GET /api/computer/status`   | 返回 `surface`、主屏尺寸与两项有效权限，只读检查 |
| `POST /api/computer/surface` | `{surface:'browser'                              | 'desktop',confirm:true}`，桌面必须显式确认且权限就绪 |
| Worker `POST /surface`       | 同一合同，需 Worker 令牌                         |

模型动作包括 `desktop_click`、`desktop_type`、`desktop_key`、`desktop_scroll`、`desktop_drag`，每次输入都需用户批准。人工接管使用同一短期租约，期间模型输入和截图被阻止。截图尺寸来自实际 PNG，主屏最长不超过 1600 × 1000；Retina 输入按逻辑屏幕坐标映射，屏幕布局改变会拒绝旧坐标。单击、双击、右键与两点拖动均可在 UI 操作；Unicode 输入不修改剪贴板。

切换操作范围会结束接管、撤销旧审批与排队动作。重启或连接另一台 Worker 后恢复为浏览器；不能让上次的桌面授权悄悄沿用。独立 Swift 助手取消操作时先释放按下的输入，再等待辅助进程退出。Cua 输入发出后若取消、超时或连接中断，代理关闭不能证明原生输入已停止；此时执行器报告清理状态未知并停用当前连接，需重启本地工作空间并检查画面，不能自动重发。

整机模式具有当前系统用户的操作范围，**浏览器代理及工作区路径限制不能限制其它原生应用**。它不构成 OS 沙箱；远程生产使用应将执行电脑与控制台、密钥和其它用户数据分离。主屏外的窗口暂不支持。已验证官方二进制与现有 MCP 客户端的真实只读握手、非提示式权限查询和屏幕尺寸查询，以及模拟截图/输入的坐标、权限、取消和失联处理。本轮未获取实际桌面截图或发送键鼠输入；录屏权限未授予，真实截图和输入效果仍需用户授权后的验收。

## 独立 Worker

### 配对设备

在「设置 → 电脑 → 你的电脑」展开配对指引，复制该空间的命令。在目标电脑上下载同一版本的 BambooShift 源码、安装依赖，再在项目根目录的交互式终端运行命令。它启动一个只绑定本机回环地址的 Worker，使用独立的工作目录，并显示本次连接地址和临时令牌。保持终端开启。退出进程后令牌失效，重启会生成新地址和令牌，工作文件保留。

- 若 BambooShift 服务与 Worker 同机，使用终端输出的地址。跨机器时，由部署者配置可达的 HTTPS 入口，并在命令加上与服务相同的 `--origin <HTTPS origin>`。将该入口填入设置页，令牌单独填写。
- 若要在 macOS 使用原生桌面，先执行 `npm run desktop:build` 并在系统设置启用录屏和辅助功能，再使用带 `--desktop` 的配对命令。连接通过后按面板提示启用桌面范围。
- 填写地址和令牌后，可以先用「检查连接」确认空间、协议和能力，再连接。检查只读取 Worker 的健康声明，不保存令牌、切换电脑、分配画面或启动浏览器。已有 Worker 如未声明空间 ID，可继续走原有独立 Worker 接入方式，或按配对指引重新部署。

### 手动部署

在装有 Node 22.19+ 和 Chrome 的物理电脑或云服务器上检出项目并安装依赖。从 BambooShift 工作空间链接的 `/w/…` 部分复制空间 UUID，在 Worker 的私有环境中设置。每个空间使用独立令牌、工作区和浏览器资料目录。

```sh
export OPENBOT_WORKER_WORKSPACE_ID='<你的工作空间 UUID>'
export OPENBOT_WORKER_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
npm run computer:worker
```

Worker 会核对工作空间身份。单画面配置只开放一个共享画面，Bot 的任务按顺序使用。要为 Bot 分配不同画面，使用 [Linux 虚拟桌面画面池](linux-desktop.md)。

Worker 默认监听本机端口 3002。如果 BambooShift 服务与 Worker 在同一台电脑，请先通过 `OPENBOT_WORKER_PORT` 为 Worker 指定一个空闲端口，再在连接设置中填入对应的本机地址和令牌。跨设备访问使用 HTTPS 反向代理或部署者管理的本机隧道。不要把令牌放在 URL 中。令牌具有执行权限，应只提供给可信 BambooShift 服务。

可配置 `OPENBOT_WORKER_HOST`、`OPENBOT_WORKER_PORT`、`OPENBOT_WORKER_WORKSPACE`。默认工作区为 `data/worker/workspace`，浏览器资料也留在该执行电脑。连接选择、远程地址、令牌及实例绑定由聊天服务原子保存到 `data/computer/connection.json`（权限 0600），不会把令牌返回前端。启动先验证同一个 Worker 的实例 ID 与控制台声明，通过后才恢复连接；不可达或实例变化时保持远程选择并显示重连提示，不回退本机，也不重放旧批准。

电脑弹窗的“重新连接”可使用后台已保存凭据。主动断开会保留远程地址但禁止下次启动自动连接。明确切回本机会清除远程选择。配置损坏或非法时拒绝恢复。接入和重新连接见 [CubeSandbox 说明](cubesandbox.md)。

聊天资料库与独立 Worker 工作区是不同位置。资料库中的「发送到电脑」可把选中文件复制到目标相对路径；电脑面板的「文件」可浏览目录，将结果存入当前会话资料库。单文件最多 10 MiB，支持图片、PDF 等二进制内容，不会自动同步整个资料库。

Pi 通过 `computer_action` 的 `upload_file` 使用 `workspace_list` 返回的 `fileId` 请求发送，批准前不会写入。审批绑定文件名、大小和 SHA256，来源文件在等待期间变更后须重新申请。`download_file` 按工作区相对路径取回文件，返回资料库 `fileId` 与可下载链接，并记录来源电脑和路径。UI 直接点击「发送文件」只批准这次明确选中的文件，不会批准其它模型操作。

上传不覆盖同名文件；取回时自动使用唯一文件名保存副本。电脑工作区接口拒绝越界路径、符号链接、硬链接和非普通文件，传输过程限制读取字节数。Linux 文件操作逐层固定目录句柄，直到读取、写入或目录列举结束；持续运行的桌面程序替换父目录不能把操作转向工作区外。服务为 root、工作区属于 UID 65532 时，新建文件与目录通过句柄交给该专用身份，使桌面应用可读取上传内容；已有文件不改所有权。切换连接会取消尚未完成的传输；已在原电脑完成的写入不会因此回滚。新 Worker 声明 `binary-file-transfer` 能力，旧版本会得到升级提示。

Worker API（每个请求都需要 `Authorization: Bearer …`）：初次 `GET /health` 返回 `protocol`、`instanceId`、`controlOrigin`；随后请求必须携带 `X-OpenBot-Worker-Instance` 和 `X-OpenBot-Control-Origin`，无控制台 origin 时使用字面值 `none`。握手不匹配返回 `WORKER_CONNECTION_INVALID`。聊天服务会自动维护这些请求头，前端不会直接获取 Worker 令牌。

对于 `kind:'virtual'` 的桌面，健康响应还提供 `session:{id,generation}`；可用且已授权、身份合法时才包含 `virtual-desktop-v1`。控制器固定此身份，桌面动作也保存申请时的身份。进入桌面、桌面截图/动作、桌面接管启动与输入都须携带匹配的 `X-OpenBot-Desktop-Session`、`X-OpenBot-Desktop-Generation`，出队时再次核验；旧、缺失或不完整的身份拒绝执行。健康、文件、退出到浏览器和结束接管无需这对桌面身份，仍须原有 Worker 鉴权与实例绑定。

| 路径                        | 作用                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `GET /health`               | 主机名称、系统、协议版本与能力                                      |
| `GET /screenshot`           | 当前浏览器或已启用桌面的 PNG，画面不可用时返回 503                  |
| `POST /execute`             | 执行聊天服务已批准的操作                                            |
| `POST /execute-with-frame`  | 在同一执行锁中完成支持的动作并返回当时画面，需 `action-frames` 能力 |
| `GET /files?path=…`         | 工作区目录列表，最多返回 200 项                                     |
| `GET /files/content?path=…` | 读取单个文件，返回有大小限制的二进制内容                            |
| `PUT /files/content?path=…` | 接收 `application/octet-stream`，独占创建文件                       |
| `GET /takeover/status`      | 接管状态和画面尺寸，不返回接管凭据                                  |
| `POST /takeover/start`      | 启动人工接管，返回短期凭据                                          |
| `POST /takeover/input`      | 执行持有接管凭据的用户输入                                          |
| `POST /takeover/end`        | 结束人工接管                                                        |

Worker 拒绝带 `Origin` 的浏览器直连请求。聊天服务默认只监听本机；跨设备使用需启用 [设备认证](devices.md) 并配置 HTTPS 入口。

## 操作与审批

`POST /api/computer/actions` 及 Pi 工具接受同一结构，例如：

```json
{ "type": "browser_navigate", "url": "https://example.com" }
```

返回 `pending` 操作后，可使用 `POST /api/computer/actions/:id/approve` 批准，或 `…/reject` 拒绝。操作进入串行队列，避免多个 Bot 同时抢占页面。动作结果包含真实网页可见文本与控件信息供 Pi 后续工作。重复批准返回 409。切换/断开电脑会拒绝未批准的请求，重启不会恢复未批准操作。

切换电脑会失效旧连接的整个待执行队列，关闭本机浏览器和代理，并终止正在等待的远程请求；旧队列不会在新电脑上执行。已经发送到远程 Worker 的操作仍可能在原电脑完成，断开连接不等于回滚。服务关闭时调用 `closeComputer()` 释放资源；`GET /api/computer/status` 会主动检查远程 Worker 是否仍在线。

可用类型：`list_files`、`read_file`、`write_file`、`upload_file`、`download_file`、`terminal_command`、`remote_shell`、`local_shell`、`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_back`。网站输入 `text` 与文件正文 `content` 不写入持久审计，文件传输仅记录路径、大小和状态等元数据；远程及本机命令的 `command` 会保留在审批记录中。审批对象包含完整输入，用户应先核对操作。HTTP 文件传输请求另须提供有效 `conversationId`；Pi 工具自动使用当前会话。

支持 `browser-tabs-v1` 的执行器还提供 `browser_tabs`、`browser_select_tab` 和 `browser_close_tab`。列表是只读操作，不启动浏览器，只返回当前 Bot 画面拥有的标签页；最多返回 100 页，超出时 `truncated` 为真，当前页优先保留。切换或关闭必须使用列表中的 `tabId`，并由原发起人审批。关闭、画面重建或浏览器重启后，旧标识不会指向另一页；其他 Bot 的标识也不能使用。关闭最后一页不会自动打开替代页。人工接管期间，这三种操作均被拒绝；旧执行器需升级后才能使用。

`remote_shell` 必须连接声明 `isolated-shell-v1` 的远程电脑，且每次批准后才运行。例如 `{"type":"remote_shell","command":"python3 -c 'print(6*7)'","path":"."}`。命令固定最长 30 秒、无网络、只在工作区持久读写；输出合计最多 256 KiB，结果包含真实退出码、取消、超时与资源限制状态。生成文件仍需用 `download_file` 取回聊天。命令 ID 通过 `X-OpenBot-Action-Id` 绑定，取消另走固定 `POST /shell/cancel`，停止清理无法确认时停用连接。部署和维护细节见 [远程代码执行](remote-shell.md)。

`local_shell` 需要桌面应用的“允许整机操作”选项和执行器声明的 `local-shell-v1`，例如 `{"type":"local_shell","command":"printf hello","path":"."}`。Rust 在请求时检查目标能力，保存原命令并等待原发起人批准，执行时再次检查任务与审批权限。命令通过本机 `/bin/sh` 在当前系统用户身份下运行，可联网、访问用户文件和启动应用；相对 `path` 只决定初始目录，不限制命令随后访问的位置。每次命令的时间预算为 30 秒，stdout 与 stderr 合计最多 256 KiB，服务密钥不通过环境变量传入子进程。正常退出、取消、超时和输出超限都会收尾原命令进程组中的后台任务；只有确认进程组已消失、输出管道已关闭，才返回清理完成，人工接管也等待这一结果。已发生的修改不会回滚，脱离原进程组的独立应用不保证同时停止。若清理状态无法确认，执行器停用连接并要求恢复，不能自动重试。`terminal_command` 仍仅支持原有的 `pwd`、`ls`、`date`、`uname`。

2026-11-13 的 [macOS ARM64 打包运行时验证](evidence/local-shell-process-cleanup-20261113.json) 使用合成命令确认同组后台进程退出后才返回结果、取消确认后没有延迟写入、执行器可继续运行下一条命令。它没有验证桌面键鼠、录屏、Rust 审批界面、Linux 安装包或脱离原进程组的进程。

网站导出另使用 `browser_download`，必须指定待点击的 `selector` 与保存文件的相对 `path`，例如 `{"type":"browser_download","selector":"#export-csv","path":"reports/monthly.csv"}`。批准后才点击，最多等待 30 秒、接收最多 10 MiB，不覆盖已有文件。支持 HTTP(S) 附件响应、页面中明确带 `download` 属性的链接，以及当前页生成的 Blob/Data 下载；没有可识别下载意图的普通网页导航会失败，不会把 HTML 错当报表。下载结果先留在电脑工作区，随后可用 `download_file` 取回聊天。

浏览器仍保持默认禁止自动下载，只有本次已批准的导出会被捕获。收到文件时逐段限制大小，不先让浏览器无限落盘再检查。停止任务、接管、切换连接及超时都会取消；若网页自身的 Blob 读取挂住，会关闭当前独立工作页以结束读取，浏览器登录资料保留，后续可重新导航。

## 人工接管与模型观察

点击人工接管后，前端取得 5 分钟有效的 `leaseId` 和对应操作范围的画面尺寸。浏览器模式为 `1440 × 900`，macOS 整机桌面使用主屏实际尺寸，当前 Linux 专用虚拟桌面为 `1440 × 900`。首次浏览器接管会启动浏览器；可在地址栏输入网址、点击截图中的控件、填写输入框、发送允许的按键或滚动，完成网站登录。所有这些都是用户的即时操作，无须再次批准。

| 聊天 API                            | 请求和结果                                                  |
| ----------------------------------- | ----------------------------------------------------------- |
| `POST /api/computer/takeover/start` | 返回 `leaseId, expiresAt, width, height`                    |
| `GET /api/computer/takeover/status` | 返回 `active, expiresAt?, width, height`，不含 lease        |
| `POST /api/computer/takeover/input` | `{leaseId,type,...}`，成功返回 `ok,capturedAt,width,height` |
| `POST /api/computer/takeover/end`   | `{leaseId}`，结束后返回状态                                 |
| `GET /api/computer/screenshot`      | PNG 和 `X-Captured-At` 响应头，可定时刷新                   |

输入类型包括 `click`（画面坐标 `x,y`）、`type`（`text`）、`key`（`key`）、`scroll`（`deltaY`）和 `navigate`（`url`）。客户端必须按图片实际显示尺寸把点击映射到返回的 viewport，不能把 CSS 像素直接当作浏览器坐标。允许的键为 Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、ControlOrMeta+A。没有任意 JavaScript、shell 或系统键组合入口。

接管凭据只返回给发起接管的 UI，不进入 Bot 工具结果、消息、状态接口或审计。服务器和 Worker 都检查有效期。断开或切换电脑会使控制端凭据立即失效，并尝试通知 Worker 结束接管；网络已经中断时，远端依靠最多 5 分钟的有效期释放锁。接管期间 Bot 的浏览器动作保留为待批准，结束接管后可继续原审批流程；其它文件任务可继续。

截图预览和人工输入请求取消时，控制器与 Worker 都会撤销尚未执行的队列请求；只有确认运行中的输入已经清理，才继续下一项。独立助手等待进程结束，Cua 输入无法确认清理时停用连接。该链路经过固定 Cube 连接桥仍保留取消信号。已产生的输入效果不会回滚；页面关闭也不等于取消已交给 Pi 的后台任务。

Bot 观察截图使用 `captureComputerScreenshot({forAgent:true,signal})`。本机和 Worker 都会在接管期间拒绝模型观察，避免把用户输入登录凭据时的画面交给模型。Worker 的 `browser_screenshot` / `desktop_screenshot` 动作向可信聊天服务返回 PNG base64，聊天服务将其作为模型 image block 传入；操作卡只保留截图元数据，不保存图像。用户 UI 的截图接口在接管期间继续可用。

人工接管审计保存在 `data/computer/takeover.jsonl`（Worker 为其自身工作区相邻目录），记录动作、坐标、按键或文本长度。输入文本、接管凭据、截图像素不写入审计；导航地址去掉查询参数和片段。

文件路径必须为工作区内相对路径，拒绝目录穿越和绝对路径。Linux 文件边界依赖可信的工作区祖先和操作期间持续持有的目录句柄；macOS 的兼容路径检查不提供同等的 Linux 竞态隔离保证。文件访问限制本身不是进程或网络隔离，独立浏览器仍以启动它的 OS 用户运行；专用虚拟桌面的 namespace 与身份限制另见 [Linux 桌面说明](linux-desktop.md)。

## 验证

`npm test` 中的电脑测试覆盖路径穿越与符号链接、真实文件读写、终端命令限制、Worker token 与 Origin、审批前不写入与重复批准拒绝。浏览器验证依赖本机 Chrome；如 Chrome 启动或网络访问失败，API 返回实际错误，不宣称已完成。

远程协议回归另覆盖：无需 UI 轮询发现声明漂移、健康检查到执行之间重启、同令牌旧实例请求拒绝、排队操作与接管凭据失效、旧清理请求不打断新接管，以及多客户端并发批准不会重复执行。

文件传输回归使用独立工作区验证真实二进制往返、资料库交付链接、来源摘要变化、重名、超限和取消。真实 Pi 的慢速下载测试确认停止任务会关闭下载，迟到的响应不入库；来源检查和排队阶段也可取消，不会因此关闭共用电脑连接。

`npm run test:browser` 运行真实 Chrome 集成测试（合同位于 [Worker 浏览器测试](../server/workers/computer-runtime/tests/computer.browser.test.ts)及相邻浏览器测试文件），仅打开测试自动创建的本机网页，验证输入、点击、PNG 截图、重定向阻断、本机/远程接管、接管期间阻止 Bot 操作和观察、凭据过期及结束后的恢复。默认测试跳过此项，以免在没有 Chrome 的构建环境启动浏览器。GitHub Actions 另在 Ubuntu 上运行 `OPENBOT_BROWSER_TEST=1 npm run backend:test -- --test computer_shared`，用实际 Pi、独立 Worker 和 Chrome 验证批准前不导航、工作空间隔离及页面内容读取。

## Linux 虚拟桌面现状与剩余工作

本轮已加入可实例化的 Linux `DesktopAdapter`、固定 helper/manifest 验证、Xvfb/Openbox/终端会话、会话 ID 与 generation 绑定，以及截图和人工输入取消传播。桌面程序以 UID/GID 65532 运行，使用独立 namespace、只读运行环境和有限可写目录；控制凭据留在 root 私有目录。现有两个离线桌面通过固定画面池接入，独立 Bot 分配、并行、会话身份和人工接管隔离已在指定 VM 实测。配置、资源上限与维护流程集中在 [Linux 专用虚拟桌面](linux-desktop.md)。

文件句柄边界已在该 VM 的临时工作区验证：600 次并发目录替换期间的读取、列举、覆盖写入与上传尝试没有改动工作区外合成文件，新上传文件可由专用 UID 实际读取。记录见 [文件边界证据](evidence/linux-desktop-file-boundary.json)。HTTP 会话绑定与取消回归使用合成桌面，真实 Xvfb 组件检查也只证明执行层，二者均不能代替产品页面的视觉与交互验收。

虚拟桌面的“粘贴文本”已改为受控的临时 X11 selection；真实中文、表情与换行文本逐字节通过，300 单位上限及取消后临时内容清理也已验证。当前桌面没有网络或带窗口的图形浏览器，原有独立 Chrome 的资料和登录不会自动出现在桌面中；联网网页仍需切回独立浏览器。

`/computer/bots/:agentId/*` 只访问服务器为该 Bot 保存的 screen/session/generation，绑定在后台私有文件中持久化。`status` 仅查询，拥有者可明确 `POST /prepare`，Bot 首次电脑任务也可请求分配已有画面。最多两个，满额、身份变化或清理未知时明确拒绝，不借用其他画面。共享文件与隔离命令仍通过电脑级路径执行。`GET /computer/bots` 提供实际容量、绑定与任务状态，同 Bot 跨聊天任务先排队；停止 Pi 后仍等待远端实际清理和历史图保存。

两个浏览器页面共享同一空间的 cookies，并保持自己的标签页和弹窗。带窗口的图形浏览器登录同步仍未实现。双桌面和远程 Chrome 的受控验收范围见 [CubeSandbox 验收说明](cubesandbox.md#验收范围)。不同用户和团队需独立分配执行电脑。

### 释放、恢复与继续处理画面

空间拥有者在所选 Bot 的电脑面板中确认“释放画面”，关闭该 Bot 的浏览器页面和远程应用，成功后腾出固定两个槽位中的一个。未保存的应用内容会丢失；共享工作区文件和同空间浏览器登录状态保留。旧桌面 home 留在服务器，不自动迁移给后续 Bot，也不保证恢复应用状态。释放不删除 Bot；确认已无画面绑定和未完成操作后，才能另行删除 Bot。普通成员及独立的平台运营身份不会因此得到空间电脑维护权限。

故障或清理未知时可用的“恢复画面”执行重置，不能用普通释放掩盖未知清理。运行中的电脑任务、等待队列、待批准操作及人工接管会阻止新释放或重置；正常空闲画面只有释放入口。未配置 `screen-lifecycle-v1` 的旧 Worker 不开放这些操作，部署变量见 [Linux 专用虚拟桌面](linux-desktop.md)。没有自动回收、定时清理或状态刷新触发的维护。

空间 API 使用以下固定路由，路径前缀为 `/api/workspaces/:workspaceId/computer`：

| 请求                                   | 内容与结果                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /bots/:agentId/release`          | `{confirm:true, assignmentRevision}`；成功后 Bot 为 `unassigned`，名额可重新分配 |
| `POST /bots/:agentId/reset`            | 同上；成功提交新的绑定 revision，仍属于同一 Bot                                  |
| `POST /bots/:agentId/lifecycle/resume` | 另带 `operationId`，仅继续服务器保存的同一次释放或重置                           |
| `GET /bots/:agentId/status`            | 只读显示实际状态及 `botScreen.lifecycle`，不会新建或继续维护事务                 |

事务可能需要约 90 秒。确认固定当前 Bot 和 `assignmentRevision`；Worker 还核验画面 revision、会话及 generation。换代后的旧审批、接管或维护请求不能控制新画面；已完成事务的重复请求只查询回执，不再次执行。请求断开不代表维护停止。HTTP 成功但状态仍是 `changing` 或 `blocked` 时，界面仍显示未完成；未知结果保留名额与绑定，只能刷新状态并明确“继续处理”已有事务。除服务器明确拒绝接纳事务外，不自动发起新操作。服务重启读取持久记录，不自动恢复维护事务。

重置返回同 Bot 的新 revision、无待处理 operation 且生命周期为 `ready`，表示事务已完成；如果新画面暂时连接失败，界面提示“重置已完成，画面暂不可用，请检查连接”，仍禁用截图和输入。检查连接、刷新状态确认画面可用后才恢复控制。

画面释放、恢复与继续处理已通过受控接口、真实组件事件及实际 VM 验收。验收后核对原工作文件、旧 home 与共享浏览器资料目录保留。产品界面验收单独见 [验收记录](verification.md)。
