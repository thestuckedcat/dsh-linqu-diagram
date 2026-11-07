# 06 本地图示：独立评审报告（组件级，DIA-DESIGN-2）

日期：2026-11-07。评审对象：`E:\dsh\plugin\06-local-diagrams`，HEAD `30d3fd4 Implement 06 local diagrams (DIA-DESIGN-2, component-level)`（只读评审；未修改源代码/测试，未提交/push）。评审角色：独立审查，不参与实现。

结论先行：**不建议按当前文字宣称“组件级 T4/T5 编辑闭环已通过”或“可发布为完整首版开发预览”。** 生成 CLI 与离线 HTML 的组件行为基本成立；但生成物缺失布局坐标，直接破坏 `.drawio` 与编辑器基座（R-01），证据 `exact` 仍可由自造 `compiler` 引用产生（R-02），且仓库自带 `tools/validate.mjs` 会把失败检查报成通过（R-03）。在修复这些问题并明确标注 Host 门禁未验证之前，只能作为“生成/HTML 部分可预览、编辑与 exact 声明明确阻断”的开发预览。

## 1. 评审范围与方法

已阅读：`docs/software-design.md`、`docs/implementation-route.md`、`docs/interfaces.md`、`docs/compatibility.md`、`docs/mechanisms.md`、`README.md`、`source-lock.json`、`package.json`、`cordis.patch.yml`；`src/**`、`plugin/**`、`ui/**`、`tools/**`、`tests/**`、`schemas/**`、`evidence/**`、`skills/explain-local-diagram/**` 的关键路径与全部测试文件清单。重点核对 DIA-01..10、DIA-RPC-01、DIA-OVERLAY-01、T1–T7 的实现与声明，以及证据、路径、RPC、XML、事务、出口、测试诚实性、打包和文档一致性。

限制：未做真实 Host 安装/启动、浏览器 CSP/DOM、OS 级出口、真实 Atlas/Archify/Drawio 或用户数据测试；这些在本文末尾列为未验证边界。评审期间未修改源码、测试或文档（仅新增本文件）。

## 2. 实际执行的命令与结果

以下命令均在 `E:\dsh\plugin\06-local-diagrams` 下执行，使用 PATH 中 `node v26.13.0`（`node --version` 实测 `v26.13.0`）。

| # | 命令 | 实际结果 |
|---|---|---|
| 1 | `node --test tests/` | **exit 0；tests 340 / pass 340 / fail 0 / cancelled 0 / skipped 0 / todo 0**；duration 约 7871.9 ms。逐文件计数（另跑每个测试文件）：access 10、archive 15、assets 7、bridge 10、client-bundle 15、contracts 36、descriptor 8、editor-model 22、evidence 20、import 8、integration 1、interop 12、journal 11、layout 16、paths 10、plugin-index 12、render 11、render-cli 6、runner 15、save 17、service 27、source-lock 19、source-state 14、xml 18。 |
| 2 | `node tools/render.mjs --fixture --renderer builtin --out .\scratch-review-fixture`（第 1 次） | **exit 0**；`status=saved`，`mode=evidence`，`source_state=current`，nodes 5 / edges 4，7 文件；`artifact_ref=...\scratch-review-fixture\fixture\artifact-21218a4e319359470b5bb213`，`manifest_digest=1f3fd7608694eb3ab0f2dfe4c56f52f515cee51556eaa7cb54c606bd1aea49aa`；`checks{files:7,resource_manifest:true,manifest_verify:true,offline_html:true,remote_refs:0}`；warnings 含 `coverage.complete=false`、`unresolved_count=1`。 |
| 3 | 同 #2 再跑一次（第 2 次，同一 `--out`） | **exit 0**；同一 `artifact_ref` 与同一 `manifest_digest`（`1f3fd760…49aa`）；说明该 fixture 的语义幂等成立。 |
| 4 | `node tools/render.mjs --evidence tests/fixtures/snapshot/evidence-subset.json --source-identity tests/fixtures/snapshot/source-identity.json --current-identities tests/fixtures/snapshot/current-identities.json` | **exit 0**；`mode=evidence`、`source_state=current`、nodes 5 / edges 4、7 文件；输出到默认 `./scratch-output/evidence/artifact-5888159f5586018c6e822513`，`manifest_digest=8a1bd9f76ebb100c812a514c79ebe602d5e75037b096fa153c135cf35b7ecc35`，`remote_refs=0`。该默认输出目录随后在工作树中不存在（不是本评审删除；本评审只负责 `scratch-review-*`）。 |
| 5 | `node tools/network-smoke.mjs --isolated --renderers builtin` | **exit 0**；`pass=true`，`attempted_count=0`，`unregistered_attempts=0`，`registered_attempts=0`；builtin 进程内 workload 7 文件资源/manifest/HTML 校验通过；`static_network_import_scan.ok=true`。 |
| 6 | `node tools/editor-smoke.mjs --isolated --fixture` | **exit 0**；`checks 12/12`，13 次服务级 RPC（document.open/save/export、operation.get、session.close），`attempted_count=0`，`unregistered_rpc_endpoints=[]`；`bundle.sha256=788eaf2773002abf5c4ac6bb49ff1c45820cdff1ad456d6fb182235588b4018e`。 |
| 7 | `node tools/build-client.mjs --check` | **exit 0**；`ok=true,status=current,bytes=311709,modules=16,externals=["react"]`，`sources_digest=dc4605781555144d597383ec844f37c79dad9e655d2fa5a87f226b7f49016a4e`，`file=plugin/client.js`。 |
| 8 | `node tools/validate.mjs` | **exit 0；total 7 / pass 7 / fail 0**，但 `checks[0] schemas.json_parse` 的 `detail` 实际为 **`ok:false`**，errors 为 `rpc_response: schema root must be type object`、`editor_command: schema root must be type object`。即该工具把自己的失败检查报成了通过（见 R-03）；`evidence/schema-validate.json` 也记录 `"pass": null, "fail": null, "status": "passed"`。 |
| 9 | `node tools/check-runtime.mjs` | **exit 0**；Node 26.13.0（`satisfies:true`），`source-lock.json` SHA256 `c2a4e0fd2e7ae379279ed774c6bd5c55866dc6b5899d959cad65948f5bc0affd`，`locked_files.ok=true, files_count=0`，adopted 0 / not_adopted 5。 |
| 10 | `node tools/network-smoke.mjs --self-test-guard` | **exit 0**；7 个守卫探针（fetch、net.connect、dns.lookup、dns/promises.lookup、http.request、https.request、WebSocket）全部 `recorded=true, threw=true, thrown_code=NETWORK_BLOCKED`；`pass=true`。 |
| 11 | `node tools/render.mjs --conceptual tests/fixtures/conceptual/input.json --out .\scratch-review-conceptual` | **exit 0**；`mode=conceptual`，`source_state=unknown`，nodes 3 / edges 2，7 文件，`remote_refs=0`，warnings 含 `coverage.complete=false`、`source_state=unknown`。 |

补充实际检查（不是仓库命令）：

- 用只读 asar 解析脚本核对 `source-lock.json` 声称的 Host 接口文件：`dsh-client-connection/lib/index.js` SHA256 `0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684`、`lib/client.browser.js` `dfc3544e...94e62`、`dsh-client-ui-layout/lib/client.js` `eb011a7b...e70587`，**三者均与 lock 一致**；另核 `dsh-client-modules/lib/client.js` 的懒 CJS `__ModuleLoader__.load({id,factory})` 形态与包清单 `dsh.client` 字段，和 06 的 bundle/package 声明一致。
- 用临时 Node 脚本打开渲染出的真实 artifact：`document.open` 返回 `status=opened`，但 `base_spec.layout.positions` 为 `[]`（nodes 5 / edges 4）。直接检查同包 `diagram-spec.json` 为 `{"algorithm":"layered_v1","direction":"LR","positions":[]}`；`diagram.drawio` 的所有 `base:*` 顶点 `mxGeometry x="0" y="0" width="160" height="64"`。这是 R-01。
- 用临时 JSON 把 evidence fixture 的 exact 边改成 `path_ref="does/not/exist.c"`、`content_digest="sha256:deadbeef"`、`kind="compiler"`：`node tools/render.mjs --evidence ... --source-identity ...` **exit 0/status=saved**，生成 artifact 中该边仍为 `certainty="exact"`、`origin="evidence"`，label 为 `totally fabricated exact call`。这是 R-02。
- 用临时脚本构造两个 scope generation（ctx0/gen0、ctx1/gen1，各有 output root/document）后 `revoke({kind:'context',ref:'ctx0'})`：返回 `affected.documents=2, affected.output_roots=2`，随后 `lookupDocument('d1',1)` 变为 false，而 `lookupContext('ctx1',1)` 仍 true。这是 R-04。
- 用临时脚本对 `source-lock.isAbsoluteLocalPath('//server/share/x.exe')` 得到 **true**；`'\\\\server\\share\\x.exe'` 得到 false。这是 R-06。
- 用临时脚本在编辑器模型中依次 `add_annotation_node` → `add_annotation_edge` → `set_note(target_ref=<edge>)` → `remove_annotation_node`：最后一步返回 `invalid INVALID_OVERLAY`，错误为 `note target must be an existing document entity`。这是 R-08。

## 3. 发现（只列 blocker/major；minor 见 §3.1）

| ID | 严重度 | 文件:行 | 证据与影响 | 建议修复 |
|---|---|---|---|---|
| R-01 | **blocker** | `src/evidence.mjs:599,708`；`src/archive.mjs:530,548`；`src/drawio/xml.mjs:1613-1617,1632-1636`；`ui/view-model.mjs:157-158` | `toDiagram` 把 `layout.positions` 固定写成 `[]`；`renderLocal` 虽计算 `layoutResult` 只用于 SVG/HTML，不写回 spec，也不传给 `exportDrawio`。结果：CLI 生成的 `diagram-spec.json` 无坐标；`diagram.drawio` 的所有 base 节点都在 `(0,0)`；`document.open` 打开真实 artifact 后 base spec 仍为空坐标，编辑器把全部节点叠在 `(0,0)`；`document.export` 的 `drawio`/`json` 也继承空坐标（`svg` 分支另行计算 layout，不受影响）。`editor-smoke` 使用手工 fixture（`tests/fixtures/store/helpers.mjs:91-98` 有坐标），所以 12/12 通过不能证明真实生成物可编辑。直接违反 DIA-03/07 的布局与 T4/T5 编辑基础。 | 在 `toDiagram` 生成后、创建 overlay/计算 spec digest 前调用 `layoutDiagram` 并把 positions 写入 spec；或让 `exportDrawio` 接受 `layout` 参数并由 `archive`/store 使用计算后的布局。测试必须用真实 `tools/render.mjs --fixture/--evidence` 产物打开编辑器并断言非零坐标和 `.drawio` 坐标。 |
| R-02 | **major** | `src/evidence.mjs:324-351,535-543`；`tools/render.mjs:245-265`；`skills/.../references/contracts.md:61-65` | certainty 只被输入中**自报**的 `evidence_refs[].kind` 限制：`compiler` 被允许到 `exact`；代码从不校验 `path_ref/content_digest` 与实际文件、`evidence_manifest_digest` 或 Atlas 产物。实测伪造 `kind=compiler` + 不存在路径 + `sha256:deadbeef` 的边仍输出 `exact/evidence`。`docs/mechanisms.md:49` 声称“伪造证据…由代码拒绝”，与事实不符；DIA-01 的核心承诺只在“没有 refs”层面成立。 | 把 evidence subset 绑定到已登记 evidence manifest（`source_identity.evidence_manifest_digest` + 每 ref 的 digest/path 校验）后才允许 `exact`；否则一律降级为 `may/unknown` 并明确“输入自称，未核”。CLI 应要求 lock/manifest 引用，不接受任意手写 ref kind。 |
| R-03 | **major** | `tools/validate.mjs:34-43,55-72`；`evidence/schema-validate.json:11-16` | `runCheck` 只把 `false`/`undefined` 当失败；任何返回 `{ok:false,...}` 的检查都会被包装为 `{ok:true,detail:value}`。`schemas.json_parse` 实际报 `rpc_response/editor_command: schema root must be type object`，但顶层 7/7 通过、exit 0；`evidence/schema-validate.json` 的 `pass/fail` 还是 null。这是测试/证据门禁的假绿，不是产品功能。 | `runCheck` 应识别返回值的 `ok` 字段（或检查函数改为抛错）；`pass/fail` 必须落盘；对 root 为 `oneOf` 的联合 schema 应允许或明确单独规则，不要与“root object”规则混用。 |
| R-04 | **major** | `src/editor/access.mjs:764-787` | `revoke({kind:'context'})` 只比较 `scope_ref`，不比较 `scope_generation`；`revoke({kind:'output_root'})` 也只按路径/`scope_ref` 失效文档。实测 revoke gen0 context 会连带失效 gen1 的 document 与 output root（`affected.documents=2`），而 gen1 context 仍 active。这违反“scope 代次撤销/重核”的隔离承诺，可能导致新代次文档被旧 context 撤销后永久不可用。 | context/output-root 级联必须同时匹配 `scope_generation`；撤销旧代次不得动新代次条目。加跨 generation 的回归测试。 |
| R-05 | **major** | `ui/panel.mjs:729-770`；`ui/conflict.mjs:52-56` | 冲突选项 `reopen` 描述是“丢弃本地草稿、重新加载 Host 版本”，但 `onConflictChoice` 对所有非 `download_draft` 选择都调用 `reopenWithLocalOverlay(modelRef.current.overlay)`，把本地注释 rebase/merge 回来；`resolution.action` 只决定是否紧接着保存。用户选择“Reopen”不会丢弃本地内容，和 UI 文案/设计 §8 不符。 | `reopen` 分支应只加载 Host 的 overlay（不传 localOverlay），并清空本地草稿/标注；`keep_both` 才走 rebase/merge。补 UI/组件负例。 |
| R-06 | **major** | `src/source-lock.mjs:97-103`；`src/runner.mjs:382-398` | `isAbsoluteLocalPath` 只拒绝 `\\` UNC，不拒绝 `//`；实测 `//server/share/x.exe` 返回 true。若 `source-lock.commands` 以后登记执行器，preflight 会把它当本地绝对路径并尝试 spawn，违反“本地可执行/无远程”的 outlet 边界。本轮 `commands: []`，因而**当前不可达**；一旦采用执行器即成远程执行入口。 | 拒绝 `^[\\/]{2}` 或统一用 `path.win32.isAbsolute` + UNC 检测（含正斜杠）；在 runner preflight 和 source-lock 两处都测。 |
| R-07 | **major** | `src/drawio/import.mjs:140`；`tools/render.mjs` 模式（仅 `--fixture/--evidence/--conceptual`）；`plugin` 只打开登记 artifact | `importExternalDrawio` 有完整实现和 8 个测试，但没有 CLI、UI 或 Host 入口调用它；用户无法按设计 §1/§7 打开外部/历史 `.drawio` 并按 conceptual 读入。`docs/mechanisms.md:56` 把它列为可执行机制，实际只有库级测试。 | 给 CLI 增加 `--import-drawio`（输出 conceptual spec/overlay），或在编辑器/注册流程中显式接入 `importExternalDrawio`；否则文档把它标为“库级已实现、用户路径未实现”。 |
| R-08 | **major** | `src/editor/model.mjs:731-748,815-819` | `remove_annotation_node` 只把 `note.target_ref === nodeId` 的 note 计入关联项；若 note 的 target 是该节点的一条 `annotation_edge`，边被移除后 note 成为悬空引用，`commitCommand` 的 composite 校验拒绝整次删除（实测 `INVALID_OVERLAY: note target must be an existing document entity`）。同理 `remove_annotation` 删除被 note 引用的 annotation_edge 也会失败。 | 复合删除时把“以任一被移除 annotation_edge 为 target 的 note”一并纳入关联项（或写入 orphaned）；同时补 undo/redo 逆操作。 |
| R-09 | **major** | `src/plugin/service.mjs:377-386`；`schemas/source-identity.schema.json:59-65`；`docs/compatibility.md:40` | `document.open` 返回完整 `base_spec`，其中 `SourceIdentityV1.repos[].root_ref` 是无限制文本；fixture 就是 `H:/fixture/repo-svc`，真实 Atlas 的 root_ref 可能是本机绝对路径。因此 owner 浏览器收到 base spec 时会收到真实仓库根路径；compatibility 宣称“RPC 响应永不泄露路径”不成立（除非明确把 `root_ref` 定义为可公开引用而非路径）。 | 在 RPC open 前把 `root_ref` 映射为已登记引用/脱敏，或文档明确 `root_ref` 是可公开来源引用并限制 schema 不允许绝对路径；补 RPC 泄漏负例。 |
| R-10 | **major** | `src/plugin/service.mjs:851-859`；`src/editor/document-store.mjs:1853-1889` | `operation.get` 只接收 `operation_ref`，`store.getOperation` 扫描 `dataRoot/documents` 下所有文档并返回第一个匹配的 saved version；没有把 operation 绑定到请求的 `context_ref/document_id`（设计 §9 表要求“必须所属context/doc”）。任何 owner 若知道/猜到 operation id，且对找到的文档有 access，就能读到该 version。`session.close` 同样只凭 ref，不校验所属 context/document。 | `operation.get`/`session.close` 输入增加 `document_id`/`context_ref` 并核对；journal 记录 context/document 绑定；对跨 context/文档的 ref 返回 fixed denial。 |
| R-11 | **major** | `src/archive.mjs:669-689,692-706` | `inspectExistingArtifact` 与 `tryRecoverStaging` 只检查 manifest 可解析、文件存在/齐全；不重算 `manifest.files[].sha256/size`。一个命名完整但字节被替换的 artifact 目录会被当作 `saved` 返回；恢复时也可能把损坏的 staging 包 rename 成成品。测试只删 `manifest.json` 覆盖“缺失”，未覆盖“完整但哈希错误”。 | 复用 `verifyResourceManifest` 验证已有的 payload 字节；staging 恢复也验证 manifest 的 sha256/size/total；不相符返回 `outcome_unknown`/conflict，不重命名。 |

### 3.1 minor / 文档一致性问题（不逐一展开）

- `src/editor/document-store.mjs:1271` 对 `document_ref` 用 `[A-Za-z0-9._:-]`，比 registry/service 的 id 字符集多限制：合法的 `doc/1`、`doc+1` 等注册后 `document.open` 返回 `CONTEXT_UNBOUND`。
- `src/render-svg.mjs:497`、`src/archive.mjs:530`、`src/editor/document-store.mjs:1794` 调用 `layoutDiagram` 时未传 `spec.layout.direction`，`direction:"TB"` 的 spec 会被渲染成 LR；layout 单测有 TB，渲染/归档没有。
- `src/events.mjs:136-138` 对 `session_surface_rewound` 只写 reason 文本，没有标记“来自被回退对话的注释待核”（注释没有来源字段）；`docs/mechanisms.md:63` 的“只标相关注释待核”是过度声明。
- `src/plugin/service.mjs:970-983` catch 里再次调用 `resolveContext(shell)`；若 registry 在 catch 时抛错，异常会逃出 `handle`，回到 Host 默认 500（可能回显 `String(error)`）。
- `docs/mechanisms.md` 的逐文件测试计数不准：`xml` 17（实际 18）、`bridge` 11（10）、`access` 14（10）、`save` 24（17）、`paths` 8（10）、`journal` 13（11）；`evidence/final-summary.md:9` 说 25 个测试文件，实际 24。
- `docs/references/design-review-surfaces.md:72` 绑定 06 设计 SHA256 `391846299bf24d8acdca454b19e80cdd2eb3d8af65e940caeb0a1d6bfa114d5d`；当前 `docs/software-design.md` 实测 `39D0D72EB029405819181F36C90F114138E7543B4C2EABDC08ADDF2D022665D6`（大小写仅显示差异）。当前设计字节未被该评审绑定，不能直接引用“已关闭”结论。
- 文档状态不一致：`docs/software-design.md:253` 仍写 “DIA-RPC-01（确定设计，待实现）”；`docs/software-design.md:73-78` 仍列 `plugin/index.ts`、`plugin/client.tsx`、`ui/*.tsx` 等不存在文件；`docs/product-form.md:3` 仍写“功能未实现”；`PLAN.md:19` 仍写“当前无实现”。
- `README.md:12` 指向 `evidence/README.md` 作为组件自测；实际运行摘要在 `evidence/final-summary.md`，README.md 只是格式/边界说明。
- `package.json:55` 的 `test:unit` 指向不存在的 `tests/unit/`；`package.json:17-33` 的 `files` 只含 `evidence/README.md`，不包含实际录制的 `evidence/*.json` 与 `final-summary.md`（`private:true` 时不致命，但与包内容/文档不一致）。
- `docs/software-design.md:249` 要求“秘密过滤须在生成输入前做”；实现没有 secret 过滤函数或测试（只在 runner/source-lock 禁止凭据 env）；这属于未实现的设计条款。
- `source-lock.json` 的 `@deepseek-ai/dsh-client-modules`、`dsh-package-manifest` 两项 `sha256:null`，而 compatibility 将前者列为已核接口；至少应在 lock 中记录或标注“未 pin”。

## 4. 已确认可接受/较好的部分

- **测试执行真实且无 skip**：`node --test tests/` 340/340；测试使用 `mkdtemp`/临时目录，没有写用户目录；没有网络调用；`plugin-index` 对 `DSH_HOME` 用临时目录并在结束后恢复。
- **Host 接口身份**：从安装 asar 只读算出的 connection/layout 三个 SHA256 与 `source-lock.json` 完全一致；bundle 的 `window.__ModuleLoader__.load({id:'dsh-local-diagrams',factory})`、`dsh.client.platform/inject` 与宿主模板一致；`build-client --check` 当前，且有 16 个内联模块、externals 仅 `react`。
- **生成/离线查看主路径**：fixture 两次同一 artifact/digest；evidence 5/4、conceptual 3/2 均 7 文件、`remote_refs=0`；HTML 有 CSP、图例、文字等价表、stale/unknown/truncated 警告；SVG 元素/属性白名单和 `escXml` 转义经测试，恶意 label 为 inert text。
- **出口组件级检查**：network-smoke workload 0 次尝试；`--self-test-guard` 7 个入口均被记录并 `NETWORK_BLOCKED`；source-lock `network_mode:none`、`credential_access:false`、adopted 0、commands 0。
- **受限 XML/导入/保存基础**：XML parser 拒绝 DOCTYPE/ENTITY/CDATA/PI/注释/命名空间/重复属性，限制字节/深度/元素/属性；drawio 只接受白名单元素/属性/style，压缩内容 unsupported；外部导入降级为 conceptual（库级）；store 有 expected_version、不可变修订、journal、冲突不自动重试、独占导出、路径身份与 junction 负例。
- **入口/权限边界代码结构**：service 只接受 `peer.principal.kind==='owner'`；RPC 请求外壳与响应闭合 union；异常映射固定码；registry lookup 每次重核 realpath/scope；store 单 writer 文件锁；`source-lock` 没有实际 adopted 字节，THIRD_PARTY_NOTICES 与 LICENSE 没有冒充第三方合入。

## 5. 未验证边界（不能由本文/组件测试替代）

- 真实 Harness 0.2.1-rc.5 安装/启用、Cordis fiber、`ctx.effect` 清理、真实 authenticated Peer→HTTP channel→registry→document-store 全链路；`peer.signal` 的实际形状/有效性。
- 浏览器实际 CSP/DOM/Pointer Events、`window.__ModuleLoader__` 真实 loader、面板真实 React 渲染、导出下载（blob）与卸载后旧 RPC/旧 session 拒绝。
- OS/Chromium/原生子进程级出口；浏览器资源、DNS、代理、截图/导出器是否外联；真实 Host 的 buffered-body 12 MiB 限额。
- 真实 Atlas 证据、`root_ref/content_digest` 的真实语义、Archify/Drawio 构件与许可、真实 `.drawio` 外部应用互操作。
- 本报告未覆盖：完整 schema 校验器 edge cases、`ui/view-model` 全量渲染路径、`source-lock` 采用证明的完整性、跨平台（本次仅 win32 x64）；这些标为“未评审”，不冒充通过。

## 6. 文档诚实性与打包评估

- 生成/HTML/网络/编辑器 smoke 的**命令与结果**在 `evidence/final-summary.md` 中大体真实；`node --test tests/` 340/340、network 0、editor 12/12 与本次复跑一致。
- 但 `tools/validate.mjs` 的 7/7 是假绿（R-03）；`docs/mechanisms.md` 的测试计数和 `evidence/final-summary.md` 的“25 个测试文件”不准确；`docs/software-design.md` 的评审 SHA 绑定已不匹配当前字节。
- 最严重的文档过度声明是：`docs/mechanisms.md:49` 的“伪造证据由代码拒绝”（R-02）、`docs/mechanisms.md:63` 的“注释待核”（见 §3.1）、`docs/compatibility.md:40` 的“RPC 响应永不泄露路径”（R-09），以及 README/mechanisms 对编辑器可用的暗示（R-01 使真实生成物不可用）。
- 打包：`package.json` 的 `main`/`exports["./client"]`/`files`/`dsh.bundle.patch`/`dsh.client`、`cordis.patch.yml` 的 `- insert: [{id,name}]` 与安装 asar 中模板一致；没有 vendored 第三方代码或大二进制（唯一大文件是 311,709 B 的自生成 `plugin/client.js`）。`runtime/node.exe` 未入库，`engines >=24.9` 与实测 26.13 一致；真实安装未执行。

## 7. 结论/建议的发布判定

**组件级交付与文档不完全一致，暂不宜作为“T4/T5 编辑闭环已验证”的开发预览发布。**

- **可以作为**：生成/离线 HTML 的组件级开发预览（在文档中明确：exact 仅为“输入自报证据”，`.drawio` 基座布局和编辑器在真实生成物上不可用；Host 门禁未验证）。
- **必须修复后才可宣称**：R-01（否则编辑器/`.drawio` 是核心功能缺失）、R-02（否则 DIA-01 的证据承诺不成立）、R-03（否则验证门禁不可信）、R-04/R-05/R-08（否则 scope/冲突/删除语义与文档不一致）、R-09/R-10（否则 RPC 脱敏/operation 归属与文档不一致）。
- **发布时保留的外部门禁**：真实 Host 安装、认证 Peer 全链路、浏览器 CSP/DOM/Pointer Events、卸载后旧 RPC、OS 级出口、真实 Atlas/Drawio 兼容；这些仍未执行，不能由本次组件测试替代。

下次验证建议（按优先级）：先写一个“真实 CLI artifact → document.open → base 非零坐标 → 编辑器渲染 → 保存 `.drawio`”的回归（R-01），再用带 manifest 的伪造 evidence 负例（R-02）和跨 generation revoke 负例（R-04）巩固；`tools/validate` 修好后重跑并重新录制 `evidence/`。

## 8. 评审后修复记录（Lead，2026-11-07）

本节由 Lead 在评审后追加，记录对 §3 发现的处置；不修改评审原文与结论的独立性。

| ID | 处置 | 代码/测试 | 验证 |
|---|---|---|---|
| R-01 | **已修复**：`toDiagram` 生成后调用 `layoutDiagram` 并把确定性 positions 写入 `spec.layout`；渲染/归档/store 导出传播 `direction` | `src/evidence.mjs`、`src/archive.mjs`、`src/render-svg.mjs`、`src/editor/document-store.mjs` | `tests/review-regressions.test.mjs` 断言真实 artifact→open 非零坐标、`.drawio` 非 0,0；`tests/integration.test.mjs` |
| R-02 | **已修复（可验证入口+诚实措辞）**：新增 `policy.verify_evidence` 与 CLI `--verify-evidence-roots`；无 verifier 时 coverage 显式 `structurally validated only`，CLI/HTML 警告；失败整图 `INVALID_SPEC`。同步修正 mechanisms 过度声明 | `src/evidence.mjs`、`tools/render.mjs`、`docs/mechanisms.md` | `tests/review-regressions.test.mjs`（真/假 verifier）、`tests/render-cli.test.mjs` |
| R-03 | **已修复**：`runCheck` 识别 `{ok:false}`；root 支持 oneOf/anyOf/allOf object 分支；`pass/fail` 进证据 | `tools/validate.mjs` | `tests/review-regressions.test.mjs` 断言 7/7、fail=0；重录 `evidence/schema-validate.json` |
| R-04 | **已修复**：`revoke` 支持 `scope_generation`，context/output_root 级联同时匹配 scope_ref+generation；未给代次时撤销同 ref 全部代次（文档化） | `src/editor/access.mjs` | `tests/review-regressions.test.mjs` 跨 generation 负例 |
| R-05 | **已修复**：冲突“Reopen”只加载 Host 版本并丢弃本地草稿；“Keep both”才 rebase+合并 | `ui/panel.mjs`、`plugin/client.js`（重建） | `tests/client-bundle.test.mjs`、`tools/editor-smoke.mjs` |
| R-06 | **已修复**：`//server` 与 `\\server` UNC、driveless rooted 路径均不算本地绝对路径 | `src/source-lock.mjs` | `tests/review-regressions.test.mjs` |
| R-07 | **已修复**：新增 CLI `--import-drawio <file>`（外部 XML→conceptual overlay，压缩/未知形状 UNSUPPORTED） | `tools/render.mjs` | `tests/review-regressions.test.mjs`（正/负例） |
| R-08 | **已修复**：删除 annotation 节点/边时连带清理 target 指向被删节点/边的 note，保持复合历史 | `src/editor/model.mjs` | `tests/review-regressions.test.mjs` 两种删除旅程 |
| R-09 | **已修复**：spec/artifact/RPC 中 `root_ref` 改为 `root-ref:<digest>` 不透明引用（`src/source-identity.mjs`）；同步修正 compatibility/mechanisms 措辞 | `src/evidence.mjs`、`src/source-identity.mjs`、`src/events.mjs` | `tests/review-regressions.test.mjs` RPC 无原始根路径断言 |
| R-10 | **已修复**：`operation.get`/`session.close` 输入增加 `document_id` 并在 store 中绑定；服务校验、UI/编辑器冒烟同步 | `src/plugin/service.mjs`、`src/editor/document-store.mjs`、`ui/panel.mjs`、`tools/editor-smoke.mjs` | `tests/review-regressions.test.mjs`、`tests/service.test.mjs`、`tests/plugin-index.test.mjs` |
| R-11 | **已修复**：复用/恢复已有 artifact 前重算 manifest 的 size+sha256，损坏返回 `outcome_unknown`/冲突，不重命名 | `src/archive.mjs` | `tests/review-regressions.test.mjs` 篡改字节负例 |

**未处置/保留**：评审 §3.1 的 minor 项（document_ref 字符集、session_surface_rewound 单条注释来源、秘密过滤条款、verify 的 docs 细节等）已择要修正文档或合并进上述条目；真实 Host 安装、浏览器 CSP/DOM、OS 出口、真实 Atlas/Drawio 互操作仍是未验证门禁，保持 §5/§7 的结论。修复后 `node --test tests/` 全绿，`evidence/final-summary.md` 与 `evidence/*.json` 已按修复后行为重录。
