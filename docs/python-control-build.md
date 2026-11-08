# Python 控制程序构建

电脑控制源码按职责保存在 `scripts/python_tools/`，每份自有源码不超过 500 行。部署仍使用三个独立的完整 Python 文件，不在远程运行时拼接源码、加载仓库模块或改变输入协议。

| 程序 | 源码职责单元 | 固定部署文件示例 |
| --- | --- | --- |
| `desktop-control` | protocol、session、x11、operations、supervision | `/opt/openbot/desktop-control.py` |
| `desktop-session` | foundation、namespace、supervisor、lifecycle | `/opt/openbot/desktop-session.py` |
| `isolated-shell` | foundation、workspace、namespace、execution、maintenance | `/opt/openbot/isolated-shell.py` |

单元在同一程序的全局命名空间中定义：foundation/protocol 提供标准库、固定配置、校验函数及取消状态；后续单元提供相应操作。函数之间仍是普通直接调用，信号处理器仍访问同一个取消状态。单元顺序由 `scripts/python-tools.json` 明确声明，构建器仅连接原始定义，不改写表达式、压缩代码或引入运行时 `exec`。部署文件中的 `__file__` 始终是部署文件本身，命名空间重新进入、单文件摘要、桌面只读映射和现有 `helperSha256` 校验保持原义。

## 构建与部署核对

在仓库根目录执行：

```sh
python3 scripts/python_tool_build.py all
python3 scripts/python_tool_build.py all --verify
```

生成文件位于已忽略的 `.build/python-tools/`。每个程序伴随 `.manifest.json`，记录完整源码相对路径及摘要、生成文件摘要；不记录个人目录、主机信息或凭据。构建前必须与已提交的 `scripts/python-tools.lock.json` 一致；遗漏或额外单元、符号链接、源码摘要变化都会拒绝构建。`--verify` 重新读取并核验全部源码，再比较当前产物和清单，不能用旧产物冒充当前代码。

维护者只复制生成的 `.py` 到既有固定部署位置，并核对构建器输出的 SHA-256 与远端文件摘要。复制后沿用各程序既有的 root 所有权、目录权限、无符号链接、会话身份和验证流程。不要复制 `scripts/desktop-control.py`、`scripts/desktop-session.py` 或 `scripts/isolated-shell.py` 开发入口；这些小入口只用于本地从已验证源码重新构建后执行。

实际源码修改经过审阅后，显式更新锁并重新核验：

```sh
python3 scripts/python_tool_build.py all --update-lock
python3 scripts/python_tool_build.py all --verify
```

这不会安装、停止或重启任何远程程序。控制程序摘要发生变化时，仍需按 [Linux 桌面](linux-desktop.md) 和 [远程代码执行](remote-shell.md) 的既有维护流程处理桌面 manifest 或 shell 验证记录，不能跳过校验。

本次职责拆分的三个生成产物与拆分前源文件逐字节一致。因此原有远程运行文件和已保存的摘要无需因这次纯拆分更换；后续行为修改应重新构建和验收。生成文件是构建产物，不作为超过 500 行的自有源文件提交。

## 本地验证

```sh
python3 scripts/python-tool-build.test.py
python3 scripts/desktop-control.test.py
python3 scripts/desktop-session.test.py
```

原控制与会话测试先构建最新产物，再加载真实程序，保留输入校验、Unicode 交付、截图、取消清理和生命周期断言。构建测试覆盖完整清单、过期源、篡改产物、路径与符号链接，以及开发入口与生成入口一致性。这些检查不启动产品 GUI，也不代替新的 Linux 实机行为验收。
