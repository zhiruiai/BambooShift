# CubeSandbox 独立电脑部署

MosoCrew 可以把已有的 CubeSandbox 实例绑定为一个工作空间的云电脑。Rust 控制端管理会话、审批和实例状态。独立 Worker 在实例中提供浏览器、文件传输，以及部署者启用的 Linux 桌面和隔离命令能力。为不同用户或团队分配各自的执行环境。

## 连接关系

| 组件             | 连接方式                                 | 职责                                   |
| ---------------- | ---------------------------------------- | -------------------------------------- |
| CubeAPI          | 控制端通过部署者提供的 loopback 隧道访问 | 查询实例状态，处理明确的启动或恢复请求 |
| CubeProxy        | 本机桥通过私有隧道访问                   | 按固定实例转发私有 Worker 流量         |
| MosoCrew Worker | 在指定实例内部运行，供本机桥访问         | 独立浏览器、文件、画面和接管           |
| envd             | 部署者按供应商提供的管理通道访问         | 安装、更新及受控维护                   |

产品连接填写 **Worker 桥地址**。CubeAPI 管理入口、实例流量认证和 Worker Bearer 属于不同的信任边界。各地址、端口、工作空间及实例标识、流量凭据和 Worker 凭据均填写在部署者自己的私有配置中。

## 部署步骤

1. 在 CubeSandbox 控制台确认自己获准使用的实例、所选模板、资源容量和暂停策略。按实际系统架构准备 Node 运行时、构建后的 Worker、Playwright 兼容浏览器及必要运行库。通过官方摘要或签名核对下载。
2. 在实例内为 Worker 配置独立工作目录和浏览器资料目录。按需安装并验收 [Linux 桌面](linux-desktop.md) 和 [隔离命令](remote-shell.md)。浏览器与控制端的网络入口分别配置，确保浏览器无法访问管理网络和控制台。
3. 依据部署者自己的实例配置建立私有隧道。使用 [本机服务入口](running-services.md) 检查 SSH 连接、Worker 桥和 Rust API 的运行状态。单独运行桥时使用以下入口，并将配置路径改成自己的私有文件。

   ```sh
   node scripts/run.mjs scripts/cube-worker-bridge.ts --config data/computer/cube-sandbox.json
   ```

4. 在服务端保存电脑连接及工作空间云电脑绑定。云电脑绑定使用 `<spaceDir>/computer/cloud.json`。配置应为服务账户所有、权限 `0600` 的普通文件。桥的 `bridge.listenPort` 和 `bridge.upstreamPort` 在实例的私有配置中填写，并与本机服务入口的相应字段一致。云电脑绑定到同一实例和 Worker，并与供应商实际的 `autoResume: false` 策略一致。保存前验证 Worker 健康、实例身份与控制台来源。
5. 在产品中使用工作空间拥有者身份检查状态和连接。测试公开页面导航、截图和一份合成文件往返。涉及网页操作或命令的任务走正常审批流程。后续维护确认没有进行中的任务或人工接管，并备份工作区与浏览器资料。

桥在合法请求开始时读取新的私有配置快照。实例及路由保持绑定，只有有效的新流量凭据可以热更新。Worker 重启后重新核对实例身份并执行产品重连。供应商响应省略凭据字段时保留已有有效凭据。

在小型云服务器上可先部署一个 [绑定工作空间的独立 Worker](computer.md#独立-worker)。此模式提供持续保存的工作文件和独立浏览器，供空间内的 Bot 顺序使用。安装 Linux 虚拟桌面后，还可以切换到图形应用。只有启用了画面池的部署才为每个 Bot 分配画面。

## 暂停和恢复

云电脑面板查询状态时只读 CubeAPI。启动或恢复由拥有者明确发起，Rust 服务会重新验证固定 Worker、空闲状态和当前权限。新空间可以由部署者另行绑定实例。该工作流和 API 边界见 [工作电脑](computer.md)。

恢复完成后核对实例运行状态、Worker 健康以及工作区文件。如果隧道失效，重新建立并验证原实例路由。容量、备份、宿主机重启及部署监控由部署者负责。一次成功的暂停和恢复只验证该次受控流程。

## 验收范围

历史受控实机验收覆盖独立浏览器、远端文件逐字节往返、动作历史画面、两套会话的独立输入和接管、画面释放与重置，以及 CubeSandbox 的暂停、恢复和 Worker 重新绑定。临时控制器和合成文件用于验证边界，结果与产品 GUI 验收分开记录。可复用的接口和验收方法见 [工作电脑](computer.md)、[Linux 桌面](linux-desktop.md)及[产品验收](verification.md)。

原始部署记录由各部署者存放于本地私有位置。版本库保留接口、部署和验证方法。

## 参考资料

- [官方 SDK 说明](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.3/sdk/node/README.md)
- [Playwright 浏览器安装说明](https://playwright.dev/docs/browsers)
- [官方生命周期说明](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.3/sdk/node/README.md#pause--resume)
- [官方 API 定义](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.3/openapi.yml)
