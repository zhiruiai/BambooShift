# 账户、团队与多设备使用

PandaMate 使用产品账户登录。个人注册创建个人空间；团队注册同时创建个人空间和团队空间。同一人在网页、Electron 或 Flutter 客户端登录同一账户后，可访问自己所属的空间。团队成员各自使用账户，不共享密码或设备配对码。

本机产品入口也需要登录。产品站点使用 `/login`、`/register` 和 `/account`；运营站点独立提供 `/admin/login`、`/admin/setup` 与 `/admin`。开发默认页面端口分别为 5173、5174，API 端口分别为 3001、3002；这些是本机示例，不代表已完成公网部署。具体边界见[独立运营平台](operations-console.md)。

## 首次运营初始化与原有数据

普通启动不会生成或替换运营初始化码。维护人员明确以 `--init-operator` 启动 Rust 服务时，才在私有 `dataDir/platform/operator-setup-code` 创建一次性初始化码文件，权限为 `0600`。在运营站点 `/admin/setup` 使用该码完成初始化；码不会出现在公开 API 或正常日志，成功使用后失效并删除。真实代码、账户信息和部署路径只应保存在私有配置或运行目录中。

普通注册只创建普通账户及其空间，不授予运营身份。旧版 `openbot.sqlite` 可以按[迁移流程](data-migration.md)保留并登记为原有空间；只有受初始化码保护的初始化流程可认领尚未认领的原有空间。旧数据库、文件、Pi 会话与电脑配置不复制给新注册者，旧设备配对 Cookie 不会获得产品账户权限。

运营初始化只建立运营会话。若管理员也要进入自己的产品空间，仍需在产品站点单独登录。运营身份不允许读取其他人的聊天、文件、模型配置或冒充用户。当前没有邮件验证、忘记密码、SSO 或 passkey 流程。

## 个人、团队与邀请

每个空间具有拥有者；团队受邀成员使用各自账户。产品页面路径为 `/w/:workspaceId`，多个标签页可打开不同空间，不依赖会变动的“当前空间” Cookie。团队空间的会话和工作资料属于团队可见范围；共享 Bot 的私人会话需要加入接收者自己的个人空间，详见[共享 Bot](shared-bots.md)。

空间拥有者管理模型、Bot 全局设置、技能批准、例行计划和电脑连接。团队成员可使用会话、文件、协作与已有电脑，并只批准或停止自己发起的任务；拥有者不能代批其他人的操作。群内名称、成员和分工可以按现有协作权限调整，不等于获得 Bot 全局设置权限。

团队拥有者可以创建一次有效、七天过期的邀请链接，复制后自行分享，也可撤销邀请或移除成员。被邀请者先登录自己的账户，再明确接受邀请。服务不发送邀请邮件；个人空间不支持邀请，团队拥有者不能被移除。成员资格或登录失效后，后续请求与对应实时连接均受权限限制，已经发出的外部操作不能因此视为被撤销。

新空间不会继承宿主模型密钥、原空间 Worker 令牌、浏览器资料或来源 Bot 的电脑。模型配置、电脑连接和共享来源授权分别管理；平台运营会话不绕过空间权限。

## 在另一台设备登录

1. 打开同一服务的 HTTPS 产品地址，或在客户端连接页选择该服务。
2. 使用自己的产品账户登录，选择个人或团队空间。
3. 在 `/account` 的登录设备列表查看当前会话，退出当前设备或撤销自己的其他登录。

产品会话与运营会话分开保存和校验，用途不能互换。默认有效期分别为三十天与十二小时。Cookie 为 HttpOnly、SameSite=Strict；HTTPS 部署增加 Secure 与 `__Host-` 名称。数据库保存令牌哈希，浏览器脚本不能读取 Cookie。

关闭页面或客户端不会停止服务器任务。服务重启可以保留未过期的账户登录，但未完成任务按恢复规则标记中断，不自动重放。电脑重连必须核对原 Worker 实例，失败不会改成本机执行。后台服务和执行电脑需保持在线，页面通知不等于离线推送。

账户设置不依赖当前空间的拥有者权限；空间被停用或尚未选择空间时，仍可管理本人资料、密码和登录设备。修改密码需验证当前密码，成功后撤销本人的产品和运营会话。姓名修改不重写既有消息的历史署名。网络失败不能证明密码未改变，页面会要求重新登录核对，不自动重发。

Electron 按服务来源隔离 Cookie；同一来源内的空间仍由成员权限与明确 API 路径隔离。Flutter 使用相同账户 API，但原生设备安装、密钥链及平台兼容性须分别验证；源码或网页测试不代替这些验收。

## 配置 HTTPS 入口

服务配置使用 owner-only 的私有 JSON，而不是把部署信息写进源码。先按[本机启动说明](../README.md)或[服务部署说明](../server/api/deployment/README.md)建立配置。下面仅为来源配置片段：

```json
{
  "bind": "127.0.0.1:3001",
  "publicOrigin": "https://bot.example.com",
  "operations": {
    "bind": "127.0.0.1:3002",
    "publicOrigin": "https://ops.example.com"
  }
}
```

```sh
npm run build
npm start -- --config /ABSOLUTE/PATH/TO/server.private.json
```

两个域名均为占位值。公开来源必须是没有子路径、查询参数或账号信息的 HTTPS origin。Rust 只监听 loopback；同机 HTTPS 代理分别连接产品和运营监听器，并保留各自公开 Host、支持 SSE。不得把运营 API 挂到产品代理下。

```caddyfile
bot.example.com {
  reverse_proxy 127.0.0.1:3001 {
    header_up Host bot.example.com
    flush_interval -1
  }
}
ops.example.com {
  reverse_proxy 127.0.0.1:3002 {
    header_up Host ops.example.com
    flush_interval -1
  }
}
```

DNS、证书和防火墙需自行配置。服务不信任任意转发 Host 或客户端 IP；登录等入口使用真实 socket 地址及全局限流，同机代理请求可能共享地址限额。来源校验只对合法顶层登录、邀请及分享页面导航提供限定例外，不对跨站 API、iframe 或写请求开放。代理配置参考 [Caddy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## 身份与接口边界

平台身份库位于 `dataDir/platform/identity.sqlite`，新空间位于 `dataDir/spaces/<workspaceId>/`；原有空间可保留旧布局。密码使用带盐 scrypt 哈希，会话和邀请令牌只保存哈希。数据库、凭据文件、浏览器资料和备份均为私有数据；空间权限不是 OS 或 VM 隔离。

| 接口                                                                   | 所属入口与用途             |
| ---------------------------------------------------------------------- | -------------------------- |
| `GET /api/account/session`                                             | 产品：当前账户与所属空间   |
| `POST /api/account/register`、`/login`、`/logout`                      | 产品：账户注册、登录、退出 |
| `GET /api/account/sessions`、`DELETE /api/account/sessions/:id`        | 产品：本人设备会话         |
| `/api/account/workspaces/:id/team`、`/invitations`、`/members/:userId` | 产品：团队与成员管理       |
| `GET /api/invitations/:token`、`POST /api/invitations/:token/accept`   | 产品：读取并明确接受邀请   |
| `/api/workspaces/:workspaceId/*`                                       | 产品：固定空间的业务接口   |
| `/api/platform/session`、`/setup`、`/login`、`/logout`                 | 运营：独立运营会话与初始化 |
| `/api/platform/overview`、`/users`、`/workspaces`                      | 运营：全平台用户和空间管理 |

固定身份请求携带 `X-OpenBot-Expected-User`，服务端与当前认证身份比较，不接受客户端借此切换账户。缺少身份、权限失效、资源不存在或版本冲突会被明确拒绝。产品监听器不提供 `/api/platform`，运营监听器不提供产品账户或空间执行 API。

## 已删除的设备配对入口

旧单空间配对服务、配对 CLI、`PairingScreen` 与 `AuthGate` 实现已删除。公开产品没有旧 `/api/auth/pair`、`/auth/devices` 或无空间 `/api/bootstrap` 入口；不能以旧配对码登录、认领空间或恢复旧本机免登录模式。旧 JSON 验收中如出现这些名称，只是当时的历史记录。

当前契约可通过 [Rust 账户测试](../server/api/tests/accounts.rs)、[成员测试](../server/api/tests/membership.rs)及[独立运营测试](../server/api/tests/operations_http.rs)核对。运行 `npm test` 检查当前源码；最新已执行范围见[验收记录](verification.md)，历史计数不代表新一轮全量验收。
