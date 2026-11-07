# 本地图示与阅读产物独立开发计划

> 执行约定：分离生成 skill 与编辑 plugin；按任务失败用例→最小实现→复测。

**2026-11-07 实现状态：** 本文是历史开发计划（任务索引）。按 [DIA-DESIGN-2](docs/software-design.md) 的实现已完成组件级编码与自测：T1—T5 与 T6 的离线部分已实现，`node --test tests/`、生成 CLI、network-smoke、client bundle 构建等见 [实现路线](docs/implementation-route.md)、[兼容矩阵](docs/compatibility.md)、[机制说明](docs/mechanisms.md) 与 `evidence/`。**真实 Host 安装/激活、浏览器 CSP/DOM 旅程、卸载与 OS 级出口未执行**，因此不能把本文勾选当完整首版验收。以下任务表保留原计划语义，不做事后改写。

2026-11-06设计入口：[software-design.md](docs/software-design.md)。用户已明确首版图生成/讲解＋本地可视化编辑都要。生成和编辑分离实现，但本PLAN旧“可选编辑/用户暂不需要可后置”分支已被此要求覆盖；Task3及完整编辑保存/出口旅程是首版必需。可选的是Archify/Drawio具体来源，不是编辑功能本身。

**Goal:** 把有来源的代码关系变成离线讲解图，并按需在本地编辑 .drawio。
**Architecture:** 调用 Atlas 已有离线产物或概念输入；讲解布局用自有确定性 renderer（Archify 仅机制参考、未采用），人工编辑用自有受限 SVG 编辑器（Drawio 增强未采用）；生成/编辑不更改编译事实库。
**Tech Stack:** 固定 Node >=24.9、本地 HTML/XML/SVG、rc.5 Host/client 薄适配；无第三方运行时依赖。
**Spec:** [软件设计](docs/software-design.md)；[共同约束](docs/references/development-contract.md)。

## Global Constraints

- 生成图是说明/注释，源 snapshot 与 exact/may/unresolved 不可被图形美化提升。
- 全资源本地；ARCHIFY_UPDATE_CHECK_DISABLED=1 由运行入口固定传入，阻断远程字体/图片/URL/AI/导出/更新旁路。
- Atlas Viewer 已满足时不增加插件；生成 skill 和编辑 plugin 可分别交付、不强制同装。
- 当前无实现。以下路径待创建，Windows命令用 .\runtime\node.exe；Linux用 ./runtime/node。先锁运行时、源码/发布包摘要及许可。

## Review Focus

1. 手工增加连线不能变为已证调用 → DIA-01。
2. 编号正确但源snapshot/源码摘要过期须显示stale → DIA-01。
3. 恶意XML/SVG/URL、引用远程字体与导出转换器不能执行/联网 → DIA-02/03。
4. 编辑时Agent已更新文件不能被旧版本保存覆盖 → DIA-03。
5. 子进程 finalize/重试也不能漏掉禁更新配置 → DIA-02。

## Task 1：证据到图的确定性适配（DIA-01）

**Files:** Create source-lock.json, package.json, src/evidence.mjs, src/spec.mjs, tests/evidence.test.mjs, tests/fixtures/snapshot/。
**Interfaces:** toDiagram({snapshotRef,sourceDigests,nodes,edges}) → diagramSpec；每条edge携 kind、certainty、evidenceRef；validateSource(spec,currentSnapshot) → current|stale|invalid。格式适配与上游渲染schema分开。

- [ ] 固定 Atlas 导出及候选渲染schema版本；编写 DIA-01：may/unknown 保留、手工边 origin=annotation、缺证据不变exact、换snapshot会stale。运行 .\runtime\node.exe --test tests/evidence.test.mjs，先确认缺实现失败。
- [ ] 实现只从获准证据子集映射，不在绘图步骤读全仓或调用另一个模型服务；人工改图只在注释层保存。
- [ ] 复测真实合成snapshot的节点/边反向定位与过期表现，确认图生成成功不等于关系为真。

## Task 2：离线生成 skill 和导出（DIA-02）

**Files:** Create skills/explain-local-diagram/SKILL.md, skills/explain-local-diagram/references/workflow.md, src/render.mjs, tools/render.mjs, tests/render.test.mjs, tests/network.test.mjs。
**Interfaces:** renderLocal(spec,{outputDir,runtimeRef}) → {htmlRef,snapshotRef,validationRef}；只从source-lock指向的本地Atlas/Archify执行器选择，不找远程安装器。

- [ ] 写 DIA-02：更新检查、远程图片/字体、URL输入、render失败重试、finalize子进程一律不能向未登记目的地请求；先跑 .\runtime\node.exe --test tests/render.test.mjs tests/network.test.mjs 失败。
- [ ] 实现受限本地渲染入口、输出路径/资源校验和禁更新环境继承。已有可用Atlas HTML直接返回，不添加第二份renderer。
- [ ] 写生成/修订/导出操作skill，明确源图schema与展示验证仅负责格式，不能替用户声称理解。若使用模型生成说明，只走批准的宿主Provider，不在renderer另存key。
- [ ] 复跑单测，再在准备任务预置的隔离浏览器中打开真实HTML，记录资源请求、注入脚本/外部URL负例及离线交互。实际浏览器命令与版本写入source-lock并附验收脚本；未准备前不得标通过。

## Task 3：首版必需的本地可视化编辑（DIA-03）

**Files:** Create plugin/index.ts, plugin/client.tsx, src/save.mjs, cordis.patch.yml, tests/save.test.mjs, tests/editor.test.mjs, tools/editor-smoke.mjs。
**Interfaces:** openDocument({documentRef,sessionRef}) → {xml,version}，两者来自同一受控读取基线；saveDiagram({documentRef,expectedVersion,xml,sessionRef}) → saved|conflict|denied。expectedVersion必须是编辑者打开该正文时取得的版本；缺失必拒绝，不能在保存时读取最新token替旧XML补齐。冲突后重新打开或显式合并，不后台自动重试覆盖。

- [ ] 写 DIA-03：外部改动→conflict、无version拒绝、冲突后不得自动读新version重试旧XML、软链接越根拒绝、伪造origin/window消息拒绝、恶意XML/SVG和远程资源输入拒绝，先运行测试失败。
- [ ] 对锁定Drawio版本做薄适配：保留已有禁云SDK措施，补剩余URL/AI/导出边界、宿主鉴权、写权限和来源校验；不将编辑后的图导回事实库。
- [ ] 运行 .\runtime\node.exe --test tests/save.test.mjs tests/editor.test.mjs；随后 .\runtime\node.exe tools/editor-smoke.mjs --isolated 对临时文件验证版本冲突、重开、断网与卸载。
- [ ] 完成首版本地可视化编辑；Drawio不满足rc.5/出口门禁时按软件设计采用自有受限编辑器。生成组件可分阶段验收，不能替代首版完整交付。

## 独立交付

Task1/2是生成/讲解路线；Task3是首版必需、可独立启用的编辑路线。08装配已验收的双入口，不把全部候选实现同时默认启用；完整首版需两条路线均通过。

