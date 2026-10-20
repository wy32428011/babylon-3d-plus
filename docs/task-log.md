# 任务记录

## 2026-10-20 Git 同步交付

- 已拉取并快进合并远端设备驱动更新，保留本地 Overlay 与巡检辅助标记优化，无合并冲突。
- 本次按用户要求不运行测试、构建或代码验证；下方原实现阶段的验证记录不代表对合并后版本重新验证。
- 使用中文标题和四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-19 按性能指南检测与外围优化

- 需求：按照 `babylon-perf-guide.md` 检测优化，保证参数化脚本和动作逻辑不变。用户选择复用现有大场景。
- 范围：仅优化 `DataPlatformScreenOverlay` 的同帧投影/临时对象/DOM 样式，以及 `EditorAutoPatrolRuntime` 的编辑辅助标记缩放和矩阵失效检查；不改画质、资源、消息顺序或动作频率。
- 计划与完整章节核对：`docs/tasks/2026-10-19-babylon-perf-guide.md`、`docs/babylon-perf-guide-audit.md`。
- 已验证：前后完整构建成功；新增定向测试 7/7；Electron 硬件 WebGL 正反向检查；36 屏生产 WebGL A/B/B/A，三视角截图全部一致，点击/尺寸/隐藏恢复/卸载通过；36 个受保护文件 SHA-256 全部一致。
- 已测收益：120 屏投影 DOMRect 240→2、稳定样式写 720→0；501 个巡检编辑标记静止 300 帧的缩放写入与世界矩阵更新 150300→0。36 屏相机移动时 Overlay 平均耗时 3.917→1.787 ms，两版约 60 FPS。
- 限制：旧 Vite SSR 入口部分导入超时，未完成断言不算通过。工厂首次优化版采样与 ESLint 重叠，已作废该轮性能数据并单独重采；完整加载和 iframe 功能检查成功。
- 最终回归：遮挡与跨域点击 12 项、透明标牌 9 项、巡检编辑真实操作 7 项均通过且无页面错误。巡检覆盖新增/覆盖、不同高度、聚焦和保存重开相机恢复。
- 工厂有效对照：相同场景/资源/视角/回放，1440×900、DPR 1、Intel UHD 630；单轮 15 秒静止 21.27→21.79 FPS，动作 18.42→18.74 FPS，后者均接收 290 条回放消息。P95 分别 57.2→54.2 ms、66.9→67.3 ms；单轮结果不支持稳定整场 FPS 提升或达到30/60 FPS的承诺。
- 当前状态：本轮检测、两项外围优化与针对性验收完成；全部记录见 `docs/babylon-perf-guide-audit.md`，证据保存在 `output/playwright/perf-guide-20261019/`。已释放本任务应用、浏览器和本机回放服务；未安装、发布、提交或推送。

## 2026-10-19 场景模型面数统计

- 目标：按已确认示意图，在场景属性“场景”分组的名称后加入模型总面数与可展开明细。
- 范围：普通/内置/组合模型、完整逻辑实例、环境、实际生成货箱；包含隐藏实体，排除编辑辅助、天空盒与线点；不随相机裁剪变化。
- 实施：运行时按业务登记计算并缓存有效几何，非持久化快照传递到面板；明确 loading/error，避免部分结果冒充总数。
- 验收清单：
  - [x] 12 面立方体、10 个立方体 120 面及阵列/变体计数正确，无宿主重算。
  - [x] 隐藏实体/父组、移动相机/裁剪后总数稳定；参数/环境/货箱/删除撤销自动更新。
  - [x] 三角形拓扑与线点/辅助排除正确；加载/错误/切换场景无误导性旧值。
  - [x] 按示意图实现总数与明细，实际浏览器操作验证、窄面板无溢出。
  - [x] 统计不影响 dirty/undo/序列化；定向测试、类型检查与相关文档完成。
- 当前状态：原实现阶段验收记录见下；2026-10-19 已合并远端更新，进入 Git 提交推送流程。本次交付按用户要求不运行测试、构建或代码验证；推送结果以本次交付回复为准。

### 修改与验证

- 面板：新增 SceneModelStatisticsPanel 与样式，在场景名称后挂载；说明与明细支持键盘，整数支持选择复制，加载/失败不展示部分总数。
- 数据：EditorStore 增加非持久化快照，SceneViewPanel按运行时与场景会话校验写回，同ID重开也主动发布首份结果。
- 计数：新增三角拓扑助手，SceneRuntime按逻辑实例、参数变体、生成物、Fetch实际货物和环境汇总；事件驱动缓存/微任务合并，不注册逐帧计数。环境与Fetch统一口径；特效代理使用源Mesh唯一ID避免重名误配。
- 文档：README说明入口与口径；docs/lessons.md记录全量与裁剪、同ID新会话快照两项经验。
- 新增回归：UI 4、状态 3、几何/环境 7、Fetch 6、核心运行时 11，共31项通过；相关既有加载就绪9、模型特效21、Fetch7项通过。
- 主线程组合命令：node --experimental-strip-types --test --test-concurrency=1 tests/runtime/modelTriangleStatistics.test.ts tests/runtime/locatorFetchTriangleStatistics.test.ts tests/editor/sceneModelStatisticsState.test.ts tests/editor/sceneModelStatisticsPanel.test.mjs tests/runtime/sceneModelReadinessError.test.ts（29/29通过）；核心运行时最终11/11由并行实现代理执行后冻结代码。
- 最终 npm run typecheck 通过；相关生产文件 ESLint 0错误、45条警告，与HEAD基线四个既有大文件警告数一致，新增文件无警告；git diff --check 通过。Impeccable新UI检测返回[]。
- 真实浏览器：Edge硬件WebGL2，Intel UHD630/ANGLE，现有真实SceneViewPanel/SceneSettingsPanel fixture，19项检查，pageErrors=[]。验证48/120立方体、隐藏与相机不变、删除撤销、合法本地场景文件阵列10+环境1=11、同ID/空场景重开、缺失模型失败与删除恢复、异步加载占位与完成更新、100立方体+环境1=1201、精确数字选择、键盘说明与明细、320px外侧面板无横向溢出。
- 证据：output/playwright/scene-model-statistics/result.json、implemented-panel.png、implemented-scene.png、narrow-320.png；模型字节为已知单三角面glTF，通过测试本地资源路由供真实加载器读取。
- 验证边界：本地源码、真实浏览器WebGL与NullEngine回归；未重打安装包，未验证已安装版本或现场远程资源。无本轮必要功能遗留。
