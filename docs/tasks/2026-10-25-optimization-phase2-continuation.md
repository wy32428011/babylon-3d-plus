# 2026-10-25 优化第二期续作

## 目标与边界

核对 `全项目优化方案-第二期.md` 的实现与验收状态，完成已在工作区的 GLB 传输预压缩闭环，并修复 E6 天空盒测试初始化阻塞。保留入场全部未提交改动。原场景、资源几何、模型脚本、MQTT 频率、画质和默认关闭实验保持原合同；不提交、推送、外部发布或修改中台服务。

历史工厂 ABBA 原始目录未在本机找到，因此历史性能数字只引用已有报告，不宣称本轮复测。N1/N2 已有实现但仍欠工厂对照；缺少冻结输入时不使用合成回放替代正式验收。

## 验收清单

- [x] 区分当前渲染第二期与旧 P2-R 路线，核对已实现、局部通过及未验证项。
- [x] GLB：有效 GLB 经完整 Electron DIST packager 集成，含原文/清单、预算回退与取消清理。首次因 EACCES 未到达的历史日志保留；用户续令后已修复并实际通过，见本文后半部分。
- [x] GLB：隔离 HTTP 的原 URL identity/gzip/br、浏览器冷/暖/换版/回旧版缓存通过；真实 ZIP 归档的解压字节可由实际 Babylon loader 读取（NullEngine）。
- [x] E6：重现并修复支持的 Node 22 下天空盒初始化问题，157/157；全局 CI 816 通过、0 失败、1 条外部 EXR 条件跳过。
- [x] 当前版本完整 build（含 TypeScript）、lint、测试入口与清单检查通过；专项证据及未执行项见下。
- [x] 更新第二期方案、使用文档、任务日志与本记录，区分本地传输验证和未部署/未测性能项。

## 入场证据

- Node `v22.16.0`，符合 package engines；当前分支 HEAD `d96ec04`，已有 N1/N2、GLB 预压缩及工程打开修复等未提交改动。
- `npm run test:data-platform-skybox`：75 通过、8 失败，见 `output/phase2-skybox-baseline.log`。包括 `MAX_SKYBOX_FILE_BYTES` 循环加载 TDZ，其他失败逐项归因，不能以修复其中一项宣称 CI 全绿。
- 当前 GLB 草稿只接受节省超过 10% 的侧车，尚缺有效模型的 ZIP/HTTP/缓存组合证据。

## 结果

### 实现与检查

1. 天空盒 index/store 改为静态 `.ts` 依赖，避免同步 require 提前访问 ESM 导出；现有 `rewriteRelativeImportExtensions` 保证产物使用 `.js`。两种静态导入顺序的真实子进程回归先 RED 后 GREEN。旧 lifecycle 测试按已有内置天空盒、来源隔离路径与物化骨架修复夹具；独立注入发布状态仅服务该定向单元边界，未改变产品发布逻辑。
2. 有效 GLB 夹具有 3 顶点、6144 索引；真实 ZIP 归档原文件、br/gzip 与 manifest，逐字节/SHA 还原并经实际 Babylon loader 校验已知几何。完整 DIST 集成也新增相同模型，但两次 Electron spawn 均 EACCES，尚未进入测试，原失败日志保留。
3. Chrome 使用实际生产预压缩 helper、Response Cache 与 PublishedRawStore/PublishedAssetCache：28 项 HTTP 编码、MIME、完整 SHA 检查通过。两个版本的 GLB 节点名与 SHA 确实不同，冷/新版本各 7 次资源运输，暖/换版暖/回旧版均 0；原资源及解码缓存各 2 命中、0 下载/解码。HTTP 的 GLB decode 仅解析 JSON 元数据；真实 Babylon 几何读取是单元 ZIP/NullEngine 证据，未宣称 GPU 或完整 Viewer 验收。
4. N1/N2 新增 3 条默认 250ms 窗口边界回归：结构变更即时消费、关阴影恢复原件/拾取、GI 加载及候选验证期间保留待办；67/67 通过，未发现需改产品的新缺陷。
5. 只读扫描本地两业务目录 53 个脚本文件（含副本），51 个有提示；遍历 221、强制矩阵 1005、纹理更新 6、getter 副作用启发式 0。未改原脚本，未将 0 命中解释为纯净性证明。
6. 对本机真实环境 GLB 的副本使用交付 helper 单次测量：原 55,684,996 B，gzip 44,655,990 B（−19.81%），br 42,736,051 B（−23.25%），完整 SHA `819d2d007b0b8cae4799d525affe96a3d45d2a40895d0e32dfdaf547e0fccb7e` 还原一致且原资产未变。单次约 2.32s，不是 ABBA、网络或端到端打开测量；保留两表示还需预算与 ZIP 成本。

### 首次续作证据（历史状态；后续 EACCES 修复结果见本文后半部分）

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| `npm run build` | exit0，TypeScript、Editor、Viewer | `output/phase2-build.log` |
| `npm run lint` | exit0 | `output/phase2-lint.log` |
| `npm run test:ci` | exit0，816 pass / 0 fail / 1 外部 EXR 条件 skip | `output/phase2-ci.log` |
| `npm run test:data-platform-skybox` | 157/157 | `output/phase2-skybox-final.log`；原失败/RED 分别保留 |
| `npm run test:deployment-precompression` | 17/17 | `output/phase2-glb-unit.log` |
| `node scripts/smoke-published-response-cache.mjs` | PASS，28 协商 + 5 缓存状态 + 原故障回归 | `output/phase2-glb-http-20261025/report.json` |
| runtime 默认窗口专项 | 67/67 | `output/phase2-lighting-window-tests.log` |
| 完整 DIST Electron 集成 | 未验证，spawn EACCES | `output/phase2-glb-zip-prebuild.log`、`output/phase2-glb-zip.log` |
| `generate-test-inventory --check` / `test:entries` | exit0，unclassified0 / missing0 | 已审阅三份修改文件的登记摘要与证据；运行时文件命令纠正为 `test:lighting-bake` |
| `npm run test:optimization-p4` | 9/9 | `output/phase2-inventory-tests.log` |
| 全部本轮源码/脚本/测试 ESLint | exit0 | `output/phase2-final-focused-lint.log` |
| `git diff --check` | exit0 | `output/phase2-diff-check.log`；原有 LF/CRLF 提示不改变内容 |
| 本地真实 GLB / 脚本扫描 | PASS / 53 文件只读 | `output/phase2-real-environment-compression.json`、`output/phase2-business-script-scan.json` |

### 首次续作当时未完成项与下一步

- 二期性能总验收仍未完成。需要原工厂冻结构建、完整资源清单及原 MQTT 录制才能开展 N1/N2 的正式 ABBA、逐时刻动作/像素检查；本轮不使用替代场景补勾。
- 完整 DIST 集成需本机 Electron 可正常启动后重新执行，当前的手工 ZIP/HTTP 单元不能替代；未扩大权限或修改系统策略。
- 线上 Nginx 的静态编码协商未部署，真实中台冷暖打开下降 30%、Intel GPU、GI/展会样本等仍保留各自未验证状态。
- N3 继续等待 N1/N2 工厂实测后判断投入；LED 新修订、画质选项、全厂烘焙与关闭候选清理不在本轮自动扩大范围。
- 独立审查已复核默认窗口和 GLB 字节/缓存/loader 断言，未发现高置信阻止交付的问题；边界如上明确保留。

## 用户续令：修复 Electron 启动并完成完整 DIST（2026-10-25）

目标顺序：先修复并证明 Electron 普通权限可启动，再执行真实 DIST 打包/预算回退/取消集成，最后推进不依赖缺失工厂输入的二期项目。保留之前原始 EACCES 日志与所有未提交代码；不升级依赖、修改安全策略、提权或外部发布。

- [x] 备份并修正仅当前用户、仅该 Electron 路径的错误兼容性标记，普通 spawn 版本 v42.4.0、exit0。
- [x] 当前构建下完整 DIST 集成通过；原文件/manifest/SHA/MIME、可选侧车、预算回退、取消清理均验证。
- [x] 完成 E3 的同步脚本初始化分段与 Top20 汇总，并通过实际 Editor 小场景读回；完整 E3 与工厂 ABBA 仍未验收。
- [x] 更新测试清单、进度与任务日志，记录最终证据和回退方式。

定位：Node spawn 的 EACCES 经 `.NET Process.Start(UseShellExecute=false)` 复现为 Win32 `740`。`HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` 的精确值 `F:\babylon-3d-plus\node_modules\electron\dist\electron.exe` 为 `~ RUNASADMIN `。包内 checksums 与本地缓存 ZIP 一致，75 个运行时文件也逐文件一致，非损坏/架构错误；不重装或换版本。

下一步选 E3 的同步脚本初始化分段与资源 Top20 汇总：保留原 `scriptInitialize` 异步墙钟阶段；新增 constructor/onStart 同步 attempt 阶段和失败计数，不等待脚本返回 Promise、不额外读取 getter、不改变 receiver/顺序/取消。只在现有诊断出口展示，资源身份在内存按完整引用区分、输出仅保留文件名与不含路径的运行期 ID；资源汇总有界且显式报告丢弃记录。验收为真实源码生命周期回归、诊断汇总/脱敏回归、Editor/Viewer 构建及实际 Editor 诊断读回；不冒充完整跨进程 trace 或中台冷暖 30% 验收。

### 本次结果与可复核证据

证据根目录：`output/electron-eacces-20261025/`，旧失败文件均保留。

- `compatibility-backup.json` 保留精确 HKCU 键、名称、原值和类型。仅移除这一值，普通 Node spawn `electron --version` 返回 v42.4.0、exit0。若需回退，可按备份恢复同一值，但会重新要求提权；没有改其他应用标记、机器级策略或依赖文件。
- `dist-integration-final.json/.log`：当前 build 完整 packager 入口 PASS，25 文件/30 ZIP 条目/11 侧车，含已知几何的有效 GLB；原包6243B、含侧车10281B，8262B测试预算触发仅移除本次侧车，回退6242B。不同 releaseRevision/ZIP 元数据导致少量字节差异，原文件 SHA 保持。三处取消仍清理全部本次 staging/ZIP，已有 .gz 保留；测试私有文件在 finally 清理。
- `e3-build.log`：TypeScript、Editor、Viewer 构建 exit0；`e3-lint-final.log` 全量 lint exit0；`e3-ci.log` exit0，816 pass / 0 fail / 1 外部 EXR 条件 skip。
- `e3-p2-regression.log`：P2 专项201 pass / 0 fail / 1 可选基准skip；`e3-inventory-final.log` P4清单9/9，最终入口检查missing0、清单unclassified0。`final-summary.json` 汇总当前结果、源SHA和边界；上一轮机读摘要已归档到 `previous-phase2-summary.json`，根摘要的Electron阻塞已更新。
- `../phase2-e3-script-timing-tests.log`：真实源码生命周期 16/16，覆盖同步区间与排队/参数setter分离、getter/receiver、构造和onStart失败、坏诊断sink、返回Promise不等待及队列取消。`scene-load-diagnostics.log`：6/6，覆盖按资源聚合、同名不同来源、Top20、脱敏、快照独立及512上限。
- `e3-small-editor-open.json`：实际 Editor 两实体离线夹具 PASS，RTX4060Ti/WebGL2；原 builtin 脚本/几何未改，只在新夹具重定位原示例路径并关闭 MQTT。两个 constructor/onStart attempt 聚合为一个 `virtual-conveyor.model.ts` 资源，阶段失败0、page/console error为空；从实际性能面板复制报告并截图。
- `e3-real-editor-open.json` 与 `e3-real-script-diagnostics.json`：当前383实体场景自然就绪（未forced settle），156次构造与onStart、16脚本资源、同步阶段失败0；constructor8.6ms、onStart19778.7ms，motor脚本81次onStart14980.3ms。原场景SHA未变。整体smoke仍FAIL（2次连接超时、12条未知URL scheme错误），不报告有效打开时间或性能收益，不屏蔽旧失败。
- `e3-scene-loading.log`：旧strip-only入口152pass/29fail，其中1个完整文件因现有编译器参数属性被拒绝；入口改transform后 `e3-scene-loading-transform.log` 为168pass/28fail。剩余28项在未改的ProjectPanel/SceneViewPanel源码抽取、readiness/skybox旧VM/AST夹具中失败；相关测试与读取目标规范化SHA与HEAD一致，但未实跑HEAD，不把静态归因写成基线运行通过或失败。未扩大修复范围。
- 测试入口及清单同步：`test:scene-loading` 与 manifest 改为transform，刷新该metadata分类摘要；既有用例/断言不减少。`generate-test-inventory --check`、`test:entries` 和P4清单专项保持单独记录。

### 后续优先级

E3 已有可用同步热点定位，但完整打开ID/关键路径trace、真实中台冷暖各5次与30%目标仍未完成。下一步应先对motor与shelf的onStart做只读归因，再按原D3规则决定资产新修订；本轮未改变受保护脚本、MQTT频率或默认画质。原工厂回放/冻结基线未找到，N1/N2正式ABBA仍不补勾。线上静态服务未部署。
