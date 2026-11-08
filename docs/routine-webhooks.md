# 通过 Webhook 触发例行任务

工作空间拥有者可以为本地 Bot 的单人会话设置 Webhook。新建任务时可以选「仅 Webhook」，也可以给已有定时任务加一个触发入口。结果会出现在该任务的原会话，运行历史会标明触发来源。

1. 在例行任务详情中打开「Webhook 触发」，创建密钥并复制投递地址。
2. 将密钥保存在调用系统的密钥配置中。界面只在创建或轮换成功时显示一次。
3. 向该地址发送 `POST`。可以发送空请求，或附带最多 8 KiB 的 JSON 对象。
4. 收到 HTTP `202` 后，在原会话或任务的运行历史查看结果。回执中的 `runId` 对应此次运行，`duplicate` 表示复用了先前的回执。

下面的环境变量由调用者自己配置。发送端和 PandaMate 不在同一台机器时，使用部署者配置的可达 HTTPS 入口。

```sh
curl --request POST "$OPENBOT_WEBHOOK_URL" \
  --header "Authorization: Bearer $OPENBOT_WEBHOOK_KEY" \
  --header 'Idempotency-Key: inventory-event-1842' \
  --header 'Content-Type: application/json' \
  --data '{"reference":"inventory-event-1842","status":"ready"}'
```

- 同一密钥下，24 小时内使用同一个 `Idempotency-Key` 和完全相同的请求正文，会收到原运行回执。相同标识配不同正文会返回 `409`。
- 每个任务在滚动一分钟内最多接受十条新投递。到达上限时返回 `429`，可依据响应中的 `Retry-After` 等待。暂停期间，新投递返回 `409`。撤销、轮换或转交会使原密钥失效。已经接纳的运行仍可在原会话完成。
- Webhook 运行只使用已保存的任务指令、Bot 指令和启用的技能。技能较多时，Bot 可按需读取本次运行捕获的已审核版本。JSON 作为独立的外部输入提供给已配置的模型。原始请求正文和密钥不进入聊天或运行历史，模型生成的结果仍会保存。手动「立即运行」使用独立的工作空间权限。
- Bot 模板只携带可迁移的定时安排。仅 Webhook 任务和接收密钥由原工作空间管理。导入模板后可以为新的 Bot 单独创建事件任务和密钥。

[Grok Bot Webhook 说明](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks)
