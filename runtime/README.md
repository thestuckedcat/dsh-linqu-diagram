# 离线运行时说明

设计文档的命令示例写作 `.\runtime\node.exe`（Linux 为 `./runtime/node`），表示"固定、离线的测试运行时"。本仓库**不提交 Node 二进制**：一个 node.exe 约 100 MB，超过合理仓库体积，也会让运行时版本与宿主 Node 版本混淆。

## 当前自测运行时

- 使用 PATH 中的 Node：本机实测 `node v26.13.0`（`engines` 要求 `>=24.9.0`；宿主内嵌 Node 为 24.21.0）。
- `node tools/check-runtime.mjs` 打印 node 版本、平台、node 可执行文件 SHA256，以及 `source-lock.json` 的 runtime/host 身份；低于 24.9 时退出非零。
- 测试与工具均假设 `node` 来自 PATH；没有 `runtime/node.exe` 时，命令示例里的 `.\runtime\node.exe` 等价替换为 `node`。

## 需要完全离线固定运行时时的做法

1. 从已批准的本地安装（例如 `E:\dsh\plugin\05-local-memory\runtime\node.exe` 或 Node 官方安装包）复制 `node.exe` 到本目录。
2. 计算并记录 SHA256：`Get-FileHash .\runtime\node.exe -Algorithm SHA256`。
3. 把摘要写入 `source-lock.json` 的 `runtime.tested_node_sha256` 与本地 `evidence/` 运行记录；`source-lock.json` 变更属于 T1 合同修订，需重跑受影响测试。
4. `.gitignore` 已排除 `runtime/node.exe`；不要把二进制推送到远端仓库。

不下载、不升级、不访问注册表或远端分发服务；运行时只能来自本机已批准安装。
