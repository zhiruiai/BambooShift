# Node → Rust 数据迁移与回退

Rust 继续读取原有账户数据库和各空间的 SQLite 数据，不需要导出再注册账号。迁移前必须先备份。Rust 初始化会把模型、应用的内联凭据迁到各空间的 `config/*.private.json`，并中断旧的未完成任务；因此回退时应恢复切换前的完整快照，不能把已迁移的目录直接交给旧 Node 服务。

## 工具与范围

- `scripts/backup-data.py`：备份、校验，或恢复到一个不存在的新目录。SQLite 使用在线备份接口，每张库有独立一致性快照；普通文件不跟随符号链接，目标目录为 `0700`，普通文件为 `0600`，原本需要执行的文件为 `0700`。备份包含用户文件、头像、模型和应用配置、Pi 历史、浏览器资料及现有运行环境。
- `openbot-migration-probe`：仅接受工具明确生成的隔离演练副本，实际运行 `State::open` 和各空间初始化。没有监听端口，不启动定时器，不提交旧任务，不连接模型、应用、远程电脑或语音服务。报告只包含计数和凭据可读性，不包含凭据内容。
- `scripts/migration-audit.py`：比较原表的数量、主键和内容摘要，列出变动字段名；同时核对原文件摘要。报告保存在私有目录。

Python 的 SQLite 库须至少为 3.37，才能读取现代 Chromium 的 STRICT 表。当前演练使用 Python 3.12。源码内的模型、应用和账户测试数据均为合成数据。正式运营初始化码仅原样复制，不解码、不打印、不计算内容摘要；这类不透明文件只检查存在、大小和私有权限。

在线快照不保证不同数据库和文件间处在同一业务时刻。用于正式切换和回退的最终备份，应在停止所有会写入该目录的服务、电脑执行器和浏览器之后创建。`--quiesced` 只记录操作者已完成停写，不会替操作者停止进程。

## 先做隔离演练

下面的目标目录都必须不存在，且必须位于源目录之外。路径仅为示例；备份目录不要放进可公开访问的静态文件目录。

```sh
python3.12 scripts/backup-data.py backup --source data --destination .local/pre-rust-snapshot
python3.12 scripts/backup-data.py verify --source .local/pre-rust-snapshot
python3.12 scripts/backup-data.py restore --source .local/pre-rust-snapshot --destination .local/rust-rehearsal --rehearsal
```

构建独立的 `openbot-migration-probe` 二进制，把实际构建产物路径放入 `OPENBOT_MIGRATION_PROBE`。该命令不启动产品服务，也不读取运营初始化码：

```sh
cargo build --manifest-path server/api/Cargo.toml --locked --bin openbot-migration-probe
"$OPENBOT_MIGRATION_PROBE" --rehearsal-dir .local/rust-rehearsal --report .local/rust-rehearsal-report.json
python3.12 scripts/migration-audit.py --snapshot .local/pre-rust-snapshot --copy .local/rust-rehearsal --report .local/rust-rehearsal-diff.json
```

检查报告中的账户和中央目录是否保留、原正文与文件是否一致、凭据是否可读取，以及变动是否仅属于明确的迁移和恢复。演练副本的备份标记与原快照摘要绑定；原数据目录没有这个标记，工具拒绝对它执行迁移探测。

## 正式切换

1. 停止旧服务和所有数据写入方，保留旧版本的程序及部署配置。
2. 用新的目标目录重新执行 `backup`，这一次传 `--quiesced`，然后执行 `verify`。之前的在线演练快照不能代替这一步。
3. 若部署配置、环境文件或证书在数据目录外，另行备份这些私有文件。`backup-data.py` 可单独备份 `config/private` 目录；数据目录备份不会自动搜集外部环境变量或其它路径。
4. 按已验证的私有部署配置启动 Rust，数据目录仍指向原位置。只启动一个业务服务和一个定时调度器。
5. 核对现有登录、工作空间、模型配置、Bot、资料、头像、应用和分享入口；确认后再恢复写入。旧排队请求、未完成模型运行和旧审批不会自动重放。

新库或缺少的辅助表会按需创建。未初始化且没有工作区数据库的登记空间，在演练报告中单独标出，不会为了演练生成示例内容。原例行计划的配置和下次执行时间保持原值；关闭演练探测器不会触发计划。

## 回退

先停止 Rust 和所有写入方，再把已校验的切换前快照恢复到新目录：

```sh
python3.12 scripts/backup-data.py verify --source .local/final-pre-rust-snapshot
python3.12 scripts/backup-data.py restore --source .local/final-pre-rust-snapshot --destination .local/node-rollback
```

恢复工具不会覆盖现有目录。当前源码已不含旧 Node 业务服务，回退必须使用维护人员另行保留的匹配旧版本程序。将旧部署的数据目录切到恢复目录，或在服务停写时由维护人员完成目录替换，并恢复匹配的私有部署配置。保留 Rust 使用过的目录；回退快照不会包含切换后的新消息或新操作，不能静默丢弃这段新增数据。含绝对外部路径的自定义配置需要按恢复位置检查，不能通过复制目录假定所有外部挂载已经迁移。

失败操作留下的 `.incomplete-*` 目录没有有效完成回执，不能用于恢复。正常备份会显式记录被跳过的链接、特殊文件和 SQLite 临时侧文件；它们不能被当作已备份的外部目标。

## 2026-11-06 历史演练证据

私有正式数据副本已通过离线 Rust 初始化：29 个 SQLite、6,758 个文件；219 个原表保持摘要，原文件未发现变动。唯一预期的业务表变化是旧个人空间 `settings` 从 7 条变为 5 条：两条内联模型密钥记录迁到私有文件，两个模型资料增加 `credentialRef`，实际读取凭据成功。已有 `platform-migration-baseline.json` 的八表数量和原始摘要全部匹配。该次初始化和核对都发生在副本上，当时未对正式目录执行迁移；其后正式切换单独见[切换记录](refactor-validation.md)。另已实际恢复独立 Node 回退目录，29 张库和 6,758 个文件均通过原快照校验。

合成的真实 Node Store 数据覆盖个人与团队、现有会话和密码哈希、运行中与排队消息、例行计划和运行记录、资料文件、头像、应用凭据、模板和共享目录；迁移后恢复旧快照能得到原记录，第二次 Rust 初始化保持幂等。该证据不替代停写后的最终备份和产品验收。
