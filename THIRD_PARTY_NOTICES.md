# 第三人称组件与许可说明（THIRD_PARTY_NOTICES）

本仓库（06 本地图示）**不包含第三方源码或运行时资产**：图形渲染、受限 XML 解析、编辑模型、document store、Host RPC 适配与 client bundle 均为本项目自行实现，Node 运行时只使用标准库（`node:test`、`node:crypto`、`node:fs` 等）。项目本身按 [LICENSE](LICENSE) 的 Apache-2.0 文本发布；该文本取自 SPDX 标准 Apache-2.0，不来自下述候选项目。

以下上游仅作为**调查/机制参考**记录，未合入字节、未 vendor、未执行：

| 上游 | 固定身份 | 声明许可 | 采用情况 |
|---|---|---|---|
| SDK Code Atlas（本机 `H:/VSCODE_READER`） | 自述 v0.8 | MIT（自述，未审计） | 仅调查对照：证据/快照概念；无源码或索引产物进入本仓库 |
| [Archify](https://github.com/tt-a1i/archify/tree/a4065941f12be7967436261d9934784e381d423c) | tree `a4065941f12be7967436261d9934784e381d423c`，v3.2.0 | Apache-2.0（上游声明，包字节未审计） | 只借鉴讲解图布局/可视约束；未下载、未 vendor、未作为执行器 |
| [dsh-drawioedit](https://github.com/zhang-guo-wen/dsh-drawioedit/tree/bfbcf347f26d9158f7f34bbb6ce416e504b74cdd) | tree `bfbcf347f26d9158f7f34bbb6ce416e504b74cdd`，v1.3.0 | Apache-2.0（wrapper 声明；vendor editor 资产未审计） | 仅调查对照：保存版本守卫思路自行实现；未使用其 vendor 编辑器字节 |

运行时的宿主接口（`@deepseek-ai/dsh-client-connection` 等）通过宿主安装提供（peer/runtime 依赖），本仓库只记录其只读审计的接口身份，见 [source-lock.json](source-lock.json)。这些包的源码不复制进本仓库。

## 与 Drawio 上游的关系

设计允许可选的 Drawio 增强。本轮**未采用**该增强：自有受限 SVG 编辑器承担首版可视化编辑，`.drawio` 由本项目受限转换器导出/导入；没有把 drawio 的编辑器资产、字体、图标模板或 wrapper 代码带入交付。若未来启用该增强，必须先补 vendor 版本/许可证/依赖闭包与出口审计，并更新本文件。
