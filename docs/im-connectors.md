# 企业消息渠道

飞书、钉钉、企业微信使用各自官方的消息协议，并不属于 MCP 服务。MCP 用于工具发现和调用；A2A 用于代理间任务通信；Agent Skills 是技能包格式。当前独立消息适配器通过原有 Rust 会话 API 提交消息，结果只回复原消息的渠道和目标。

## 当前能力

| 渠道 | 收消息 | 回复 | 官方依赖 | 验收范围 |
| --- | --- | --- | --- | --- |
| 飞书 | 应用长连接 `im.message.receive_v1` | 原消息回复，保留话题 | `@larksuiteoapi/node-sdk` 1.73.0，MIT | 协议 fixture、SDK 构造/释放 |
| 钉钉 | 企业应用 Stream 机器人 | 事件自带有效 `sessionWebhook` | `dingtalk-stream` 2.1.7-beta.1，MIT | 协议 fixture、SDK 构造/释放 |
| 企业微信 | 智能机器人长连接 `message.text` | 透传原 `req_id` 的流式终结回复 | `@wecom/aibot-node-sdk` 1.0.7，包声明 MIT | 协议 fixture、SDK 构造/释放 |

钉钉固定使用包含重连取消修复的官方预发布版本 `2.1.7-beta.1`；升级需重新运行协议和生命周期检查。依赖树以 MIT 为主，另含 BSD-3-Clause 与 Apache-2.0 组件，许可证保留在独立安装包中。

这是**需要配置的开发者接入入口**，不是默认已连接的企业账号。需要自行创建有权限的企业机器人、填写凭据并绑定发送者。当前支持文本问答；长回复按平台限制截断并以省略号标记，完整结果保留在 BambooShift 原会话；未接入扫码、附件、跨平台卡片审批或主动广播。运行包单独安装，不进入桌面客户端，也不会自动启动外连。

## 开始接入

1. 在企业平台创建机器人并启用上表的长连接消息能力。飞书还需要机器人 `open_id`；不要填应用 App ID 代替。选择允许发送消息的具体员工和聊天，不使用 `*` 白名单。
2. 在 BambooShift 为每个「渠道账号 + 员工 + 聊天 + 话题」建立专用 Bot 单聊；不同来源不共享会话。可以为专用 Bot 安装所需技能。选择拥有该会话访问权的 BambooShift 用户，显式提供其有效登录会话。连接器不读取桌面启动令牌，不自行提升成空间拥有者。
3. 使用 Node.js 24，在仓库根目录安装独立官方依赖：

   ```sh
   npm ci --ignore-scripts --prefix server/workers/im-runtime
   ```

4. 把配置保存到仓库之外、仅当前用户可读的 `im.json`。macOS/Linux 文件权限设为 `0600`，所在私有目录为 `0700`；Windows 使用当前用户的私有目录并限制 ACL。配置只记录环境变量名，密钥和登录 Cookie 通过进程环境提供，不写入配置或 Git。

   ```json
   {
     "version": 1,
     "origin": "http://127.0.0.1:3000",
     "accounts": [{
       "id": "feishu-operations",
       "provider": "feishu",
       "clientId": "application-id",
       "botId": "bot-open-id",
       "secretEnv": "FEISHU_APP_SECRET",
       "bindings": [{
         "senderId": "employee-open-id",
         "chatId": "chat-id",
         "threadId": "",
         "allowGroup": false,
         "workspaceId": "workspace-id",
         "userId": "bambooshift-user-id",
         "conversationId": "dedicated-conversation-id",
         "agentId": "bot-id",
         "sessionEnv": "BAMBOOSHIFT_CHANNEL_SESSION"
       }]
     }]
   }
   ```

   `BAMBOOSHIFT_CHANNEL_SESSION` 是该用户的完整 Cookie 名值对，不是账户密码、模型 Key 或桌面 bootstrap token。会话过期或撤销后，停止派发和回传；重新登录并更新环境变量后重启适配器。

   钉钉使用 `provider: "dingtalk"`，`clientId` 填 AppKey，`secretEnv` 指向 AppSecret；`senderId` 为员工 `senderStaffId`，`chatId` 为 `conversationId`。企业微信使用 `provider: "wecom"`，`clientId` 填 Bot ID，`secretEnv` 指向 Secret；私聊的 `senderId` 和 `chatId` 都填写员工 userid。群聊必须额外设置 `allowGroup: true`、指定群 ID，并满足平台的 @机器人要求。飞书话题必须逐个绑定 `threadId`；不把未知话题合并进主聊天。

5. 先离线检查，再显式启动：

   ```sh
   node server/workers/im-runtime/cli.mjs --check --config /private/im.json
   node server/workers/im-runtime/cli.mjs --config /private/im.json
   ```

   CLI 仅报告账号别名与状态，不打印消息、SDK 异常对象、Cookie 或凭据。`started` 表示 SDK 启动已调用，不代表账号已完成真实业务验收。完成企业账号测试后，应逐项检查身份、双向文本、原话题、撤销、重复事件和断线恢复。

## 权限、去重和停止

发送前和回传前都验证绑定用户的当前登录会话与空间成员资格；Rust 服务继续执行原有 Bot、技能、电脑和应用权限检查。外部员工只获得显式绑定用户的权限，不能通过消息替换账号、空间、Bot 或会话。不要把不受信任的员工映射到有完整本机权限的用户。需要审批的动作仍在 BambooShift 原聊天处理，IM 文本「批准」不会获得审批能力。

已接收事件先写入私有 SQLite 去重记录，再提交原 Rust 消息接口；使用稳定 `clientId`，进程重启后也不会重复派活。同一绑定串行处理，最多排入四条消息，全进程最多接收三十二条未完成消息；超过容量报告 `capacity-reached`，请等待当前任务完成再发送。完成、取消以及结果不明的键保留，达到十万条后停止新接收并要求维护，避免内存无限增长。SDK 重连和重投不能重复执行已登记事件。

按 Ctrl+C 停止入站和尚未开始的回传。已发送的外部消息不能收回；已经提交给 Rust 的任务仍在原聊天可查看和停止。连接器不会仅凭会话 ID 自动取消任务，以免停止用户后来启动的工作。网络结果不明时不盲目重试发送，可在原会话确认结果。

## 开源参考与验证

已读取 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 的 `src/channels/wecom/wecom-runtime.mjs`、`wecom-bridge.mjs`、`dingtalk/dingtalk-runtime.mjs`、`dingtalk-bridge.mjs` 和飞书消息处理源码。参考其「官方长连接 → 账号隔离 → 显式准入 → 持久会话 → 原渠道回复」设计，直接复用官方 SDK，不复制其 DSH 专有 Host/Client 注入层。该项目为 MIT；其第三方组件仍各有许可证。[上游许可与依赖说明](https://github.com/xmanrui/dsh-im/blob/main/THIRD_PARTY_NOTICES.md)

另外核对了 [shaobeichen/dsh-im-bridge](https://github.com/shaobeichen/dsh-im-bridge)（MIT，钉钉仍为规划项）和 [liushutan/dsh-im-connect](https://github.com/liushutan/dsh-im-connect)（Apache-2.0），没有将它们未完成的功能标成当前产品能力。

官方协议与实现：[飞书 Node SDK](https://github.com/larksuite/node-sdk)、[钉钉 Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)、[企业微信 AI Bot SDK](https://github.com/WecomTeam/aibot-node-sdk)。SDK 单独从 npm 安装；企微该版本发布包声明 MIT，但未附 LICENSE 正文，因此当前不把其源码或产物内嵌再分发到桌面包。

```sh
node --test server/workers/im-runtime/*.test.mjs
```

测试覆盖三家事件 → 显式身份绑定 → BambooShift HTTP 协议 → 原目标回复，并覆盖跨用户/群/话题拒绝、持久去重、取消、撤销与凭据不进入诊断。测试使用合成账号和 HTTP/SDK fixture，不发送真实企业消息，不代表企业账号联调已经通过。
