# S1 工程治理实施与验收记录

日期：2026-10-14（Asia/Taipei）。基线：`master / 830f788`，项目 `0.3.42`。

**当前状态：本地修复与验收完成；S1 的远端 CI 仍待验证。** 远端 CI 尚未触发，未提交、未推送。下文保留首轮失败记录，并追加本轮根因和回归证据。

## 首轮 S1 的范围与保留结果（历史记录）

- 原有 1223 项暂存删除和 6 项暂存重命名保持；Git index 字节哈希与执行前一致。
- 原有 `src/`、`electron/`、`tests/` 共 1086 个文件与执行前哈希一致。本次只新增测试夹具和清单工具，未修改应用行为或旧测试断言。
- 没有执行 Git 对象清理、历史改写、全仓格式化、提交或推送。S2 的 bundle 分析接入和性能优化没有启动。
- 所有安装、类型检查、lint、单元组和定向构建/smoke 均在独立工作区快照运行，未重装原工作区的 `node_modules`。

## 首轮已完成改动（继续保留）

| 工作项 | 结果 |
|---|---|
| 在用夹具保留 | 从原 `output/playwright/` 原样复制 16 个文件、13,964,867 字节至 `tests/fixtures/model-packages/`；原文件保留，暂存删除未撤回 |
| 夹具引用 | 4 个现有脚本仅调整 11 处输入/复制路径；未改业务断言。生产视觉构建输出仍为 `output/playwright/yzj-production-dist` |
| 文档迁移 | 修正迁移后性能方案的相对链接；原 README 的 671 个非空行和 29 个二级章节在拆分文档中无遗漏；补充夹具当前位置 |
| 配置格式化范围 | `format` / `format:check` 仅针对 package.json、ESLint、Prettier、CI 四份配置 |
| Node 要求 | package.json、锁文件根项和 README 对齐为 `^22.13.0 || >=24.0.0`，与已引入的 ESLint 10 要求兼容；未升级依赖版本 |
| CI 配置 | 保留 Linux 静态检查、Windows 单元组；增加明确格式范围检查、测试清单漂移检查与只读 contents 权限 |
| 测试清单 | 新增 `scripts/generate-test-inventory.mjs` 与 [test-inventory.md](test-inventory.md)，保留原 runner 和全部 npm 入口 |

夹具包括 4 个 HTML 页面，以及 Shelf、Stacker、YZJ 各自的 GLB、metadata、模型 TS 与 TXT。16 个文件与原工作区逐字节相同；与 HEAD 对照仅文本换行差异，GLB 二进制相同。27 个 HTML 本地引用有效，4 个脚本和 4 个 HTML 内联模块通过语法检查，3 个 metadata 和 GLB 头部/长度检查通过。

正式夹具及文档截图未被忽略规则排除；`output/` 仍只承担本地生成产物。历史文档保留当时的产物路径，新增说明给出当前可复用夹具位置。

## 首轮执行的检查（历史结果）

环境：Windows、Node.js 22.22.0、npm 10.9.4；快照包含当前索引文件与非忽略的未跟踪文件，不复制原有 output/node_modules。安装沿用 CI 的 Electron 二进制跳过配置。

| 检查 | 结果与边界 |
|---|---|
| `npm ci` | 最终配置安装通过，556 个包；保留安装日志中的弃用提示，未自动更新依赖 |
| `npm run typecheck` | 退出 0；原应用源码未变化，未用收紧规则替换当前配置 |
| `npm run lint` | 退出 0；538 个文件，0 error、181 warning；warning 未忽略或改写成通过数量 |
| `npm run format:check` | 通过，覆盖明确列出的四份配置 |
| `node scripts/generate-test-inventory.mjs --check` | 通过；额外验证 CRLF 检出可接受、故意引入内容漂移会非零退出，随后恢复原文件 |
| `npm run test:ci` | 退出 1；608 tests：599 pass、8 fail、1 skipped；下节逐项列出 |
| `npm run build:yzj:visual` | 迁移前干净快照因 4 个 HTML 入口缺失而失败；迁移后通过，生成 4 个页面和带 hash 的箭头 PNG；保留大 chunk 提示，未提前开展 S2/S3 |
| `node scripts/smoke-scene-capacity.mjs` | 未通过；当前脚本和 HEAD 原脚本均在相同位置缺少 shadows 设置，见下节。未运行整个 `smoke:scene-capacity` 聚合组 |
| TypeScript 三项收紧盘点 | renderer 43 项诊断，Electron 4 项，未开启新选项；详见下文 |
| 文档/差异检查 | 迁移内容和本地链接/大小写核对通过，`git diff --check` 通过；没有对文档中的业务命令进行全量执行 |
| 远端 GitHub CI | 未执行；本轮没有提交或推送，不能把本地 Windows 检查视为 Linux hosted runner 已通过 |

类型规则盘点使用 `noUnusedLocals`、`noImplicitOverride`、`noFallthroughCasesInSwitch` 临时 CLI 参数，仅在快照执行。renderer 为 TS6133×30、TS4114×9、TS6192×2、TS6196×2；Electron 为 TS6133×4。配置没有开启这些规则，后续按 T 阶段逐项治理。

## 首轮确认的基线失败（本轮已逐项修复）

以下为首轮单元组在修复前的隔离快照中运行的结果。涉及的 6 个测试文件及抽查的 PlayerApp、环境重关联源码均与 HEAD 文本一致；这些文件在首轮未修改，本轮按契约修复测试。以下描述是失败证据，不把源码正则失败直接等同于产品功能故障。

| 文件/用例 | 失败证据 |
|---|---|
| `digitalTwinSourcePackage.test.ts` | Node strip-types 执行源码时，环境重关联模块导入的 `electron/shared/glbFilePolicy.js` 不存在，ERR_MODULE_NOT_FOUND |
| `playerEnvironmentLoadContract.test.ts` | “首帧完成前不能发布 ready 快照”源码契约断言失败 |
| `playerGlobalOverview.test.ts` | 未匹配旧的 `cancelPendingAutoPatrol` 源码正则 |
| `playerStatusOverlayControls.test.ts` | 未匹配旧的漫游浮窗条件源码正则 |
| `projectLibraryTabs.test.ts`：POI 入口 | 预期七项，实际多出 `poi-device-spawner` |
| `projectLibraryTabs.test.ts`：天空盒重关联 | 未匹配旧的 `applyAssets` 源码片段 |
| `sceneSwitchPublishGuard.test.ts`：迟到结果 | VM 测试上下文缺少 `prepareOpeningSceneContent` |
| `sceneSwitchPublishGuard.test.ts`：关闭会话 | VM 测试上下文缺少 `cancelCompositionSync` |

1 项跳过为真实外部 EXR 检查，原因是未配置 `PUBLISH_SKYBOX_REAL_FILE`。没有提供现场文件便不能宣称该路径通过。

容量 smoke 在 `SceneRuntime.syncTheme` 读取 `shadows.sunAzimuthDegrees` 时失败。隔离对照使用 `HEAD:scripts/smoke-scene-capacity.mjs` 并恢复其原 `output/playwright/shelf-assets` 输入位置，得到相同错误，确认该失败早于本次路径迁移。对照结束后恢复了快照中的新版脚本。

首轮保留了失败证据。本轮已核对业务契约、修复加载及夹具根因，并用实际回调/时序断言替代陈旧源码形状检查；没有跳过测试或修改产品行为来迎合旧预期。

## P1 测试盘点结果（当前）

- 653 个候选文件：585 个测试/runner/smoke 候选，68 个 fixture/helper（新增实际源码表达式测试 helper）。
- 68 个 npm 测试相关入口；303 个候选存在静态入口，282 个无入口或无法静态确认。
- CI 静态可达 89 个候选；这是配置可达数量，不是执行/通过数量。
- 3 个动态子进程调用需人工复核：`smoke-skybox-mosaic.mjs`、`test-model-download-progress.mjs`、`environmentBindingAuthority.runner.mjs`。
- 清单保留串行、平台、编译、Electron、junction、全局状态及服务隔离线索。没有纳入 CI 的文件逐项列出，不把“未静态确认”表述成无效测试。

## 首轮后续事项与证据保存（后续进展见下节）

1. 对上述 8 项单元失败和容量 smoke 基线问题分别确认契约与测试上下文，再定向修复和回归；质量门禁保持失败可见。
2. 后续获准提交/推送后，取得实际 GitHub Linux/Windows job 结果。未取得之前，I3 与 S1 保留进行中。
3. `smoke-shelf-shared-instancing` 仍需要真实 20×100 双深 Shelf 场景；`smoke-parametric-model-array-packages` 仍需要外部 16 模型包、镜像、索引和场景。本轮没有替换或弱化这些验收输入，也没有运行这两项现场资产验证。

本地原始日志和结构化摘要保存在 `output/s1-validation/2026-10-14/`（已忽略，不进入提交），包含安装、类型检查、lint、单元失败、迁移前后构建及容量基线对照。需要撤回本轮变更时按文件逆向本轮补丁，勿整文件 restore/reset，以免丢失原有未提交改动。

临时资源清理未完成：`C:/Users/WY/AppData/Local/Temp/babylon-s1-TWFwRN` 保留本轮快照、依赖和构建产物。删除前已核对准确路径、保存证据，并确认没有命令行指向该目录的非 shell 进程；自动审批审查仍拒绝递归删除，仅返回 `blocked by policy`，没有更具体原因。没有改用其他工具绕过该限制。


## 本轮根因修复与回归（2026-10-14）

### 契约核对与修复

| 项目 | 根因及修复 | 保留/增强的断言 |
|---|---|---|
| SOURCE 打包 | Node strip-types 无法解析 NodeNext 源码中的编译后 .js 引用；测试加载时仅把 electron/ 内不存在的 .js 映射到存在的 .ts，finally 撤销 hook | 原 19 个测试体逐字保持，包含完整场景、阴影签名、路径边界、Sidecar 和完整性验证；不依赖上次构建产物 |
| 环境首帧 | 候选环境事务使用 next，旧字串限定 this.current 已过时 | 执行真实 loadAndSwap，检查首帧等待、旧环境保留、成功交换、失败和过期释放、ready/结算顺序；保留原诊断接线断言 |
| Viewer 概览与浮窗 | 新增开场取消和交互门控后，旧连续字符串不再匹配 | AST 执行真实回调与 JSX 条件，验证完整恢复顺序及开场/loading/blocked/禁控等隐藏条件 |
| POI 与天空盒 | 已发布的设备产生器属于第八个 POI；天空盒回调新增保留已打包引用策略 | 精确断言八项有序集合；实际执行回调和上下文表达式，检查数组、场景 ID、即时策略、readonly/事务/会话 |
| 发布/关闭门控 | VM 夹具缺准备内容与取消组合库同步依赖 | 覆盖两个打开入口的五个等待点；发布后不得授权/记录/暂存；关闭使用真实 token/scope，拒绝迟到暂存和确认；检查等待任务前后的取消与清理顺序 |
| 容量场景 | 手工 sceneSettings:{} 绕过标准场景必填默认值 | 使用真实 createEmptySceneDocument；保留实体引用及选择、参数、批次和运行预览全部原检查，产品 SceneRuntime 无改动 |
| 缓存生命周期 | 旧断言要求零引用立即释放，与 0c1e92a 引入的 16 条/128 MiB 有界 idle 缓存契约冲突 | 检查实例释放、单个 idle 模板、重加不重复加载、最终销毁精确释放一次、重复销毁仍一次；移除计数 spy 自身去重以捕获重复释放 |
| 持久化合批 | 旧单场景发布正则不支持当前 preparedScenes 与 SOURCE/DIST 公共投影流程 | AST 核对标准序列化、入口复用、非入口准备、保存/overlays、SOURCE 入口和 DIST 公共投影；实际执行多场景分支并保留全部合批业务检查 |
| 性能 HUD | 性能运行强制显示并锁定勾选，旧纯手动显隐正则过时 | 执行真实 checked/disabled/onChange 及 panel 派生状态，覆盖普通模式、强制显示、有无快照、停止恢复和用户切换 |

POI 契约证据：7f49a87 与 docs/releases/v0.3.38.md。缓存证据：0c1e92a 与 SharedModelAssetCache 默认预算。旧场景缺阴影设置已由 SceneSerializer 归一化，不能为无效测试夹具修改产品默认行为。新异步门闩测试观察任务提前结束并设置 10 秒 timeout，避免错误被挂起掩盖。

本轮仅改 6 个测试文件、3 个 smoke 脚本、新增 tests/helpers/playerContractTestHelpers.ts，另同步清单、文档及 Node 版本元数据。592 个 src/electron 应用文件哈希与本轮开始一致；原 Git index 不变。Node 最低要求更新为 ^22.15.0 || >=24.0.0，因为测试使用的 registerHooks 自 Node 22.15 提供；实测为 22.22.0。

### 已取得的回归结果

| 检查 | 结果 |
|---|---|
| 完整 npm run test:ci | 631 tests，631 pass，0 fail，0 skipped，0 cancelled |
| SOURCE 原断言 | 19/19，通过；测试体与 HEAD 原文一致，仅加载入口调整 |
| Player 定向 | 16/16，通过 |
| 发布门控/库与相邻 scope/controller | 47/47，通过；其后门闩可靠性复验 12/12 |
| SharedModelAssetCache 回归 | 12/12，通过，覆盖预算及模板行为 |
| 阴影设置兼容回归 | 6/6，通过 |
| 真实 EXR 恢复 | 10/10，通过；使用本地已存在 EXR，原文件 SHA-256 前后相同；完整单元组也带此输入，未跳过 |
| 容量单脚本 | 100 实体、99 thin instances、18 batch mesh、sourceLoadCount=1、sourceDisposeCount=1；全部原路径通过 |
| 持久化合批定向 | 2 个持久化批次；不支持脚本/参数链/motion 各 2 个保留；真实场景 206 实体、126 个 motion 模型，motion 合批数为 0 |
| 编辑器性能定向 | 大场景脚本与 Hierarchy virtualization 均通过 |
| 完整容量聚合 | npm run smoke:scene-capacity 最终退出 0；静态模型策略、加载调度、容量、持久化合批、大场景与层级虚拟化六个脚本全部通过 |
| typecheck / lint / 格式 / 清单 | 通过；lint 538 文件、0 error、181 warning；清单 653 文件 |

这些结果来自 Node/AST、SSR/NullEngine 和指定真实资源的只读检查，不代表当前版本已完成真实 WebGL FPS、安装版 Viewer 或线上部署验收。Vite 在服务关闭时有客户端依赖预扫描告警，日志保留；最终是否通过以脚本断言和进程退出码为准。

本轮完整日志、变更前快照哈希、EXR 输入哈希和汇总位于 output/s1-validation/2026-10-14-followup/。首轮日志继续保留。验收复用上轮因清理策略限制留下的临时快照，目录仍为 C:/Users/WY/AppData/Local/Temp/babylon-s1-TWFwRN；本轮未绕过清理限制。远端 CI 需在未来获准提交/推送后验证，不将本地通过标为远端通过。

本轮最终结论：原 8 项单元失败与容量异常已消除，容量聚合随后暴露的多场景发布和性能 HUD 陈旧检查也已按契约修复。没有新增跳过项或取消项；未修改产品代码、未提交、未推送。S1 保留“本地验收已完成、远端 CI 待验证”的边界。
