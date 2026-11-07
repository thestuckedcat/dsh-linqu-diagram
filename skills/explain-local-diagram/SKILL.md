---
name: explain-local-diagram
description: Use when the user asks to draw, explain, or refresh a local architecture/flow diagram for a code path or module group ("把这条路径/这组模块画出来"), or asks for a conceptual flow sketch. It selects a registered evidence subset, runs the offline render CLI, keeps exact/may/unresolved honest, and reports truncation/source_state instead of inventing relationships.
whenToUse: 用户要把一条调用/数据/依赖路径或一组模块画成图并解释，或要一张纯概念流程草图时使用。先确认范围与已登记证据子集，再用 tools/render.mjs 本地渲染；无证据只允许用户明确描述的概念图；不联网、不调用模型服务、不伪造 EvidenceSubset/SourceIdentity。
---

# 本地架构图生成与讲解

输入只有两种：**已登记证据子集**或**用户明确描述的概念关系**。图是可回查的解释产物，不是事实库。

## 硬约束（先读）

- certainty 只能保留或降低：exact 边要有证据且不得高于原来源；`reference` 不因连到函数升级为 `call`；禁止把 may 说成 exact。
- 证据模式必须同时提供**已登记**的 `EvidenceSubset` 与 `SourceIdentityV1`（本地 JSON）；不得编造、改写或拼凑节点/边/identity 来凑图。缺身份就如实标 `source_state=unknown`，不自己补。
- 概念图、外部导入、用户口头补充一律 `mode=conceptual`、边 `origin=annotation`/`certainty=unknown`；不假装来自 Atlas。
- 只支持 `--renderer builtin`；atlas/archify 返回 `UNSUPPORTED`，不做远程/URL/模型服务回退或静默换渲染器。
- 输入路径只能是本地文件；http(s)/`file:`/`data:`/UNC 会被 CLI 拒绝，不绕过。
- 不隐藏 `truncated/omitted_*`、`source_state=stale|unknown`、失败 `code`/`warnings`；不手写图包。

## 预算

6 步内结束：确认范围 → 准备本地输入 → 渲染 → 校验 JSON 摘要 →（按需）读 spec 计数 → 汇报。任一步失败就停并报告，不追加无效重试。

## 步骤

1. **缩小到一个焦点**：一条路径（A→B）或一组模块（约 ≤30 节点）。范围过大先建议拆分，不擅自全仓扫描。
2. **准备本地输入（只读/仅写入用户指定目录）**：
   - 证据模式：从 04/Atlas 已登记 snapshot 取 `EvidenceSubset` JSON 与 `SourceIdentityV1` JSON；需要 current/stale 判定时再提供 `--current-identities`（SourceIdentityV1 或数组）。不重跑索引、不手改 identity。
   - 概念模式：仅当用户明确描述关系时写 `conceptual-input.json`（`{title,scope_ref,nodes:[{id,label,kind}],edges:[{from,to,kind,label,description}]}`）；节点/边来自用户原话，不补事实。
   - 两者都没有 → 停下要证据或请用户描述，不生成空壳图。
3. **渲染**（项目根、PATH `node`；`--out` 指向临时或用户指定目录，不写仓库）：
   - 证据：`node tools/render.mjs --evidence <EvidenceSubset.json> --source-identity <SourceIdentityV1.json> [--current-identities <identities.json>] [--verify-evidence-roots <repo-roots.json>] --renderer builtin --out <dir>`
   - 概念：`node tools/render.mjs --conceptual <conceptual-input.json> --renderer builtin --out <dir>`
   - 外部/历史 `.drawio` 只按概念层导入：`node tools/render.mjs --import-drawio <file.drawio> --renderer builtin --out <dir>`（压缩/未知高级形状会 `UNSUPPORTED`，不要绕过）。
   - 可选覆盖 `--scope-ref/--title/--diagram-id/--revision`；先用 `node tools/render.mjs --help` 确认当前构建参数。
   - **证据内容真实性**：只有传了 `--verify-evidence-roots`（本地 `{repo_id: root}` JSON）时 CLI 才逐 ref 校验文件存在/行号/根内路径；否则摘要/coverage 会标 `structural-only`。用户证据未内容核验时，汇报必须写“结构校验，未内容验证”，不得声称已核实来源。
4. **解析 stdout 的单个 JSON 摘要**：成功 = `exit_code=0` 且 `status=saved` 且 `checks{files:7, expected_files:7, resource_manifest, manifest_verify, offline_html, remote_refs:0}` 全为真。非 0 或 `status!=saved` 时引用 `code`/`warnings` 并停止；不换渲染器、不改远程输入重试。摘要含 `evidence_verification: 'structural-only'|'trusted-local-roots'`，如实转述。
5. **按需计数**：要 exact/may/unresolved/unknown 数量时，只读 `artifact_ref/diagram-spec.json` 的 `edges[].certainty` 统计；不从摘要猜。`truncated`/`source_state` 以摘要为准，`warnings` 原样保留。
6. **按固定结构汇报**：`mode/scope/source_state/nodes/edges/truncated/warnings/manifest_digest/artifact_ref`；可给的逐边计数；未验证项；一条下一步。模板与字段说明见 [references/contracts.md](references/contracts.md)。

## 讲解规则

- 顺序：范围 → 主路径 → 关键分支/回边 → 不确定点 → 代价；3–8 句，先机制后边界。
- 事实边逐条带 `evidence_ref`；exact 也只说“静态解析到”，不等于运行时必达。
- `may/unknown` 用“候选/可能/未解析”；不因图好看或用户坚持而升级。
- 概念图先声明 `conceptual` 且来源是用户描述；不追加“Atlas 显示……”。

## 何时停

- 无已登记证据且用户描述不足；输入 JSON 缺失/非法；`status!=saved` 或 `exit_code!=0`（引用 `code`/`warnings`）；`checks` 有 false 或 `remote_refs>0`；`source_state=stale|unknown` 尚未告知用户；超限额且用户不缩范围；需要远程资源/模型服务。
- 停止时报告：已确认范围、缺失输入、已执行命令与 `exit_code`、明确未做的事；不产出假图。`generation_seam_missing` 仅用于 CLI 报 `UNSUPPORTED`/`DENIED` 或输入路径不可用，并要附上 CLI 的 `code` 与原文 `warnings`。

## 不要

- 编造 `EvidenceSubset`/`SourceIdentityV1`/证据行号，或把概念图说成来自 Atlas。
- 把 may/候选说成 exact，或把“读起来像”当成编译证据。
- 隐藏 truncated/omitted、跳过 checks、把失败描述成成功。
- 用 http(s)/UNC 等远程路径作输入，换 atlas/archify 重试，调用公共图服务/远程字体图片/AI，安装或升级组件，修改 `source-lock.json`。
- 在无编辑能力时提供假保存按钮或承诺 .drawio 已可编辑（宿主编辑门禁属 T4/T6）。
