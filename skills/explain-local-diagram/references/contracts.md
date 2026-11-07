# 图示生成参考：命令、输入、摘要与限额

本文件是 `SKILL.md` 的按需参考。命令/字段以本仓库当前构建为准（2026-11-07 实测，Node v26.13.0）；未实测的路径明确标“未验证”。

## 1. 命令（已实测）

```bash
# 能力/参数检查
node tools/render.mjs --help

# 证据模式（两项必填：EvidenceSubset + SourceIdentityV1；current identities 可选）
node tools/render.mjs --evidence <EvidenceSubset.json> --source-identity <SourceIdentityV1.json> \
  [--current-identities <SourceIdentityV1-or-array.json>] [--verify-evidence-roots <repo-roots.json>] \
  --renderer builtin --out <dir>

# 概念模式（仅在用户明确描述了关系时；输入形状见 §4）
node tools/render.mjs --conceptual <conceptual-input.json> --renderer builtin --out <dir>

# 外部/历史 .drawio：只按无可信证据的 concept 层导入（压缩/未知高级形状 -> UNSUPPORTED）
node tools/render.mjs --import-drawio <file.drawio> --renderer builtin --out <dir>

# 可选覆盖（只用于 evidence/conceptual）：--scope-ref <text> --title <text> --diagram-id <id> --revision <n>

# 合成 fixture 自检（固定时钟；不代表用户输入，不能拿来交差）
node tools/render.mjs --fixture --renderer builtin --out <dir>
node tools/render.mjs --fixture --conceptual --renderer builtin --out <dir>
```

- 只支持 `--renderer builtin`；`atlas/archify` 退出 1、`status=failed`、`code=UNSUPPORTED`，不会静默回退。
- 输入文件只能是本地路径；`http(s)/file:/data:/blob:/about:/javascript:`、UNC（`//`、`\\`）和控制字符会被拒绝（退出 1、`code=INVALID_INPUT`）。
- `--evidence` 必须同时给 `--source-identity`；`--current-identities` 决定 `source_state=current|stale`，省略即 `unknown`。
- **证据内容核验**：不传 `--verify-evidence-roots` 时 CLI 只做结构校验，摘要 `evidence_verification=structural-only`、coverage 带 `structurally validated only`；传本地 `{repo_id: 本机 root}` JSON 后逐 ref 校验文件存在/行号/根内路径（`trusted-local-roots`），失败退出 1、`code=INVALID_SPEC`。`content_digest` 的 Atlas 语义不在本 CLI 内重算，不要声称已核 digest。
- 输出：`--out` 根下 `<mode>/artifact-<id>/` 七文件图包 + `.operations/<operation_id>.json` 幂等记录；stdout 恰好一个 JSON 摘要。
- 本地出口证据命令：`node tools/check-runtime.mjs`、`node tools/network-smoke.mjs --isolated --renderers builtin`。

实测样例（仓库 fixture 输入，2026-11-07）：
- 证据：`node tools/render.mjs --evidence tests/fixtures/snapshot/evidence-subset.json --source-identity tests/fixtures/snapshot/source-identity.json --current-identities tests/fixtures/snapshot/current-identities.json --renderer builtin --out <tmp>` → exit 0；`status=saved, mode=evidence, source_state=current, nodes=5, edges=4, truncated=false`；`checks{files:7, expected_files:7, resource_manifest:true, manifest_verify:true, offline_html:true, remote_refs:0}`；`warnings` 含 `coverage.complete=false` 与 `unresolved_count=1`。
- 概念：`node tools/render.mjs --conceptual tests/fixtures/conceptual/input.json --renderer builtin --out <tmp>` → exit 0；`mode=conceptual, source_state=unknown, nodes=3, edges=2`；warnings 含 `coverage.complete=false` 与 `source_state=unknown`。
- 省略 `--current-identities` → `source_state=unknown`；`--current-identities tests/fixtures/snapshot/stale-identities.json` → `source_state=stale`（warnings 说明旧定位不能当已验证）。
- `--renderer archify` → exit 1、`code=UNSUPPORTED`；`--conceptual https://...` → exit 1、`code=INVALID_INPUT`。

## 2. stdout JSON 摘要（成功/失败都只有一个对象）

必有字段：`schema_version, command, status, mode, renderer, source_state, nodes, edges, truncated, evidence_verification, overlay_items, artifact_ref, manifest_digest, warnings[], exit_code`；失败另有 `code`；成功另有 `checks{files, expected_files, resource_manifest, manifest_verify, offline_html, remote_refs}`；导入模式另有 `import_warnings[]`。

- 成功判据：`exit_code=0` 且 `status=saved` 且 checks 全真（`files=7=expected_files`、`remote_refs=0`）。
- `status` 可能为 `saved|failed|conflict|denied|cancelled|outcome_unknown`（archive 透传）；非 saved 时引用 `code`/`warnings` 并停止，不盲重试。
- `warnings` 必须原样转述给用户：`coverage.complete=false`（v1 恒不完整）、`truncated=true`（省略数量）、`unresolved_count>0`、`source_state=stale|unknown`。
- `truncated` 与 `source_state` 以摘要为准；`nodes/edges` 是 spec 计数。
- 逐边 certainty 计数只从 `artifact_ref/diagram-spec.json` 的 `edges[].certainty` 统计，不从摘要猜。

退出码：`--help` 0；成功 0；输入/渲染/校验/denied/limit/unsupported 均非 0（当前失败统一为 1，用 `code` 区分原因）。

## 3. DiagramSpecV1（生成产物合同）

必填：`schema_version=1, diagram_id, revision, mode, title, scope_ref, sources[], nodes[], edges[], layout{algorithm='layered_v1',direction,positions[]}, coverage{complete=false,truncated,omitted_nodes,omitted_edges,unresolved_count,notes[]}, source_state, generated_at(UTC ISO), renderer_ref`。

- `mode`：`evidence`（有证据）或 `conceptual`（用户描述）。概念图 `sources` 可空、所有边 `origin=annotation, certainty=unknown`。
- 节点：`{id, label, kind: module|function|type|resource|note, origin, evidence_refs[], description|null}`。
- 边：`{id, from, to, kind: call|reference|data|ownership|control|annotation, certainty: exact|may|unresolved|unknown, origin, label, evidence_refs[], explanation|null}`。
- `reference` 不得升级为 `call`；`origin=evidence` 且 `certainty=exact` 的边必须有 `evidence_refs`；`coverage.complete` v1 恒 false。
- `source_state`：`current` 只表示登记身份一致，不表示运行时行为已验证；缺当前身份为 `unknown`；身份差异为 `stale` 并列出差异。

## 4. CLI 输入形状（已实测）

- **EvidenceSubset**：`{atlas_version?, nodes:[{id,label,kind,evidence_refs[],description}], edges:[{id,from,to,kind,certainty,label,evidence_refs[],explanation}], coverage?}`；来自 04/Atlas 已登记 snapshot，不改写、不补边。
- **SourceIdentityV1**：`{source_id, scope_ref, snapshot_ref, repos:[{repo_id, root_ref, revision, dirty_digest, build_variant, arch, compdb_digest, generated_headers_digest}], evidence_manifest_digest}`；证据模式必填。
- **--current-identities**：同一 SourceIdentityV1 或数组；与 spec identity 比较得到 `current/stale`，缺省 `unknown`；不重跑索引/分析。
- **概念输入**：`{title, scope_ref, nodes:[{id?,label,kind}], edges:[{from,to,kind,label,description}]}`（示例：`tests/fixtures/conceptual/input.json`）；仅来自用户明确描述，输出 `mode=conceptual`、边 `annotation/unknown`。
- CLI 不生成、不校验“已登记”资格；Agent 只能传已登记快照导出的文件。没有证据、用户也没描述关系时停止，不编造文件。

## 5. 图包七文件

`index.html`（离线查看、CSP、来源/版本栏、图例、文字等价表）、`diagram.svg`、`diagram-spec.json`、`manifest.json`、`evidence.json`、`diagram.drawio`、`annotations.json`（空也写）。`manifest.json` 含 `spec_digest/renderer_ref/files[relative_path,media_type,sha256,size]/network_mode:'offline'/source_state`。

## 6. 限额默认值（工程初值，超限先拒绝或明确截断）

| 项 | 值 | 项 | 值 |
|---|---|---|---|
| 节点 | 500 | 边 | 1000 |
| label | 256 字符 | description/explanation | 4096 |
| overlay items | 2000 | annotation edges | 1000 |
| 单图包 | 20 MiB | 图包文件 | 64 |
| XML 字节 | 10 MiB | XML 深度 | 64 |
| mxCell | 10000 | 位置坐标 | ±100000 |
| 节点最小 | 160×64 | 层距/同层距 | 96 / 32 |

超限时：能缩范围就先问用户；用户不缩范围则停止并报告，不静默丢边。

## 7. 汇报模板（固定）

```text
mode={evidence|conceptual} scope={A→B 或模块组} source_state={current|stale|unknown}
nodes={N} edges={N} truncated={true|false}
artifact_ref={目录} manifest_digest={hex} renderer=builtin
edges: exact=N may=N unresolved=N unknown=N        # 读 diagram-spec.json 后统计
warnings: {摘要 warnings 原文}
未验证：{运行时行为 / 浏览器渲染 / Host 编辑 / 其他}
下一步：{一条，可观察完成标准}
```

## 8. 失败与恢复

| 现象/code | 动作 |
|---|---|
| exit 0、`status=saved`、checks 全真 | 成功；按模板汇报，转述 warnings |
| `status!=saved` 或其它 status（conflict/denied/cancelled/outcome_unknown） | 引用 CLI `status`/`code`/`warnings` 停止；不盲重发、不覆盖 |
| `UNSUPPORTED`（atlas/archify/未实现特性） | 报告只支持 builtin，停止；不换渲染器或远程服务 |
| `INVALID_INPUT`（本地路径/JSON/参数非法） | 修正本地输入文件或参数后重跑一次；不改为 URL/UNC 输入 |
| `INVALID_SPEC`/`INVALID_OVERLAY`/`LIMIT_EXCEEDED` | 报告 code 与 warnings；缩小范围或修输入；不静默截断后宣称完整 |
| checks 有 false 或 `remote_refs>0` | 停止分发该图包，报告具体检查项 |
| `source_state=stale` | 先展示原证据定位；旧行号只作历史导航，不标“已验证” |
| `source_state=unknown` | 明确告知缺当前身份，不猜 freshness |
| 无证据且用户描述不足 | 停止并要证据/请用户描述；`generation_seam_missing` 仅在确实不可渲染时使用 |

## 9. 出口与来源锁事实（当前仓库）

- `source-lock.json`：`limits.network_mode='none'`，`remote_services=[]`，`model_services=[]`，`credential_access=false`，`commands=[]`；Atlas/Archify/dsh-drawioedit 均为 `adopted_files: []`（`not_adopted`，仅调查/机制参考，**不是已合入**）。
- 锁定执行器（`src/runner.mjs`）：只跑 source-lock 登记命令；绝对可执行、args 数组、`shell:false`、`windowsHide:true`、环境白名单、强制 `ARCHIFY_UPDATE_CHECK_DISABLED=1`、超时/取消杀进程树、输出 1 MiB 上限；未登记命令 `denied`。
- `tools/network-smoke.mjs`：本进程口径（node:net/dns/http/https/http2/tls、global fetch/WebSocket）记录并阻断连接，成功标准是 `attempted_count=0`；**不是 OS 级隔离**，不覆盖 Chromium/原生/其他进程。
- 未验证：Atlas 已有 HTML 复用、Archify 执行器、`index.html` 的浏览器实际渲染、真实 Host 安装与编辑/保存门禁（T4/T6）、OS 级全进程出口。
