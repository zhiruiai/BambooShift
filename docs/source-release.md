# 开源源码交付

本版本采用 Apache License 2.0。`LICENSE` 为标准全文，`NOTICE` 记录项目归属，第三方依赖保留自己的许可。准备源码不会自动创建仓库、推送代码或发布安装包。

```sh
npm ci
npm run check:source
npm run check:privacy
npm run build
npm test
npm run source:export -- --out release/source/pandamate-v0.1.0
```

每次选择新的输出目录。导出工具拒绝覆盖旧目录或经过输出符号链接，只复制明确列出的公开根文件和源码目录。`source-manifest.json` 记录每个文件的大小和 SHA-256。发现已知私密值就停止并移除临时目录，报告只包含位置，不回显密钥。

源码检查、隐私扫描和导出工具集中在 `scripts/source/`。导出排除 `data/`、`config/private/`、`.env`、`.local/`、依赖、工具链、构建缓存、移动工具链生成配置和签名文件。文档中的媒体文件按文件名逐项放行。README 的短演示集中在 `docs/demo/`，验收图片留在 `docs/evidence/gui/`。本机截图保存在忽略版本管理的 `docs/screenshots/`。

检查读取本地私密值清单及指定的模型和电脑配置，核对个人邮箱、部署地址、自定义连接端口和凭据。它只报告文件及行号。公开文档使用示例地址，实际部署验收记录和截图保存在忽略版本管理的本机目录。新增图片和文件仍需发布者核对。

Rust 负责业务，Node SDK 和执行适配位于 `server/workers/`。旧 Node 业务服务已删除，迁移与删除明细见[清理记录](evidence/node-retirement-files.json)。自有代码单文件最多 500 行，注释使用英文，界面文字至少 12px，中英翻译的键与占位符一致。

CI 在推送或拉取请求时构建 Rust 与两个网站，并运行后端、网页、执行适配和桌面策略测试。独立移动源码检查固定 [Flutter 3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9) 的提交，检查锁文件、静态分析与原生组件；不会生成或发布移动安装包。该工作流已写入源码，尚未在未指定的 GitHub 仓库实际运行。

确定 GitHub 仓库后，从干净导出目录建立版本历史。正式客户端签名、公证、Release 更新源与移动安装包需要相应发布配置；源码许可不代表这些发行工作已完成。
