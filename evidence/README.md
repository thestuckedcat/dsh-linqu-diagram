# 运行证据目录

本目录保存**实际执行过**的命令及其输出摘要。证据分层按根共同约束：组件/合同 → 已安装库 → 隔离完整 Host → 已批准 API/可信目标 → 出口/故障恢复。只有实际执行过的层级可以标通过；未执行项写 `unknown`/`limitations`，不能用设计文本或其它项目的运行结果冒充。

## 记录格式

每次正式自测生成一个 JSON（可附 TAP/文本）：

```json
{
  "schema_version": 1,
  "command": "node --test tests/",
  "runtime": "node v26.13.0 (win32 x64)",
  "host_archive_digest": "e1b6f25...",
  "source_lock_digest": "<sha256 of source-lock.json>",
  "renderer_ref": "builtin:renderer-v1",
  "input_spec_digest": "<sha256>",
  "artifact_manifest_digest": "<sha256>",
  "exit_code": 0,
  "pass": 0,
  "fail": 0,
  "skip": 0,
  "evidence_refs": [],
  "limitations": []
}
```

## 本轮已知边界（必须在记录中保留）

- 组件级：`node --test` 与 CLI/冒烟工具在临时合成 fixture 上运行；不使用真实用户数据。
- 未安装插件、未启动真实 Host 编辑旅程、未验证浏览器 CSP/DOM 实际渲染、未验证 OS 级全进程出口；这些是 T4/T6 的真实运行门禁，不能由组件测试替代。
- 未运行 Atlas doctor/索引，未下载 Archify/Drawio 构件。
