# Linux 桌面中的受管浏览器

本轮增加可选的联网有头 Chrome 启动链。源码与本机测试覆盖两套独立 Chrome 的页面归属、登录同步、取消和清理记录；Linux namespace、Chrome 沙箱和现有远端资源预算仍需指定实例验收。当前远端尚未部署这套新启动链，不能据此宣布远端联网桌面已经可用。

## 启用条件

服务配置 `OPENBOT_LINUX_BROWSER_LAUNCHER=/opt/openbot/desktop-browser.py` 后，Worker 必须同时有固定画面池与 `OPENBOT_LINUX_DESKTOP_PYTHON`。不从 HTTP、模型或页面接受运行器、Chrome 路径、启动参数、代理端口或 profile 路径。Python 路径须为 root 拥有且不可由普通用户修改的实际文件，不接受符号链接。

部署者使用 `python3 scripts/python_tool_build.py all` 构建完整程序，并核验生成记录，不能只复制定义片段。本轮 `desktop-control` 和 `desktop-session` 程序也有变更，需要更新可信 helper 哈希并通过原画面维护流程处理旧 session。不能在运行中的画面上直接覆盖 helper 后宣称原身份绑定仍有效。

固定 `/opt/openbot/desktop/browser.json` 为 root:root、0600，所在控制目录为 root 私有目录：

```json
{
  "version": 1,
  "workspaceScopeId": "与当前画面池相同的 UUID",
  "executable": "/desktop/opt/chrome/chrome",
  "network": "browser-proxy-only"
}
```

`/opt/openbot/desktop/browser-leases` 为 root:root、0700。完整 Chromium 及动态依赖须安装在现有只读 desktop runtime 的 `opt/chrome` 下；headless shell 不能代替有头 Chrome。启动检查验证固定 ELF 文件、真实 X11 会话、PID/start-time、namespace、manifest generation 和 socket 身份。检查状态不会启动 Chrome。实际启动失败或清理结果不明时停止继续使用画面，不降级为无沙箱 Chrome。

## 隔离与清理

- 每个 Bot 画面拥有独立 Chrome 进程、profile 和 CDP pipe。原来最多两屏的限制保持，默认机器路径不会额外启动第三个受管浏览器。
- Chrome 加入对应桌面的 mount、IPC 和 PID namespace，但使用另一个只有 loopback 的 network namespace。原桌面终端仍在原离线网络中。
- root 转发器保留浏览器 namespace 的监听 socket，回到主机 namespace 后只连接固定的本机 Worker 代理端口。出口继续经过现有公共 HTTP(S)、固定 DNS 解析和私网/控制平面阻断规则；Chrome 没有直接网卡或 DNS 出口。
- Chrome 使用 UID/GID 65532，清空附加组和 capability、启用 `no_new_privs`，只保留 CDP pipe 并关闭其余控制 FD。没有 `--no-sandbox` 回退，没有 TCP 调试端口。
- 用户明确切换至桌面，或原批准的浏览器操作，才会启动 Chrome。人工接管、画面 generation、操作审批与取消沿用原 Worker 管线。

启动前先持久保存随机 lease。Worker 意外退出后，包装进程由 parent-death signal 退出；独立 supervisor 通过 pidfd 发现退出，停止并等待 browser cgroup 的全部进程，才写 root 私有清理回执。重启和生命周期恢复必须核对旧回执，不能根据 HTTP 结束或 launcher 退出猜测浏览器已停止。桌面 reset 与浏览器 supervisor 同时清理空子 cgroup 时允许幂等移除，但仍等待实际子进程退出。

## 同空间登录

只在同一 Worker workspace scope 内同步普通 HTTP(S) cookies 和 localStorage，私有文件为 0600、目录 0700。各屏 profile 独立；页面、标签、电脑 lease、下载和调试句柄不共享。其他工作空间、共享 Bot 的来源空间或其他人的浏览器 profile 不会参与。

新页面的 localStorage 桥只根据真实调用 frame 的 origin 返回该站点数据，不接受页面自报其他 origin。同步处理删除/退出；页面在快照读取后新做的 localStorage 修改不会被旧值覆盖。原生新标签只归属于专用浏览器绑定的那个画面。

partitioned cookies、IndexedDB、sessionStorage、密码管理器、passkeys 和扩展不在共享范围内，依赖它们的站点可能需要各屏分别登录。同步存在短暂延迟，不是多个 Chrome 共用一个正在打开的 profile。自动下载等原有浏览器限制继续生效。

## 实际验证范围

本机两个真实临时 headless Chrome 进程验证了登录/退出、原生新标签、origin 隔离及关一屏不影响另一屏。启动器使用受控替身，所以它不证明 Linux 内核隔离或有头显示可用。Python 测试验证固定协议、只读探测、namespace 调用顺序、parent-death 清理回执和真实本机 TCP 有界转发，也不替代 Linux 实机验证。

桌面总内存仍严格为 768 MiB、每屏 384 MiB、每屏 64 个进程，本轮没有提高预算。部署前必须实测完整 Chrome 依赖、user namespace 沙箱、cgroup v2 kill 与两屏资源用量；不足时先报告，不自动扩大预算或另建实例。实际远端依赖与可用资源尚未验证。

唯一绑定实例的只读 API 查询返回 paused、配置 2 CPU / 2000 MB；这不是实例内部可用内存的测量。随后恢复实例并执行检查的请求被自动审批拒绝，未执行远端恢复、命令、安装或暂停操作，不能把准备好的检查脚本记为完成的实机测试。
