# 统一检查和运行本机服务

项目入口 `scripts/computer-services.ts` 提供 `status` 和 `run` 两种模式，使用已有前端构建和生产 API，不启动 Vite。它不安装登录项或系统服务，也不自动创建 SSH 连接、保存密码、启动虚拟电脑或延长其期限。

```sh
node scripts/run.mjs scripts/computer-services.ts status --config data/computer/services.json
node scripts/run.mjs scripts/computer-services.ts run --config data/computer/services.json
```

`status` 只检查，不启动或停止任何进程；输出分开的 API、连接桥、SSH 隧道、云实例和 Worker 状态。成功可用退出 0，状态未就绪退出 2，配置或系统检查失败退出 1。云实例已暂停属于可诊断的正常状态：只查 CubeAPI，不访问可能触发唤醒的数据通道。进入产品后，由拥有者明确点击启动或恢复。

`run` 在前台持有本次启动的服务。它先确认外部 SSH 隧道和指定实例身份，再补齐缺失的连接桥与 Rust 主 API，等待真实就绪。API 启动与 `start-backend.mjs` 共用受控启动逻辑，监督器直接持有真实 Rust 进程；退出时发送信号并等待该进程结束，不会只结束外层 Node 启动器。相符的现有服务只借用，不替换；错误服务占用端口会导致失败退出。按 Ctrl+C 只结束统一入口及它自己启动的子进程，借用的主服务、桥、SSH 连接和远程 VM 保持运行。关闭这个前台进程后，它启动的服务不会继续运行；需要持续使用时保留终端窗口。本版没有后台守护或自动登录启动功能。

运行中网络中断会显示未就绪状态，聊天服务保留运行；不会把任务改派到本机，也不会自动重放动作。用户在自己的终端恢复原有 SSH 隧道后，入口下一次检查会重新核验固定实例和 Worker 绑定。真正的产品电脑重连仍走拥有者操作，检测到新 Worker 实例时不会自动信任它。若本次启动的 API 或桥意外退出，入口失败并清理其余本次子进程；借用的服务不受影响。

## 私有配置

配置使用当前用户所有、权限 `0600` 的普通 JSON 文件。路径为绝对路径。以下主机、用户、端口及路径均为示例，保存前替换成自己的部署参数。

```json
{
  "version": 1,
  "dataDir": "/path/to/pandamate/data",
  "serverConfigPath": "/path/to/pandamate/config/private/server.private.json",
  "cubeConfigPath": "/path/to/pandamate/data/computer/cube-sandbox.json",
  "connectionPath": "/path/to/pandamate/data/computer/connection.json",
  "ssh": {
    "host": "cube-host.example.com",
    "user": "deploy",
    "port": 22,
    "controlPath": "/path/to/private/cube-ssh.sock",
    "knownHostsPath": "/path/to/private/cube-known-hosts"
  },
  "ports": {
    "api": 43111,
    "cubeApi": 43112,
    "cubeProxy": 43113,
    "bridge": 43114,
    "cubeApiTarget": 43115
  }
}
```

`knownHostsPath` 可省略。该路径只用于生成重新连接指引，工具不会修改它。使用现有 SSH 账户的普通权限运行。

`serverConfigPath` 可省略。入口会依次使用 `OPENBOT_SERVER_CONFIG` 或已忽略的 `config/private/server.private.json`。启动 API 前核对私有文件归属和权限，`dataDir` 必须指向同一实际目录，`bind` 必须为 `127.0.0.1:<ports.api>`。

`cubeConfigPath` 指向同一实例的私有记录，其中的 `bridge.listenPort` 和 `bridge.upstreamPort` 分别对应 `ports.bridge` 和 `ports.cubeProxy`。`connectionPath` 指向保存的 Worker 连接。旁边的 `cloud.json` 绑定同一实例及对应的 CubeAPI、Worker loopback 地址，并声明与供应商实际设置一致的 `autoResume: false`。这些文件由部署者单独保存。

| 字段                  | 用途                        | 检查                                      |
| --------------------- | --------------------------- | ----------------------------------------- |
| `ports.api`           | 本机产品 API 与构建后的网页 | 进程、数据库目录和 Rust 健康响应          |
| `ports.cubeApi`       | 本机转发至 CubeAPI          | SSH master 进程归属及固定实例查询         |
| `ports.cubeProxy`     | 本机转发至 CubeProxy        | SSH master 进程归属                       |
| `ports.bridge`        | 本机固定实例 Worker 桥      | 桥启动配置、Worker 认证、实例和控制台绑定 |
| `ports.cubeApiTarget` | SSH 远端的 CubeAPI 目标端口 | 由部署者按供应商配置填写                  |

前四个端口是不同的本机 loopback 监听端口。CLI 会在网络请求或启动子进程前核对互相引用的地址和端口。

本版以 macOS 的 `lsof`、`ps`、OpenSSH 做只读进程归属检查；没有这些工具或无法确认归属时拒绝借用，不能把“检查失败”当成空闲端口。Linux 路径预留，但尚未实际验收；Windows 暂不支持。旧 Node API 即使返回平台健康响应，也会被标为端口冲突；本工具不会停止该进程或把它当作当前 Rust 服务。首次需要启动 API 时，先运行 `npm run configure:local` 创建私有服务配置（已有配置不覆盖），再运行 `npm run build`。不会自动安装依赖或构建产物。

## SSH 认证与恢复边界

本版不创建隧道。缺少现有连接时，会非零退出并根据私有配置显示一条原生 `ssh` 命令，由用户在自己的终端运行。密码或密钥口令只进入系统 SSH 的原生提示，不进入 PandaMate 参数、环境变量或文件；也不会自动接受新的主机密钥、改写 `authorized_keys` 或修改已有 SSH 配置。

已有 SSH master 存活只说明当前隧道可用。中断后使用部署者自己的 SSH 账户、认证方式和主机密钥记录重新连接。

云实例已运行但 Worker 不响应时显示不可用，不自动在远端重新安装、重建或执行维护命令。远端工作区、模板、宿主部署以及实例期限均不由此入口修改。暂停、恢复和连接验收方法见 [CubeSandbox 部署说明](cubesandbox.md)。

## 2026-11-06 定向验收记录

2026-11-06，Rust 启动合同 6 项与服务检查 7 项共 13 项通过，TypeScript 与格式检查通过。测试使用临时配置、随机本机端口和合成进程，验证默认或显式配置的参数透传、`--init-operator`、开发代理跟随真实 Rust 监听地址、取消构建不启动服务、退出等待实际写入进程、私有配置不匹配时零启动、旧 Node 健康响应拒绝以及原有借用进程保护。开发模式不再从另一份默认配置猜 API 端口。没有在此轮定向测试中停止正式服务、操作 VM 或执行真实业务任务。这是历史专项结果，不代表当前源码全量回归；本工具不单独探测运营监听器，独立运营部署见[运营平台说明](operations-console.md)。

2026-11-05，6 组独立回归和定向类型检查通过：固定配置与参数拒绝、纯 GET 查询与暂停时不探测 Worker、借用进程不清理、隧道缺失与端口冲突拒绝、仅启动缺失子进程及取消后等待退出、子进程异常后的限定清理。测试的网络请求使用随机本机端口，子进程为临时测试程序，没有占用正式端口。

同日对现有服务运行真实 `status`，再执行完全借用的 `run` 并按 Ctrl+C 退出。前后 API PID 18990、桥 PID 10087、SSH master PID 36016 保持一致，Worker 健康检查通过，实例截止时间仍为 `2026-11-04T19:00:26.311Z`。没有停止现有服务，也没有创建 SSH 登录或发送生命周期写请求。这个验收证明当前借用路径可用，不代表已经验收无人值守认证、主机重启或断网后的自动重连。
