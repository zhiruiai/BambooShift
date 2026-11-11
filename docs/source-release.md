# 开源源码交付

MosoCrew 自有源码采用 MIT 许可证。`LICENSE` 为标准全文，`NOTICE` 记录项目归属，第三方依赖保留自己的许可。准备源码不会自动创建仓库、推送代码或发布安装包。

```sh
npm ci
npm run check:source
npm run check:privacy
npm run build
npm test
npm run source:export -- --out release/source/pandamate-v0.0.1
```

每次选择新的输出目录。导出工具拒绝覆盖旧目录或经过输出符号链接，只复制明确列出的公开根文件和源码目录。`source-manifest.json` 记录每个文件的大小和 SHA-256。发现已知私密值就停止并移除临时目录，报告只包含位置，不回显密钥。

源码检查、隐私扫描和导出工具集中在 `scripts/source/`。导出排除 `data/`、`config/private/`、`.env`、`.local/`、依赖、工具链、构建缓存、移动工具链生成配置和签名文件。文档中的媒体文件按文件名逐项放行。README 的短演示集中在 `docs/demo/`，验收图片留在 `docs/evidence/gui/`。本机截图保存在忽略版本管理的 `docs/screenshots/`。

检查读取本地私密值清单及指定的模型和电脑配置，核对个人邮箱、部署地址、自定义连接端口和凭据。它只报告文件及行号。公开文档使用示例地址，实际部署验收记录和截图保存在忽略版本管理的本机目录。新增图片和文件仍需发布者核对。

Rust 负责业务，Node SDK 和执行适配位于 `server/workers/`。旧 Node 业务服务已删除，迁移与删除明细见[清理记录](evidence/node-retirement-files.json)。自有代码单文件最多 500 行，注释使用英文，界面文字至少 12px，中英翻译的键与占位符一致。

CI 在推送或拉取请求时构建 Rust 与两个网站，并运行后端、网页、执行适配和桌面策略测试。独立移动源码检查固定 [Flutter 3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9) 的提交，检查锁文件、静态分析与原生组件；不会生成或发布移动安装包。

## GitHub 自动发布

[发布工作流](../.github/workflows/release.yml) 在 GitHub Actions 运行。每天北京时间 **09:17** 从默认分支启动构建，**11:43** 再检查一次。当天已经发布时，第二次运行会在构建前结束。第一次未触发或失败时，第二次运行会补建。GitHub 可能延迟或丢弃定时事件。可在 **Actions → MosoCrew Release** 查看实际触发时间和发布结果，也可选择 **Run workflow** 手动补跑。

版本从 `v0.0.1` 开始，随后递增补丁号。一次构建成功会生成一个版本，同一北京时间日期的重复运行会跳过已发布版本。发布标签指向本次构建的源码提交。带版本号的源码归档、桌面客户端和 Rust 服务使用同一个版本号。GitHub 自动生成的 Source code 下载项对应原始提交。

[下载最新版本](https://github.com/zhiruiai/PandaMate/releases/latest)。发布页会列出该版本的归档及 `SHA256SUMS.txt`。

- 源码归档包含版本对应的各端源码和导出清单。
- Linux x64 服务归档包含网页、独立运营控制台和执行进程，并经过实际服务启动和调用检查。
- macOS Apple Silicon 客户端归档使用临时签名，未经过 Apple 公证。客户端连接单独部署的服务。
- 支持 Windows 的版本附带 Windows x64 客户端便携 ZIP。归档在 Windows 运行器上构建，启动并验证连接后纳入发布。客户端未签名，连接单独部署的服务。 [Windows 使用说明](desktop-client.md#windows-x64)

构建、隐私检查、产物检查和附件校验通过后，工作流才会发布草稿。Flutter 客户端以源码交付。
