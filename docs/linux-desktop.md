# Linux 专用虚拟桌面

本文中的 VM 部署、截图与验收数字是各链接 JSON 所记载日期的历史记录，不代表当前实例在线或当前源码已重新实机验收。当前业务控制器为 Rust，Worker 仍是独立执行适配器。

新增的[受管有头浏览器启动链](linux-browser.md)已有源码与本机隔离协议、双 Chrome 登录同步测试；它保持桌面终端离线，使用独立的浏览器网络通道。该新链路尚未在远端部署，下面旧 VM 记录不能作为它的实机验收。

这一实现给受管 Linux 电脑增加固定 1440 × 900 的 Xvfb、Openbox 与终端画面，沿用现有电脑面板、逐次审批、人工接管和历史截图。它与独立浏览器是两种界面。当前桌面应用没有网络；联网网页仍通过浏览器界面使用。本轮固定画面池、持久 Bot 绑定和按 Bot 的任务互斥已通过本地临时 HTTP 验证；指定唯一 VM 中的两个真实 Linux 桌面也已完成并行输入与接管隔离验收。

受控 Linux VM 已验证组件运行及临时控制器交付。中文、emoji 和换行的输入字节准确。字体缺少字形时可能显示方框。helper 的内外截止检查可能分别报告 TIMEOUT 或 CANCELLED，验收覆盖两种结果的临时剪贴板和键鼠状态释放。

双屏实机验收覆盖不同 Bot 独立输入、取回合成文件并核对摘要、单屏接管、只读查询和容量边界。验证使用临时控制器，产品界面验收独立记录。其他接入范围见 [CubeSandbox 验收说明](cubesandbox.md#验收范围)。

## 会话与连接

首次部署前按 [Python 控制程序构建](python-control-build.md) 构建并核验两个桌面单文件产物，再复制到固定部署路径。部署端显式运行 `/opt/openbot/desktop-session.py --start <session UUID>`，创建会话；`--stop` 只停止该会话并保留其 home 和共享 workspace。启用下述画面生命周期后，拥有者确认的释放或重置也可通过固定维护程序替换会话。没有后台自动创建、唤醒、续期、重启或回收。一个会话每次重新启动会得到新的 generation。

Worker 配置需要同时提供三个服务端变量：

```sh
OPENBOT_LINUX_DESKTOP_PYTHON=/usr/local/bin/python3
OPENBOT_LINUX_DESKTOP_HELPER=/opt/openbot/desktop-control.py
OPENBOT_LINUX_DESKTOP_MANIFEST=/opt/openbot/desktop/sessions/<session UUID>/manifest.json
```

以上为单屏兼容模式。画面池模式使用 `OPENBOT_WORKER_SCREENS_CONFIG` 指向 root 所有、0600 的固定 JSON，同时保留 Python 与 helper 路径。配置包含 `version: 1`、唯一空间的 `workspaceScopeId`，以及最多两个 `{id, manifestPath, session: {id, generation}}`。逻辑 screen ID、会话 ID 和 generation 均为 UUID；manifest 必须匹配固定会话目录，不接受请求提供的路径。池模式禁用默认路径的 Linux 桌面，避免默认界面和 Bot 界面同时控制同一个会话；默认浏览器、共享文件与单个隔离 shell runner 保留在机器级路径。

`GET /screens` 只读列出已配置画面与可用数量，不创建或启动会话。每个 `/screens/:screenId/` 子路由拥有独立控制器、输入队列、接管租约、取消记录和桌面适配器，共用同一 Worker 启动身份。带 screen ID 的请求必须匹配所访问路由，错误、缺失或不可用时不能回落到默认画面；请求还核对工作空间及 session/generation。配置只服务一个工作空间，两个 Bot 共享该空间的 workspace，不允许将两张屏幕分给两个租户。

[Rust 画面绑定](../server/api/src/computer/screen_bindings.rs)与[生命周期协调器](../server/api/src/computer/lifecycle.rs) 把 Bot 到 screen 的映射、assignment revision、会话身份和维护事务保存到空间私有 `computer/bot-screens.json`。状态查询不分配；明确准备才选择尚未分配的可用槽。满额时拒绝新分配，已有 Bot 保持自己的画面，不抢占或借用另一位 Bot 的会话。恢复、切换连接和云电脑维护先检查各 Bot 的待批准操作、执行和接管。部署端在已记录事务之外更换会话时，旧绑定不会静默转移，旧批准失效；需要明确维护原画面。

[Rust 任务租约](../server/api/src/computer/tasks.rs) 在同一空间内按 Bot 保留整个电脑任务的租约：从首次观察或执行到 Pi 任务结束并确认操作清理，跨聊天的同 Bot 任务排队，不同 Bot 独立。仅查看状态不取得租约。子委派遇到已占用的 Bot 直接报告忙碌，避免委派链互相等待。网页断开不释放后台任务的租约；取消和异常清理无法确认时，阻止这个 Bot 的后续电脑任务。

浏览器引擎使用同空间的单个持久 BrowserContext 和每屏独立 Page 集合，cookies 可以在同空间共享；弹窗按 opener 继承所属画面，未知归属页面不会替换其他 Bot 的页面。关闭一屏只关闭其页面。真实 Chrome 测试已验证页面、弹窗归属、共享 cookies 及延迟启动清理。这不等同于多个 Linux 窗口浏览器共享登录：当前没有 headed Chromium，后续不能让两个 Chrome 进程共用一个 user-data-dir。

浏览器、模型与普通 API 请求都不能选择 PID、DISPLAY、程序路径或 manifest。[Linux 桌面适配器](../server/workers/computer-runtime/linux-desktop.ts) 适配器调用固定 helper，并锁定首次验证的会话身份与分辨率。只有可用、授权且含有效身份的虚拟桌面才公布 `virtual-desktop-v1` 能力。默认仍为浏览器界面，空间拥有者明确切换后才接受桌面输入。

控制器把会话 ID 和 generation 一起绑定到连接、待批准操作及服务端请求。Worker 在排队执行时再核对；换代后的旧动作和旧接管不能落到新画面。退出桌面和结束接管的清理请求仍允许执行。个人与团队拥有者可以开启已验证的远程虚拟桌面；新注册空间仍不能控制平台本机整机桌面，普通成员不能修改电脑连接或界面配置。

## 手动释放与故障恢复

在已有画面池、`OPENBOT_LINUX_DESKTOP_PYTHON` 和 `OPENBOT_LINUX_DESKTOP_HELPER` 配置之外，Worker 同时配置以下两项才启用 `screen-lifecycle-v1`：

```sh
OPENBOT_WORKER_SCREEN_LIFECYCLE_STATE_DIR=/opt/openbot/desktop/worker-lifecycle
OPENBOT_WORKER_SCREEN_LIFECYCLE_HELPER=/opt/openbot/desktop-session.py
```

上述路径为部署示例。记录目录必须属于 Worker 服务用户、权限 0700，记录文件为 0600；当前 root Worker 部署应由 root 持有。固定 helper 为本仓库生成的 `.build/python-tools/desktop-session.py` 单文件产物（不是 `scripts/desktop-session.py` 开发入口），必须由 root 持有，不得为符号链接或可被普通用户改写的文件，其祖先目录也须可信。它通过 `OPENBOT_LINUX_DESKTOP_PYTHON` 以固定 `--lifecycle` 参数调用，读取受控 `/opt/openbot/desktop/config.json`；请求不能指定路径、PID 或 DISPLAY。一旦设置任一生命周期变量，两项变量、`OPENBOT_WORKER_SCREENS_CONFIG` 与 Python 配置必须齐全，否则拒绝启动；两项都未设置则不提供画面生命周期能力。保留原画面池配置与持久记录，不通过删记录来重置状态。

空间拥有者可在 Bot 电脑面板明确确认“释放画面”；故障或清理未知时按服务端允许状态选择“恢复画面”。操作关闭该 Bot 的浏览器页面和远程应用，未保存内容会丢失。共享 workspace 和同空间浏览器登录保留。释放会停止旧会话，为原逻辑槽位准备不同 session ID 的新会话，成功后移除 Bot 绑定，名额可给另一位 Bot；旧 home 不删除，也不迁移给新会话。重置保留 Bot 及 session ID，生成新 generation 和绑定 revision；它保留 home 目录，不承诺个人文件或应用状态自动恢复。当前固定两个槽，不自动扩容或回收；只能在释放成功、无未完成操作后另行删除 Bot。

运行任务、等待队列、待批准操作和人工接管未结束时拒绝新维护。维护取得任务预留，阻止新任务穿过切换；机器连接变更也要核对所有画面。普通释放不能用于清理未知的画面，正常空闲画面不提供故障重置。维护期间不借用另一张画面。

聊天服务先持久化确定的事务，再调用 Worker。Worker 为每槽保存原 revision、原 session、目标身份与完成回执；监督器先确认旧会话及后代退出，再启动指定替代会话。中途失败保留绑定、容量占用和原事务，不能仅凭网络断开宣称已释放。重启读取记录，GET 只报告状态；拥有者必须明确“继续处理”，使用同一 `operationId` 与 `assignmentRevision`。旧 revision 不能生成新事务或向替代画面输入；已完成请求重复到达只返回已保存的结果，不重放维护。

释放成功返回未分配状态。重置以新绑定 revision、无待处理 operation 和生命周期 `ready` 确认提交；新画面暂不可连接时仍禁用截图/输入，提示检查连接，不要求重复重置。应用路由与请求体见 [电脑说明](computer.md#释放恢复与继续处理画面)。

实际 VM 验证了画面释放后丢回执、重启协调器并继续原事务、槽位复用与画面重置。验收核对原工作文件、旧 home、另一屏会话及共享浏览器资料保留。受控 HTTP 测试覆盖一屏持续维护时另一屏可用。产品界面验收独立记录。

## 执行边界

每个虚拟桌面拥有独立的 mount、PID、network、IPC namespace、X11 socket、Xauthority 和 home，桌面应用以 UID/GID 65532 运行，清空额外组和 capabilities，设置 no-new-privileges。命名空间内的系统根与运行库只读，只有工作区、会话 home 与有限临时目录可写。Worker 控制目录、凭据和宿主进程不在应用可见范围。X11 禁止 TCP，网络 namespace 中没有外部网络连接；仅改变 DISPLAY 并不构成这些隔离。

同一电脑的桌面会话共享 workspace，这是预期的文件交接范围。它们不是租户安全边界；不同用户或团队的执行电脑仍需独立分配。已有双屏 VM 证据覆盖同一空间中两个真实 Xvfb 会话的并行操作，不证明两个租户可以共用执行环境。

每个会话的 cgroup 限制为 384 MiB 内存、64 个进程、一个 CPU 的额度、禁止交换；父级内存上限 768 MiB，最多两个会话。临时目录为 64 MiB，单文件写入上限 64 MiB。启动要求至少 128 MiB 空余和 1024 个空闲 inode；运行中每 100 ms 检查，低于 96 MiB 或 1024 inode 时停止当前会话并保留用户文件。这是低水位保护，不是磁盘总配额，也不能保证突发写入不会短暂超过阈值。

## 输入、截图与取消

外部 helper 先检查 root 所有且私有的配置、manifest、helper 摘要、系统启动 ID、进程 startTime、cgroup 成员、namespace 和 X11 socket 身份，固定 namespace 与根目录句柄后再进入。实际图像与输入工具在降权后运行，不能继承控制凭据或宿主目录句柄。PVM 可能将 cgroup 子树挂载为根，因此成员核验读取可信 `cgroup.procs`，不猜测 `/proc` 中的内部前缀。

输入采用固定工具及参数映射；文字通过标准输入传给 helper，不拼接 shell 命令。虚拟桌面的“粘贴文本”使用同会话内的临时 X11 selection 和固定 Shift+Insert，等待应用请求 UTF-8 内容后才确认交付，结束时撤销临时 selection owner。它会替换远程临时剪贴板，不读取或恢复已有剪贴板，也不读取本机剪贴板。单次最多 300 个 UTF-16 单位，长内容使用文件上传。按键使用白名单，重复修饰键、不完整 Unicode 和超长文字在调用 helper 前拒绝。输入必须基于同会话、同尺寸的有效截图；截图本身不会释放按键或产生输入。

每项输入结束或取消时检查并释放按键和鼠标，再回报结果。取消传播到 helper，操作队列等待进程退出与清理确认。超时或异常无法确认清理时停用当前适配器与连接，不自动继续。支持上述生命周期的画面应通过明确“恢复画面”及必要的“继续处理”完成清理与换代，不能直接释放未知状态。旧 Worker 或未配置生命周期的部署仍需运维先停止并重建桌面会话，再重启 Worker 和重新连接。新的进程仍检查是否残留按住的键；适配器本身的进程内停用与生命周期的持久事务记录是两层不同机制。

Worker 的 `operation-cleanup-v1` 通过 `X-OpenBot-Operation-Id` 跟踪截图、普通执行、动作留图、人工输入与文件传输。`POST /operations/cancel` 等待实际操作退出后才确认；先到的取消会留下记录，迟到执行与重复执行不能重放。每屏独立记录，未知清理会停用该屏，不能仅移除能力标签后继续执行。控制器成功响应与失败退出均核对清理回执；HTTP 中断、已收到动作结果或可选截图失败，都不能单独证明后台执行已经结束。远程 shell 继续使用独立 `/shell/cancel`，两类清理都参与任务租约的 `drainRun`。

当前画面池执行合同见 [Worker 测试](../server/workers/computer-runtime/tests/computer-screen-pool.test.ts)，Rust 绑定与维护合同见[生命周期测试](../server/api/tests/computer_lifecycle.rs)及[恢复测试](../server/api/tests/computer_recovery.rs)。共享浏览器检查见[浏览器引擎测试](../server/workers/computer-runtime/tests/browser-engine.test.ts)。通过 `npm run test:runtime`、`npm run backend:test` 运行当前合同，实际 Chrome 检查使用 `npm run test:browser`；这里不把历史 VM 数字当作本次全量结果。两套真实 Xvfb 的并行操作另由上述 VM 证据验证；本地及 VM 检查均不代表产品网页视觉验收。

截图和输入结果仅用于现有画面与操作历史。执行引擎的真实 Xvfb 截图不能证明 MosoCrew 产品页面已通过浏览器或手机客户端视觉验收。

## 持续应用下的文件访问

桌面程序可以持续运行，因此不能把“检查路径后再按字符串打开”作为文件边界。Linux 文件读写和目录枚举逐层固定目录句柄，拒绝符号链接、硬链接和特殊文件；后续操作都相对已固定的目录进行。上传独占创建，不覆盖同名文件；明确批准的文本写入保留覆盖普通文件的能力，取消不代表撤销已写入的部分。

只有新创建的文件和目录会通过句柄交给工作区的专用 UID，避免上传完成却无法在桌面读取。真实 Linux 并发目录替换、工作区外合成文件保护及专用 UID 读取见 [文件边界证据](evidence/linux-desktop-file-boundary.json)。macOS 的兼容路径检查不提供同等的 Linux 文件句柄或操作系统隔离保证。
