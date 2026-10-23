# 项目专项优化方案与实施计划

更新日期：2026-10-22（P2 方案修订，本轮未实施代码）

初始版本基线：`v0.3.44`（原计划快照：593 个源码文件，约 157,629 行代码；后续规模与性能以各阶段冻结清单为准）

本次修订仅更新 P2 的设计、实施顺序与验收口径。保留 P1/P3/P4 已完成状态、P2 已验证能力、旧 P2 清单和全部历史实测；新路线 P2-R0～P2-R5 均待实施。旧 P2 未达标项不因本次改写而转为完成，动静合批继续默认关闭。代码、测试入口、画质、脚本及设备动作本轮不变。

执行检查点（2026-10-21）：P1.1–P1.3 已实现并完成本地构建、专项及真实 Editor/Viewer 验证；详细命令、原始失败和验证边界见 [本轮执行记录](tasks/2026-10-21-project-optimization.md)。当前最终 Editor / Viewer initial JS 分别为 5,280,709 / 4,295,252 bytes，相对本文基线约减少 50.1% / 55.9%，主入口 3.77 / 3.70 MB。以上体积为P1阶段测量。P2已实施部分能力，整阶段验收未完成；P3模块解耦与P4类型安全/测试治理已完成本地验收，详见各阶段记录。16 包视觉回归的 4 个阈值失败仍保留，原 TS 与完整 Babylon 注册对照均重现，未用降低门槛换取通过。

---

## 一、 目标与实施边界（硬性契约）

本方案旨在系统性解决当前项目在**首屏构建体积、大场景运行帧率与中台打开耗时、万行级巨型模块维护成本、类型与测试工程门禁**四个维度的瓶颈。所有优化阶段必须严格遵守以下不可妥协的产品与技术契约：

1. **视觉与几何零降级**：
   - 保持 Babylon.js 硬件加速 WebGL 2、抗锯齿（MSAA/FXAA）、stencil、`GlowLayer` 与 `SelectionOutlineLayer` 选中描边；
   - 不降低渲染分辨率或 DPR，不引入方块/线框/低模等屏幕空间代理（`modelArrayProxyEntityCount` 等代理指标必须保持为 `0`），不删减模型顶点/索引拓扑，不强制开启会破坏开放曲面的背面剔除。
2. **参数化脚本与设备动作零破坏**：
   - 外置参数化脚本（`.model.ts`）与声明式参数绑定的生成几何、材质克隆与节点层级语义保持不变；
   - Stacker、Conveyor、RGV、Shuttle、Lift、HCLift 等 MQTT 遥测驱动算法、消息消费顺序、动作插值频率与运动箭头逻辑保持不变。
   - 保留脚本 constructor、`onStart/onUpdate/onStop`、参数值/类型、上下文与可观察节点身份、名称、父子链、回调 receiver 和副作用；不能以转译缓存或几何复用跳过这些行为，不能丢弃消息或降低动作更新频率。
   - 渲染表示调整须保留业务原件与每子部件的选择、显隐、故障材质、阴影及当帧变更回退；未知脚本/可变资源继续原路径，不能删除几何、材质、纹理身份或安全检查以扩大命中。
3. **场景格式与统一光照兼容**：
   - 保持 `.scene.json`（外层 `version: 1–6`）、米制单位契约（`1 scene unit = 1 m`）、`sceneSettings.lighting`（v2）与 `sceneSettings.appearance`（v1）完全兼容；
   - 保持 SOURCE / DIST 导出、数据中台增量同步与本地场景恢复的安全校验与签名边界。

---

## 二、 原计划历史基线与核心痛点诊断

本章保留原计划采样与当时诊断，不代表 P3/P4 后当前工作区的绝对性能或完整瓶颈。当前代码已有并发、缓存等改造；新 P2 必须按 P2-R0 冻结版本重新测量，不能直接用本章数字作改造前后对照。

### 2.1 构建产物与首屏包体基线（来自 `output/bundle-analysis` 与生产构建日志）

| 指标项 | Editor 构建产物 (`dist`) | Viewer 构建产物 (`dist-viewer-template`) | 根因诊断 |
| :--- | ---: | ---: | :--- |
| 总 Chunk 数量 / 总 JS 体积 | 104 个 / 14.13 MB (gzip 3.58 MB) | 104 个 / 13.30 MB (gzip 3.36 MB) | 存在大量碎小 shader chunk 与超大入口主 chunk 两极分化 |
| 首屏静态闭包 (`initial` JS) | 64 个 / **10.58 MB** (gzip 2.58 MB) | 64 个 / **9.74 MB** (gzip 2.36 MB) | 首屏同步加载了未用引擎子系统、MQTT 客户端及全部业务面板 |
| 主入口 Chunk (`assets/index-*.js`) | **10,105.9 KB** (gzip 2,472.8 KB) | **9,165.3 KB** (gzip 2,224.0 KB) | 110 处 `@babylonjs/core` 桶导入导致 Tree-shaking 失效 |
| TypeScript 编译器 Chunk (`typescript-*.js`) | **3,470.5 KB** (gzip 975.3 KB) | **3,470.5 KB** (gzip 975.3 KB) | 浏览器端运行时调用 `ts.transpileModule` 转译 `.model.ts` |
| 固定附带开场 WebP 静态资产 | 10 个文件 / **3,949.2 KB** | 10 个文件 / **3,949.2 KB** | `asset-1.webp`–`asset-10.webp` 无条件打入构建目录 |

**主入口 Chunk (`index-*.js`) 内部未使用的重型模块占比：**
- `@babylonjs/core/ShadersWGSL`：**804.9 KB**（项目仅使用 WebGL 2 GLSL，未使用 WebGPU WGSL）
- `@babylonjs/core/FrameGraph`：**509.1 KB**（未使用）
- `node_modules/mqtt`：**458.8 KB**（编辑态未开启预览或 Viewer 禁用 MQTT 时无需首屏加载）
- `@babylonjs/core/XR`（WebXR）：**412.8 KB**（未使用）
- `@babylonjs/core/FlowGraph`：**294.5 KB**（未使用）
- `@babylonjs/core/Physics`（含 Havok 插件）：**288.5 KB**（漫游使用自研 `ManualRoamCollisionProxyPool`，未用物理引擎）
- `webgpuEngine` + `thinNativeEngine` + `GaussianSplatting` + `openpbrMaterial`：**> 350 KB**（未使用）

### 2.2 大场景运行帧率与加载耗时基线（Intel UHD 630 / WebGL 2 实测）

| 场景与工况 | 关键规模指标 | 实测表现 | 核心瓶颈归因 |
| :--- | :--- | :--- | :--- |
| **真实工厂场景（1440×900）**<br>静止 / MQTT 动作回放 | 370–383 实体、3,743–3,913 Mesh、126+ 台 `motion` 设备 | 静止 **21.8 FPS** (P95 54.2 ms)<br>动作 **18.7 FPS** (P95 67.3 ms)<br>Draw Call **1,314–1,316** | 带 `dataDriven.motion` 的设备整机退出 `thinInstance` 合批（合批数为 0），主线程每帧遍历 3,700+ Mesh（`evaluateActiveMeshes` 约 9 ms，CPU frame 44 ms） |
| **真实工厂场景（4K 全屏）**<br>静止在线 / 完整动作 / 漫游 | 3840×2110, DPR 1 | 在线/动作 **8.8–10.4 FPS** (P95 115–124 ms)<br>漫游 **8.8–9.3 FPS** (优化碰撞后) | 1,300+ Draw Call 下的 CPU 调度开销叠加 4K 分辨率下的 GPU 填充率与阴影/PBR 采样压力 |
| **中台工程冷/暖打开**<br>（中鼎智能工厂） | 370 实体、77 项发布资源 | 冷打开 **84.0–92.1 s**<br>暖打开 **92.7–96.3 s** | 远端资源确认与准备串行门控、外置 `.model.ts` 脚本逐宿主转译与同步初始化、GPU 纹理与几何集中上传阻塞主线程 |

**2026-10-22 口径校正**：表中 3,743–3,913 是总 Mesh 规模；早期 1440×900 原始对照的 Active Mesh 为静止 1,514、动作 1,520。原方案后文“Active Mesh 约 3,800”混用了口径，不能据此声称 Active 从 3,800 优化到 1,527。旧约 18.7 FPS、P2 的 2560×1440/3840×2160 结果和本地/真实中台打开数据也不能跨条件直接比较。原始依据：[早期工厂对照](../output/playwright/perf-guide-20261019/factory-comparison.json)、[P2 采样与边界](tasks/2026-10-21-project-optimization-p2.md)。

### 2.3 核心巨型文件（God Modules）基线

| 排名 | 文件路径 | 行数 | 体积 | 主要耦合问题 |
| :---: | :--- | ---: | ---: | :--- |
| 1 | `src/runtime/babylon/SceneRuntime.ts` | **10,744** | 500.2 KB | 集成了模型加载、合批协调、光照/外观、环境/天空盒、CAD、POI/大屏/巡检/漫游/箭头、拾取高亮、Gizmo、统计与性能监控 |
| 2 | `src/editor/store/editorStore.ts` | **6,418** | 283.9 KB | 单一 Zustand Store 囊括文档 CRUD、撤销栈、选择、资产库、中台同步、发布事务、光照草稿与运行预览状态 |
| 3 | `src/editor/panels/SceneViewPanel.tsx` | **3,374** | 160.4 KB | 视口生命周期、快捷键、拖放导入、工具栏浮窗、漫游/巡检控制与状态遮罩混写 |
| 4 | `src/runtime/babylon/EntityArrayThinInstanceBatch.ts` | **2,998** | 124.8 KB | 批次构建、参数变体宿主、空间分片、视锥裁剪、拾取反查与光照接收隔离集中在单文件 |
| 5 | `src/editor/panels/ProjectPanel.tsx` | **2,521** | 120.4 KB | 模型、组合、环境、天空盒、开场包、图片、图表七类资产页签及中台同步交互耦合 |
| 6 | `electron/ipc/dataPlatformModelIncrementalSync.ts` | **2,021** | 85.0 KB | 增量计划、下载、解压、校验与事务恢复集中 |
| 7 | `src/runtime/babylon/telemetry/specialized/stackerDriver.ts` | **1,731** | 90.0 KB | 堆垛机寻址、多轴运动、货叉取放货、安全门控与缓存耦合 |
| 8 | `electron/ipc/dataPlatformProjectService.ts` | **1,654** | 80.4 KB | 项目打开、远端清单同步、重关联与本地索引管理集中 |

### 2.4 代码质量与测试工程基线

- **残留同名 `.js` 编译产物**：`src/shared/ids.js`、`src/editor/model/autoPatrol.js`、`src/assets/imageAssets.js` 与对应 `.ts` 源文件并存。
- **类型检查与 Lint 警告**：`tsconfig.quality.json` 的 `noUnusedLocals` 仅覆盖 1 个文件（全仓开启仍有 34 处 `TS6133`）；ESLint 0 error，但存量 **181 条 warning**。
- **测试入口覆盖率**：743 个测试/smoke 候选中，**302 个无静态 npm 入口或未确认**，CI 静态可达 153 个；少量测试在 Vite SSR 导入大模块时存在超时。

---

## 三、 四大专项优化方案

### 专项一：构建产物瘦身与按需加载（Bundle & Code Splitting）

#### 1.1 消除 `@babylonjs/core` Barrel Import 与无效动态导入
- **改造内容**：
  - 将 `src/` 与 `electron/` 中的 110 处 `from '@babylonjs/core'` 替换为精确的 ESM 子模块路径导入（例如 `@babylonjs/core/scene.js`、`@babylonjs/core/Meshes/mesh.js`、`@babylonjs/core/Maths/math.vector.js`），纯类型导入统一改为 `import type { ... } from '@babylonjs/core'`。
  - 修复构建日志中的 3 处 `[INEFFECTIVE_DYNAMIC_IMPORT]`：
    - `src/runtime/babylon/lightingGeometry.ts` 中对 `@babylonjs/core/index.js` 的动态导入改为具体子模块静态/动态一致导入；
    - `src/runtime/babylon/sceneSelectionHighlight.ts` 中对 `glowMapMerge.vertex` 的导入与 Babylon Layer 导入方式对齐。
  - 在 `eslint.config.js` 中对业务代码启用 `no-restricted-imports`（禁止非 `import type` 的 `@babylonjs/core` 根路径导入），防止后续回退。
- **涉及范围**：`src/runtime/**`、`src/editor/**`、`src/player/**`、`eslint.config.js`。
- **预期效果**：直接从 Editor 与 Viewer 首屏主 chunk 剔除 `ShadersWGSL`（805 KB）、`FrameGraph`（509 KB）、`XR`（413 KB）、`FlowGraph`（295 KB）、`Physics/Havok`（289 KB）、`webgpuEngine` 等未用代码，预计减少首屏未压缩 JS 体积 **3.0–3.5 MB**。

#### 1.2 外置 `.model.ts` 参数脚本预转译与 TypeScript 编译器剥离
- **改造内容**：
  - **导入与构建期预转译**：在 Electron 端扫描/导入模型包（`electron/ipc/modelPackageScanner.ts`）、刷新资产索引（`scripts/refresh-model-asset-index.mjs`）以及导出部署包（`electron/ipc/deploymentExportScene.ts`、`digitalTwinDistPackage.ts`）时，利用 Node 端 TypeScript 将 `.model.ts` 预转译为 `.model.js`（附带源文件 SHA-256 校验头），或在包元数据中生成预编译缓存。
  - **运行时优先加载预编译脚本**：`src/runtime/babylon/externalModelScriptLoad.ts` 优先请求或读取预转译产物；仅当本地开发态直接指向未预转译的 `.ts` 且无缓存时，才通过 `await import('typescript')` 懒加载编译器。
- **涉及范围**：`src/runtime/babylon/externalModelScriptLoad.ts`、`electron/ipc/modelPackageScanner.ts`、`electron/ipc/deploymentExportScene.ts`、`scripts/refresh-model-asset-index.mjs`。
- **预期效果**：常规运行与独立 Viewer 完全规避下载、解析和执行 **3,470.5 KB**（gzip 975 KB）的 `typescript` chunk，同时消除场景打开时的浏览器端即时 TS 编译 CPU 开销。

#### 1.3 重型第三方库与二级弹窗按需拆包
- **改造内容**：
  - **MQTT 按需加载**：将 `src/runtime/mqtt/MqttStackerTelemetryClient.ts` 与 `MqttConnectionTest.ts` 中的 `mqtt`（458.8 KB）改为在实际建立连接或点击测试时动态 `import('mqtt')`。
  - **编辑器二级重型模块 `React.lazy` 化**：对 Toolbar / Inspector 触发的低频重型弹窗（光照与烘焙管理器、部署导出对话框、中台发布对话框、人物预览弹窗、CAD DXF 解析器）实施 `React.lazy` + `Suspense` 拆分。
  - **构建分包策略优化**：在 `vite.config.ts` 与 `vite.viewer.config.ts` 中配置合理的 `manualChunks` / `codeSplitting`，避免生成上百个 0.1–1 KB 的超碎 shader chunk，同时将首屏核心 runtime 与低频工具解耦。

---

### 专项二修订：按实测分离默认帧成本、加载关键路径与受限渲染实验

- **已完成能力保留**：实际授权 TS 内容/编译器版本的 HMAC 持久转译缓存、宿主 FIFO 分帧、按包有界下载/校验、精确几何身份缓存、受控矩阵冻结和 Gizmo 轻预览/结束一次命令；功能证据不等于整个 P2 性能已达标。
- **优先处理关闭态成本**：当前 `SceneTelemetryController.initializeMotionStaticBatchRuntime` 无条件构造实验运行时；OFF 只使 `getDocument()` 返回空，构造仍接管候选/冻结入口并注册 Observer。先设计真正不构造、不安装的关闭路径，再衡量其成本，不能把现有 OFF 叫作零机制基线。
- **缓存、调度、几何复用分别设计**：转译命中不消除每宿主 constructor/onStart；分帧仅能在任务之间让出，不能抢占任意同步脚本。跨会话通用几何模板改为有纯净性及依赖证明才能推进的研究项，未知脚本仍完整执行。
- **加载按关键路径优化**：当前已有最多 4 个资源准备、环境并行及资源内部 4 下载/2 校验。先追踪跨层等待、重叠、任务/字节预算和主线程 CPU，再优化；保持版本二次确认、授权、size/SHA、完整索引和原子推广/回滚。
- **合批限定试点**：先评估单设备内部、同材质/顶点布局/渲染状态的固定真实几何聚合，再研究相同聚合结果跨设备实例化。复用现有 `thinInstanceStaticGeometry` 能力作为研究起点，保留原件、细粒度映射与空间剔除；不能直接打开 merge 选项或删几何条件上线。
- **以真实体验验收**：默认产品帧间隔、有效 FPS、长任务、打开耗时和交互延迟为主；总 Mesh、Active、各 pass Draw、三角形和缓冲字节用于解释收益。具体步骤、数值门槛与停止条件统一见第四章 P2-R0～P2-R5。

<details>
<summary>原专项二设计全文（历史保留，当前执行以 P2-R 路线为准）</summary>

### 专项二：3D 运行时与大场景加载/渲染性能优化（Runtime & Rendering）

#### 2.1 动态设备（`dataDriven.motion`）“动静部件分离实例化”
- **问题背景**：
  - 当前 `SceneSerializer` 与 `SceneRuntime` 对包含 `dataDriven.motion` 的模型（如工厂中的 118+ 台链条机、提升机、直角接驳机）采取整机排除合批策略。但每台设备中 80% 以上的 Mesh 是完全静止的机架、支腿、护栏、电机壳体，只有载货台、货叉、输送面箭头等少数子部件在 MQTT 驱动下发生变换。
- **优化设计**：
  - **复用既有部件角色解析器**：复用统一光照分类系统已建立的“固定结构 vs 运动部件”稳定节点识别能力（`lightingClassificationRuntime` 及各专门驱动的角色声明），在不修改外置参数脚本的前提下识别每个模型包内的静态子 Mesh 与动态子 Mesh。
  - **静态子 Mesh 共享 ThinInstance 批次**：同一参数组合（`parameterValues` 签名相同）的动态设备，其静态结构子 Mesh 统一纳入 `EntityArrayThinInstanceBatch` 共享矩阵缓冲渲染，并保持按 `thinInstanceIndex` 反查逻辑实体 ID、单实例选中描边（`instancedSelectionBuffers`）与显隐控制不变。
  - **动态子 Mesh 保留独立驱动节点**：仅对需要逐帧位移/旋转/变色/显隐的运动部件保留轻量级实例节点或专用动态批次，由原有 `stackerDriver` / `conveyorDriver` / `shuttleDriver` / `liftDriver` 驱动。
- **安全边界**：
  - 若某个参数脚本或驱动会在运行期动态修改静态部件材质（如整机故障变色 `appearanceColor`）或顶点，则按材质状态或驱动声明保守保留独立通道，绝不造成实例串色或动作丢失。
- **预期效果**：370 实体真实工厂场景的 Active Mesh 从 ~3,800 降至 **< 1,000**，Draw Call 从 ~1,314 降至 **< 400**，显著降低 CPU `evaluateActiveMeshes` 与驱动遍历耗时，提升 1440p 与 4K 下的稳态 FPS。

#### 2.2 编辑态与运行态主线程 CPU 帧开销削减
- **静态世界矩阵按需冻结**：
  - 对已完成加载与放置的静态环境 Mesh、以及无变换更新的静态 `EntityArrayThinInstanceBatch` 宿主 Mesh，在世界矩阵同步后执行受控冻结，仅在实体 Transform、父级文件夹变换、参数更新或场景重同步时解冻刷新，减少每帧冗余矩阵计算。
- **单体 Transform Gizmo 拖拽状态节流**：
  - 当前 `TransformGizmoController.ts` 在拖拽单个对象时每帧高频写回 Zustand Store，触发关联 React 面板重渲染。
  - 优化为：拖拽移动/旋转/缩放期间优先直接更新 Babylon 运行时节点与轻量级坐标预览，Inspector 输入框通过节流（如 `requestAnimationFrame` 合并或 30–60 Hz 局部状态）刷新，松开鼠标（`onDragEnd`）时一次性生成可撤销 Command 并提交 Store。

#### 2.3 中台工程打开与场景加载管线加速
- **参数脚本与模板初始化加速**：
  - 对外置脚本编译结果与参数变体几何模板建立跨会话内容哈希缓存（基于 GLB SHA-256 + 脚本 SHA-256 + `parameterValues` 规范化签名）；
  - 同一场景内数十个同模板模型初始化时，严格通过 `ModelInitializationScheduler` 分帧执行脚本宿主求值，避免单帧阻塞超过 50 ms。
- **中台资源准备并发流水线化**：
  - 在 `dataPlatformSceneResourcePreparation` 与 `dataPlatformModelIncrementalSync` 中，保持原有的版本/签名安全校验不变，将“远端元数据校验 → 资源包流式下载 → 解压落盘 → 纹理/GLB 预热”由全量阶段阻塞改造为按包依赖的流水线调度，充分利用磁盘 I/O 与网络带宽重叠。

---

</details>

---

### 专项三：核心巨型模块（God Modules）渐进式解耦重构

重构遵循**“先抽离纯函数与子控制器、保持原类/Store 门面（Facade）签名不变、每步通过现有单测与集成测试”**的原则：

#### 3.1 `src/runtime/babylon/SceneRuntime.ts`（10,744 行 → 目标主文件 < 2,000 行）
按领域边界拆分为 `SceneRuntime` 协调器 + 6 个高内聚子模块：
1. `ModelAssetRuntimeController.ts`：负责普通/静态共享/独占容器模型的加载、卸载、参数脚本执行与生命周期。
2. `EnvironmentAndSkyboxController.ts`：负责环境 GLB 变体切换、HDR/EXR 天空盒解码预滤波与 IBL 绑定。
3. `ScenePickingAndSelectionController.ts`：负责点击拾取、框选、薄实例索引反查与 `SelectionOutlineLayer` 高亮同步。
4. `ScenePoiAndEffectsController.ts`：负责 POI、大屏叠加层桥接、报警管理器、设备生成器、开场特效与运动箭头系统挂载。
5. `ScenePatrolAndRoamController.ts`：负责自动巡检路线编辑辅助、巡检回放与手动漫游运行时的切换协调。
6. `SceneTriangleAndReadinessController.ts`：负责全场三角面统计、首帧资源就绪门控与加载诊断报告生成。

#### 3.2 `src/editor/store/editorStore.ts`（6,418 行 → Zustand Slice 化）
将单一巨型文件拆分为 `src/editor/store/slices/` 下的领域 Slice，在 `editorStore.ts` 中聚合，保持 `useEditorStore` 全部外部调用零改动：
1. `sceneDocumentSlice.ts`：场景新建、打开、保存、实体/组件增删改与 CommandHistory 撤销重做。
2. `selectionAndViewportSlice.ts`：选中实体集合、Gizmo 模式/空间/吸附、相机视图与全屏状态。
3. `projectAssetsSlice.ts`：本地模型、环境、天空盒、CAD 与图片资源库状态。
4. `dataPlatformAndPublishSlice.ts`：中台项目绑定、模型增量同步事务、SOURCE/DIST 发布状态与恢复门控。
5. `lightingManagerSlice.ts`：统一光照（`lighting v2` / `appearance v1`）草稿、分类规则、例外暂存与烘焙任务状态。
6. `runtimePreviewAndTelemetrySlice.ts`：运行预览开关、MQTT 状态、性能监控快照与巡检/漫游会话状态。

#### 3.3 `SceneViewPanel.tsx`（3,374 行）、`EntityArrayThinInstanceBatch.ts`（2,998 行）与 `ProjectPanel.tsx`（2,521 行）
- **`SceneViewPanel.tsx`**：抽离 `useSceneKeyboardShortcuts`、`useSceneAssetDropHandler`、`useSceneCameraTransition`、`SceneViewportOverlays`（漫游/巡检/状态栏/性能 HUD 挂载层），使主面板专注 Canvas 与 Engine 生命周期。
- **`EntityArrayThinInstanceBatch.ts`**：拆分为批次矩阵缓冲计算（`thinInstanceMatrixBuilder.ts`）、参数变体隐藏宿主管理（`parameterVariantHostPool.ts`）与批次视锥/拾取管理。
- **`ProjectPanel.tsx`**：按资产类型拆分为 `ModelLibraryTab.tsx`、`CompositionLibraryTab.tsx`、`EnvironmentLibraryTab.tsx`、`SkyboxLibraryTab.tsx`、`OpeningPackageTab.tsx` 等独立页签组件。

#### 3.4 Electron IPC 场景资源收集与重写逻辑统一
- 提炼 `electron/shared/sceneResourceTraversal.ts`，统一 `deploymentExportScene.ts`（1,506 行）、`digitalTwinSourcePackage.ts`（1,186 行）、`localSceneResourceRecovery.ts` 中重复的实体组件资源引用扫描（模型、环境、天空盒、CAD、生成器目标、报警目标、漫游人物、点击事件绑定、光照规则资源）与 URL 重写逻辑，确保新增组件类型时一处修改、处处生效。

---

### 专项四：代码质量、类型安全与测试工程治理

#### 4.1 清理源码目录残留 `.js` 文件与构建防呆
- 核对并删除 `src/shared/ids.js`、`src/editor/model/autoPatrol.js`、`src/assets/imageAssets.js`（确认其逻辑与同名 `.ts` 完全一致；保留 `src/runtime/opening/reference/` 下有意维护的纯 JS 参考实现或为其补齐类型声明）。
- 在 `scripts/build-typescript.mjs` 或 lint 检查中加入守卫：禁止 `src/` 下出现存在同名 `.ts`/`.tsx` 的衍生 `.js` 文件。

#### 4.2 全仓 TypeScript 严格检查与 ESLint Warning 渐进清零
- **TypeScript 严格规则收口**：
  - 清理 renderer 端 30 处、Electron 端 4 处未使用局部变量/导入（`TS6133` / `TS6192` / `TS6196`）；
  - 将 `noUnusedLocals: true` 正式写入 `tsconfig.json` 与 `tsconfig.node.json`。
- **ESLint Warning 分批治理（当前 181 条）**：
  - 第一批（正确性高风险）：清零 `react-hooks/exhaustive-deps`、`preserve-caught-error`、`no-useless-assignment`、`no-unsafe-finally` 并升为 `error`；
  - 第二批（类型与死代码）：清零 `@typescript-eslint/no-unused-vars`、`@typescript-eslint/no-unused-expressions`；
  - 第三批（类型精确化）：为 MQTT 载荷解析、Babylon 扩展 `metadata` 建立明确接口定义，将 `@typescript-eslint/no-explicit-any` 压降 80% 以上。

#### 4.3 测试体系收敛与 SSR 超时修复
- **修复 Vite SSR 导入超时**：
  - 定位三个原入口的真实依赖图并复现 Vite SSR fetchModule transport 60s 超时；以测试专用真实 SSR 图构建和原生外部依赖加载修复边界，保留原断言/门槛。P4实测纯本地模块图也可超时，因此不将 Babylon 整包转换写作已证实的内部根因。
- **收敛 302 个未确认入口的测试候选**：
  - 对 `docs/test-inventory.md` 中的 302 个无静态入口文件按领域归类：属于核心契约的并入 `package.json` 对应 `test:*` / `smoke:*` 入口并同步 `scripts/test-entry-manifest.json`；属于已退役功能（如旧主题、旧太阳阴影）或一次性临时脚本的，经确认后归档或清理。

---

## 四、 分阶段实施路线图与验收清单（Roadmap & Checklist）

### Phase 1 (P1)：工程卫生与构建体积速赢（预计低风险、最快见效）
- [x] **P1.1** 删除 `src/` 下与 `.ts` 重名的残留 `.js` 文件（`ids.js`、`autoPatrol.js`、`imageAssets.js`），增加同名产物检查守卫。
- [x] **P1.2** 完成全仓 110 处 `@babylonjs/core` barrel import 向深层子路径导入的迁移，修复 3 处 `[INEFFECTIVE_DYNAMIC_IMPORT]`，并启用 ESLint `no-restricted-imports` 守卫。外置 namespace / 其它 API 保留惰性完整兼容，普通 glTF1 与 glTF2 全扩展能力保留。
- [x] **P1.3** 实现 `.model.ts` 导入/导出期 Node 预转译与独立 sidecar 缓存；renderer compiler 仅保留开发裸 TS、旧包及损坏缓存兼容兜底。`mqtt`、重型 Dialog 与精确 DXF parser 按需加载。旧发布包兼容属于本文硬性边界，因此不把兜底限制为开发态。
- [x] **P1 验收指标**（本地门禁与生产 Editor/Viewer 验证完成，证据及后续视觉问题见执行记录）：
  - `npm run build` 无 `INEFFECTIVE_DYNAMIC_IMPORT` 警告；
  - Editor 与 Viewer 首屏 `initial` JS 体积下降 **35%–50%**（主入口 chunk 从 ~10 MB 降至 **< 5.5 MB**）；
  - Viewer 打开已发布工程不再请求 `typescript-*.js`（节省 3.47 MB）；
  - `npm run typecheck`、`npm run lint`、`npm run test:ci`、`npm run analyze` 全部通过。

### Phase 2 (P2)：以实测为依据的分阶段优化（2026-10-22 修订）

**状态与授权边界**：P2-R0 已按单独授权完成本地计量校准、完整冻结和 B0 验收，证据见 [P2-R0 执行记录](tasks/2026-10-22-project-optimization-p2-r0.md)。R1～R5 尚未实施；R0 只表示当前基线可测量。P1/P3/P4、旧 P2.4 与旧 P2.1～P2.3/总验收状态保留，不据此宣告性能收益或补勾旧目标。

#### P2-A 已有成果与历史证据保护

| 原项目 | 保留成果与当前状态 | 尚未证明的部分 |
| --- | --- | --- |
| P2.1 | 已验证的授权 TS 内容/编译器版本持久转译缓存、HMAC 认证、容量约束、坏缓存回退和 FIFO 宿主调度继续保留 | 转译命中不消除每宿主 constructor/onStart；通用跨会话几何复用未实现；任意同步 onStart 的硬 50ms 保证不成立 |
| P2.2 | 已验证的按包 4 下载/2 校验、取消、排空、完整索引、版本确认及原子推广/回滚继续保留 | 整条真实中台打开关键路径与冷/暖各下降 30% 尚未验收；当前已有多层并发，不能继续按全串行现状设计 |
| P2.3 | 保留实验实现、身份/照明/阴影/可变 GPU 源当帧回退的功能证据，默认开关仍为 false | 实验性能不达标；OFF 仍构造运行时并安装钩子，尚无真正零机制基线；不能直接作为默认产品路径晋级 |
| P2.4 | **已完成，保持完成**：受控矩阵冻结、Gizmo 实时轻预览、结束一次命令、取消与撤销/重做 | 不用编辑交互通过替代工厂运行帧率验收，不扩大冻结范围追指标 |

历史采样固定为 **2026-10-21 的同版本实验**，保留原报告，不回填为 P3/P4 当前绝对 FPS，也不解释为整个 P2 相对 P1 的净收益：

| 历史帧缓冲 | 旧 OFF 中位 FPS | 旧 ON 中位 FPS | 相对变化 | 计时窗口 Draw / Active 中位数 |
| --- | ---: | ---: | ---: | --- |
| 2560×1440 | 5.7428 | 2.9003 | −49.50% | 1319 / 1527 → 1315 / 1523 |
| 3840×2160 | 4.3238 | 2.6756 | −38.12% | 1319 / 1527 → 1315 / 1523 |

- 每分辨率为 OFF/ON/ON/OFF、4×60 秒，每段 1,222 条消息；旧 OFF 是实验关闭，不是未安装实验机制。候选 provider/freeze 仍被接管，不能当成完整冻结 P1。
- 910 候选、729 桶、706 单例、23 共享桶/204 逻辑原件、728 种几何内容的诊断保持。204 不等于少 204 次可见 Draw；计时中位数少 4 与计时后单诊断帧净少 5 分开记录，不能删除几何条件把不同几何算作共享。
- 旧 1440×900 的约 18.7 FPS 与上述两种帧缓冲不混比；冻结 P1 未在原 ready 门槛内完成，缺完整同条件 P1 对照。历史本地冷/暖 83.820/84.901 秒、4K 冷 83.276 秒未清 OS 文件缓存，不替代真实中台 30% 目标。
- 128.392 秒的旧加载 profile 对应 85% 准备失败、`passed=false`；其中约 14.6 秒 hash、18 秒监视仅作旧热点线索，后续缓存已变，不能当当前占比、成功加载耗时或可相加的收益预算。GPU 时间全部为 null，不能据此断言 GPU 瓶颈；CPU frame 与 Active Evaluation 属包含关系，不能相加。
- 原 16 包视觉结果为 12 通过/原 4 失败同值且无新增失败；保留原阈值和动态纹理遮罩边界。94 topics 的录制含 92 conveyor、1 stacker、1 rgv，不扩称所有设备轨迹现场 100%。历史 179/179 回归不替代性能验收。

原记录与原始数据：[P2 执行记录](tasks/2026-10-21-project-optimization-p2.md)、[最终历史采样摘要](../output/project-optimization-p2-20261021/final-factory-summary.json)、[早期 1440×900 对照](../output/playwright/perf-guide-20261019/factory-comparison.json)。旧执行记录、修订前快照、原始失败和完整实验目录保持原字节；本节之后的新输出另设目录，禁止覆盖历史文件。

#### P2-B 实施顺序与阶段交付

顺序为 **R0 → R1 → R2/R3 → R4（有条件研究）→ R5**。R2 与 R3 可独立实现，但所有性能采样串行隔离；R4 只有明确收益空间才实施。每次只引入一个可归因的变更，先独立验证再组合。R0 已按本节完成；R1～R5 的入口与步骤仍为后续方案，尚未实施。

- [x] **P2-R0：冻结版本、校准计量和建立基线 B0**
  - 前置：P3/P4 已验收能力可复用；并行 GLB 等其他任务须先收敛纳入冻结版本，或在整轮比较期间排除，禁止中途混入工作区变化。
  - 步骤：为完整源码/构建产物、依赖版本、场景、资产、相机、质量、硬件/供电、帧缓冲/DPR、回放及 ready/超时门槛存指纹。将当前默认版本记为 **B0**，明确它仍可能含旧 OFF 钩子。记录从未连接、已连接且静止、持续动作、断流等待原超时四种不同业务状态，不人为清零或跳过消息。
  - 计量：复用 `ScenePerformanceMonitor.ts`、`FrameTimingWindow.ts`，校准既有 lastSecAverage 初始化 warning 和计数器缺失处理；缺失记 null/不可用，不能补 0。FPS/帧间隔以真实 afterRender 单调时钟计算，CPU 分项标明包含关系；GPU 不可用时不得编造 GPU ms 或据此定位纯 GPU 瓶颈。历史 `factory-abba.mjs` 仅为参考，须先核对 P3/P4 后入口兼容，不能直接把旧私有探针视为可用的新基线工具。
  - 交付：新的基线清单、阶段 trace、原始帧间隔/消息时间线、指标准确定义、不可用项及共享任务/字节预算表；已有 harness 输出不覆盖。预算须在对应实现实验前填入明确数值并冻结，不能按跑出结果回填。
  - 验收：B0 在原资源/ready/超时门槛内真实就绪，身份/三角形/参数/脚本/输入回放指纹齐全，所有必需字段有真实来源；校准 FPS、Draw、Active 与原始数据可互核。未 ready 或关键计量失效即阻塞性能判断，保留失败，不降低门槛。R0 通过只表示可测量，不表示已有性能收益。
  - 2026-10-22 实施结果：2 分辨率×4 状态×60 秒有效窗口、双时间线帧数/FPS 精确互核；默认 false/旧钩子保留，新增只读原生节点补核不混入性能数据。未来字节预算已在候选实验前冻结；GPU/真实显存与真实中台未知项明确保留。检查、原始失败与边界见 [执行记录](tasks/2026-10-22-project-optimization-p2-r0.md)。

- [ ] **P2-R1：真正无实验机制的关闭路径与生命周期**
  - 前置：R0 的 B0 冻结完成。
  - 入口：`SceneRuntime.ts`、`scene-runtime/SceneTelemetryController.ts`、`MotionStaticBatchRuntime.ts`。
  - 步骤：默认 OFF 不构造实验运行时、不安装候选/冻结/GPU 上传钩子或该模块 Observer，不复制/过滤候选，也不进入其校验/同步。显式 ON 才创建；ON→OFF/销毁完整释放载体、抑制、照明/阴影/选择映射，并按所有权恢复入口。保留公共 API、原渲染回调顺序；延迟启用仅登记自身已知 Observer，不能重新全量 capture 把未知脚本提升为可信。
  - 交付：关闭/启用/关闭恢复/重开/释放及外部接管的回归，新的无机制默认基线 **A1**。分别报告 B0 旧 OFF→A1、同一新 build OFF↔ON，不能混成一项收益。
  - 验收：新 OFF 的该模块实例/Observer/包装入口/载体/抑制原件数均为 0；原 provider 与 freeze/unfreeze 身份不因 OFF 改变，无该模块候选复制/扫描。反复切换后原件对象、父子链、材质、拾取、阴影和当帧恢复正确，外部接管的方法不被抢回。A1 相对 B0 不超过本节预定性能噪声带；无机制成本的实际节省如实报告，不预承诺幅度。

- [ ] **P2-R2：默认路径 CPU 热点与调度响应性**
  - 前置：A1 真实默认路径就绪；只使用当前版本独立 profile/trace 定位，不用旧失败 profile 配预算。
  - 入口：`lightingClassificationRuntime.ts`、`lightingRuntimeResources.ts`、相关 `scene-runtime` Controller、`modelInitializationScheduler.ts`、`ExternalModelScriptRuntime.ts`。
  - 步骤：区分脚本/遥测、候选评估、几何/材质身份、矩阵、临时对象、阴影及 DOM/React 成本；优先消除同一边界内重复工作。受控资源可用精确缓存/有证据的失效通知；未知直接写数组/材质/场景的脚本保留原校验和原绘制，不能降检查频率或只信 revision。
  - 调度：保留完整 constructor/onStart/onUpdate/onStop；FIFO 与 6ms/最多 4 宿主的**软**预算仅用于初始化宿主，只在初始化任务之间让出，onUpdate/onStop 仍按原帧/原释放路径调用。记录 maxTaskMs/maxSliceMs、超 50ms 单任务及长任务分布；单任务超限必须上报，不因无法抢占而伪造任务低于 50ms。通用跨会话几何复用暂为研究项，仅有纯净性/依赖/身份及副作用证明的描述数据可单独试验。
  - 交付：每次一个热点的调用/分配/自耗时对照、失效与同帧变化回归、完整默认路径帧间隔对照。profile 与正式计时分别运行，CPU 嵌套区间不得重复计入收益。
  - 验收：原输出、调用顺序、取消/后台/无 rAF 收敛、回调 receiver 和设备频率保持；被优化阶段确有工作减少且整帧不越性能噪声带。是否满足整阶段 15% 主指标在 R5 判定，不能用局部调用下降直接宣称工厂 FPS 达标。

- [ ] **P2-R3：完整打开关键路径与共享预算**
  - 前置：R0 明确中台/离线、冷/暖、起止点、缓存层和资源版本；R1 对关闭态干扰已分离。R2/R3 可独立推进，不并行采样。
  - 入口：`dataPlatformProjectService.ts`、`dataPlatformModelIncrementalSync.ts`、`boundedAssetPipeline.ts`、`modelScriptCompiler.ts`、`modelScriptPersistentCache.ts`、渲染端模型/环境准备 Controller。
  - 步骤：trace 串联元数据确认→下载→size/SHA→解压/扫描/预编译→快照固定/二次确认→原子提交→GLB/脚本/纹理/GPU 上传→ready 稳定，区分等待和重叠而非简单相加。核对现有外层 4 资源、环境并行、内层 4 下载/2 校验的真实全局峰值，再按冻结的任务/连接/待校验字节/临时磁盘及上传预算调度，避免盲目增加并发。
  - 缓存：保留授权原 TS 读取、实际内容/编译器版本校验、HMAC、容量/过期、并发与坏缓存回退；独立进程暖命中 compilerLoads=0/compilations=0 只验转译缓存，不替代脚本初始化或整链路验收。保留所有安全二次确认、完整索引、排空、取消和原子推广/逆序回滚。
  - 交付：各阶段关键路径、峰值/预算、冷暖原始序列、失败/取消/重试率和端到端对照；提前估算可优化上界。上界不足 30% 时报告瓶颈和停点，不承诺仅靠并发达到目标，不删除安全成本追数值。
  - 验收：真实中台冷/暖端到端中位耗时分别下降至少 30%，按 P2-C 的独立样本与最慢值规则判断；资源/版本/来源及恢复结果一致，失败率不增加。没有真实中台条件则该项保持未验证，可继续离线及其他独立工作，但整阶段不能勾选完成。

- [ ] **P2-R4：单设备固定真实几何聚合试点（有条件研究）**
  - 前置：R1/R2 的默认成本已清楚，有明确受支持模型、固定角色/副作用边界和合法收益空间；收益估计须覆盖当前可见提交及阴影等 pass，不把逻辑对象数量当 Draw。
  - 入口：`MotionStaticBatchRuntime.ts`、`thinInstanceStaticGeometry.ts`、`EntityArrayThinInstanceBatch.ts` 及相应身份/阴影/显隐映射；复用已有真实 VertexData 聚合能力，不直接切换 merge 参数上线。
  - 步骤：只选一个真实模型和小样本，按 entity/material/顶点布局/呈现状态聚合不同的固定真实几何，再评估重复聚合结果的实例化；保留业务原件、每子部件选择/显隐/故障材质、负/非均匀缩放、空间分块/逐实例剔除及同帧变更回退。严格保持三角形和画质；未知可变脚本继续原路径。
  - 交付：合法覆盖率、各 pass 可省提交上界、检查/上传成本、真实几何/矩阵/索引映射、JS 峰值与新增 buffer 字节、同一 build OFF/ON 小样本结果。跟踪 buffer 分配字节不冒充 OS 真实显存占用。
  - 晋级/停止：先用 1 块 ABBA、每段 60 秒做筛选；功能全通过且主帧间隔 P50 改善至少 10%、有效 FPS 同向提高、P95/P99 不越 5% 噪声带、资源预算未超限，才扩大到真实工厂并进入 R5 重验。无净收益、合法覆盖不足或正确性/尾延迟失败即停止扩展，默认 false 保持；不能删保护条件追覆盖率。局部通过不等于默认启用，实际晋级需完整默认配置达到 R5 门槛。
  - 若无合适候选或实验止损，记录研究未交付/暂缓。R4 不强制成为主路线，CPU 与加载路线可以独立完成；未上线的实验不能计入最终默认产品收益。

- [ ] **P2-R5：整阶段默认版本验收与归档**
  - 前置：R0～R3 完成、候选实现及默认开关冻结；R4 有交付则纳入全套验收，无交付则明确暂缓。缺真实中台等必要条件时保留整阶段未验收。
  - 步骤：先跑受影响的静态/契约/集成/实机功能门禁，再隔离采样；分别保存 B0→A1、同一 build OFF↔ON、B0→最终默认版本三类对照。不能把 R4 ON 的局部收益归给仍关闭它的产品，也不能把 R1 收益归给合批。
  - 验收：满足下列 P2-C 全部必需条款；已登记关键动作用例全通过、画质与参数保真证据齐全、真实中台冷暖达标、最终默认帧性能达标后，才标新路线完成。旧清单、历史负收益和缺证状态保持原文，不通过换指标补勾旧 P2。

#### P2-C 统一采样、数值门槛与交付判定

以下数值是**本次修订的未来验收目标，尚未测得，也不是收益承诺**。全部比例以对应冻结基线计算，不能事后放宽或挑选好段；需要更改目标时须有独立依据、先更新方案再重新完整对照，不能追认已失败的结果。

| 验收面 | 输入、统计与门槛 |
| --- | --- |
| 默认运行主指标 | 370 实体主场景，持续动作回放，分别验证 2560×1440 与 3840×2160、DPR1、同硬件/相机/质量。**最终默认版本相对 B0，帧间隔 P50 各下降至少 15%，有效 FPS 必须同向提高**。两者独立计算，不能将 P50 降 15% 写成 FPS 升 15%。 |
| 尾延迟与辅助工况 | 持续动作 P95/P99 的汇总及每块配对结果不超过基线 105%；这是预先固定的 **5% 性能噪声带**，不是画质或业务容差。无连接、连接静止工况的 P50/P95/P99 与有效 FPS 均不允许退化超过 5%；断流用原超时和动作收敛用例验证，不强制归零状态。低 FPS 的单段 P99 可能由少量帧支配，须报告帧数/最大间隔和每段值，不宣称统计显著。 |
| 正式帧采样 | 持续动作每分辨率跑两块 **ABBA + BAAB**，每状态共 4 段，每段 60 秒；辅助无连接/连接静止每分辨率至少 1 块 ABBA。每段重建同一初始状态，通过相同 ready 门槛后预热 10 秒，再从回放同一原点开始计时；消息内容/顺序/时间一致，不丢中间状态。 |
| 帧统计口径 | 有效 FPS=采样窗口内实际完成帧数/包含停顿的真实采样墙钟秒数，保存起止时刻和原始帧时间线；不能只对窗内完整间隔求和而漏算首尾停顿。P50/P95/P99（nearest-rank）与长任务单独计算，跨窗间隔归属规则在 R0 冻结：保留与窗口有交集的完整间隔及前后相邻帧，不因越窗或长尾删除；末端无法补齐须报告停顿下界和尾延迟未验证，不能据不完整尾统计通过。无帧或必需计量失效须显式失败并保留帧数/墙钟，不输出虚假 0ms。每块分别取其两段 A/B 的中位值，再报告全部 4 段的中位汇总。两块主指标改善方向均须一致，最终汇总满足主目标；尾延迟每块及汇总均须过门。禁止事后混池、选择最优段或将 CPU frame/evaluation 相加。 |
| 真实中台打开 | 冷/暖每版本每条件至少 **5 次**交错对照，完整列出原始值。中位耗时各下降至少 **30%**，已观察最慢一次不超过基线 105%，失败率不增加。5 次只报告中位/观测最慢，不冒称可靠 P95。起点为用户打开命令接收，终点为原有资源/脚本/环境/天空盒/稳定 ready 门槛全部完成。 |
| 冷暖与缓存定义 | 冷=独立 Electron/userData 及事先声明的应用缓存状态；暖=同 userData、同资源版本再次打开。持久编译缓存、共享资源库、浏览器/OS 文件缓存分别记录；不清 OS 缓存则明确不是 OS 真冷。真实中台与固定离线发布包分表，后者不替代前者；远端版本/网络条件变化不能算本地优化收益。 |
| 资源成本 | 全部变体记录峰值 JS heap、受管 vertex/index/instance buffer 与纹理分配、临时磁盘和任务/字节峰值；未知真实显存记不可用。峰值 JS heap 不超过同条件基线 110%，新增 buffer/待校验字节不超过 R0 冻结的明确预算；缺必需预算或超限不得晋级。 |
| 画质/几何/交互 | 分辨率、DPR、抗锯齿、阴影/PBR/描边、完整几何及场景格式保持。原资源 SHA、业务三角形/姿态/单位、拾取/子部件显隐/阴影/回退一致，代理指标为 0；同姿态截图按原阈值与真实动态区域处理，不扩大容差/遮罩。16 包原 4 失败按同条件保留并说明，无新增失败，不能删旧失败凑全绿。Editor 真实指针/末帧/一次命令/取消/撤销重做及独立 SOURCE/DIST Viewer 均验证。 |
| 脚本与设备 | 保护参数编译器/执行器、原脚本及驱动算法；生命周期/上下文/参数值类型/本地脚本引用与打包环境快照、MQTT 消费顺序和更新频率一致。登记 Stacker/Conveyor/RGV/Shuttle/Lift/HCLift 各自适用的零值、运动、边界、故障、断流、取放/交接、重开与取消关键轨迹，已登记用例 100% 通过并保存逐时刻姿态/状态对照；不扩称未覆盖的现场全轨迹。 |
| 工程回归 | 后续代码变更按影响面执行现有 typecheck/lint/build、test:ci、test:optimization-p2、test:lighting-unified、test:integration、test:smoke、smoke:model-array-visual；涉及 P3/P4 门面/Store/Hooks 再补其专项。记录真实命令、版本、结果与原有条件 SKIP；构建/NullEngine/模拟中台不替代真实 GPU、实际中台或现场设备。以上为各后续阶段按影响面执行的入口；**R0 实际已执行检查、条件 SKIP 与既有失败见执行记录，不将未运行门禁记为通过**。 |

采样期间不并行构建、lint/测试、CPU profile、诊断建图、大文件扫描或其他本任务浏览器；窗口可见/聚焦、供电与硬件、OS/驱动、浏览器/Electron版本均记录。无效判定必须来自 ready/可见性/输入/版本/外部干扰等独立证据，不能因性能差而排除；原始失败、无效轮次和全部重复保留。预热、超时及输入冻结后不因失败扩大门槛。

报告分别填写 **measurementValid / functionalPass / performancePass**，并逐项填写“已实现/已验证/未验证/失败/研究暂缓”；三个 pass 不能互相替代。默认产品采样性能不达标、必要功能失败或缺真实中台证据时，新 P2 总验收保持未完成；安全的局部成果可单独保留，实验继续关闭。最终交付包括冻结清单、逐次原始数据、分项 trace、预算/峰值、视觉/轨迹/资源指纹、回滚说明及执行记录，不覆盖原 P2 输出。

<details>
<summary>旧 P2.1～P2.4 清单、原验收目标与历史结论（原文冻结，不补勾）</summary>

### Phase 2 (P2)：大场景打开耗时与运行帧率攻坚（核心体验突破）
- [ ] **P2.1** 建立 `.model.ts` 内容哈希持久化转译缓存与参数变体模板分帧初始化调度。
  - 已完成实际TS内容/编译器版本持久缓存与FIFO分帧宿主初始化；跨会话参数几何模板仍未实现，单个同步 `onStart` 仍不可抢占，未满足每任务 <50ms。
- [ ] **P2.2** 改造中台场景打开的资源准备与增量同步为按资产依赖的有界并发流水线。
  - 已完成模型增量同步按包4下载/2校验的流水线及取消/回滚验证；完整中台资源准备链路与真实冷暖打开30%+尚未验收，不将局部实现记为全链路完成。
- [ ] **P2.3** 实现 `dataDriven.motion` 动态设备的“固定结构部件 `thinInstance` 合批 + 运动子部件独立驱动”混合实例化。实验实现与身份/照明/阴影/变更回退功能已通过；最终真实工厂实验ON/OFF中位FPS为1440p 2.900/5.743、4K 2.676/4.324，因此缺省关闭，保留显式实验入口，不能认定本步骤性能交付达标。
- [x] **P2.4** 实施静态环境/批次世界矩阵受控冻结与单体 Gizmo 拖拽过程 Store 更新节流（真实生产UI预览、取消、一次命令、撤销/重做通过）。
- [ ] **P2 验收指标**：
  - 真实工厂场景（370+ 实体）Draw Call 从 ~1,314 降至 **< 400**，Active Mesh 从 ~3,800 降至 **< 1,000**；
  - 相同硬件（Intel UHD 630）与相同 MQTT 回放下，1440p 与 4K 稳态 FPS 取得可复现提升，且固定视角 WebGL 截图像素、16 模型包视觉回归（`npm run smoke:model-array-visual`）、提升机/输送机动作轨迹 100% 无退化；
  - 中台工程冷/暖打开耗时相比基线下降 **30%+**。

P2执行记录：[2026-10-21 P2执行记录](tasks/2026-10-21-project-optimization-p2.md)。最新安全默认版本build/typecheck/lint/CI及P2专项179/179通过。真实工厂确认环境hash重复及内部Geometry包装导致的cache miss，已补精确缓存与可信内部delegate协作，不改回调函数体/调用顺序。动静合批显式实验形成23批/204逻辑原件，但Draw/Active目标和收益未达标，缺省关闭；最终两分辨率各4×60秒回放完成，默认OFF/实验ON中位FPS：1440p 5.743/2.900（实验−49.50%），4K 4.324/2.676（实验−38.12%）。默认路径Draw中位1319/Active1527，仍未达<400/<1000。原始失败数据保留，P2总验收保持未勾选。

</details>

---

### Phase 3 (P3)：核心巨型模块（God Modules）渐进解耦
- [x] **P3.1** 将 `SceneRuntime.ts` 按领域拆分为核心协调器 + 6 个专用 Controller，保持对外方法签名不变（本次入场10,909行，完成后725行）。
- [x] **P3.2** 将 `editorStore.ts`（6,418 行）按业务域拆分为 6 个 Zustand Slice，保持 selector 与命令历史完全兼容。
- [x] **P3.3** 拆分 `SceneViewPanel.tsx`、`EntityArrayThinInstanceBatch.ts` 与 `ProjectPanel.tsx` 的独立子模块与 Hooks。
- [x] **P3.4** 提炼 Electron 端统一的场景资源引用遍历与重写模块（`sceneResourceTraversal.ts`）。
- [x] **P3 验收指标**：
  - 核心单文件最大行数控制在 **2,500 行以内**（`SceneRuntime.ts` 主文件 **< 2,000 行**）；
  - `npm run test:ci`、`npm run test:integration`、`npm run test:smoke`、`npm run test:lighting-unified` 全部通过。

P3执行记录：[2026-10-22 P3执行记录](tasks/2026-10-22-project-optimization-p3.md)。P3.1—P3.4及本地验收全部完成：核心最大2449行、SceneRuntime725行；四组规定入口全部exit0，P3专项28/28、P2兼容回归179/179、统一光照42/42通过。生产Editor35项和独立Viewer实际WebGL/MQTT通过，最后重建的466份JS/CSS与实机验证版本字节一致。保护源码/资源与入口快照一致。P2原未完成项保持独立；P4结果见下节。

### Phase 4 (P4)：类型安全收紧与测试体系闭环
- [x] **P4.1** 清零入场实际18处未使用诊断（原计划快照34处），在 `tsconfig.json` 与 `tsconfig.node.json` 正式启用 `noUnusedLocals: true`。
- [x] **P4.2** 分三批清零入场实际152条 ESLint warning（原计划快照181条），将关键正确性规则升级为 `error`。
- [x] **P4.3** 修复 `autoPatrolPlayback.test.ts` 与 `dataPlatformScreenOverlay.test.ts` 的 SSR 导入超时。
- [x] **P4.4** 分类收敛 `docs/test-inventory.md` 入场实际301个无静态入口候选（原计划快照302个），更新 `scripts/test-entry-manifest.json` 并通过 `--check`。
- [x] **P4 验收指标**：
  - `npm run typecheck` 与 `npm run lint` 0 error，warning 压降 **80%+**；
  - `npm run test:auto-patrol` 等全量单元与回归入口稳定通过无超时；
  - `node scripts/generate-test-inventory.mjs --check` 与 `npm run test:entries` 0 漂移。

P4执行记录：[2026-10-22 P4执行记录](tasks/2026-10-22-project-optimization-p4.md)。P4.1—P4.4及本地验收完成：18项未使用诊断清零、152→0 warning、四项关键规则error；301候选全部分类、六域160文件/159命令实际通过，87条manifest入口零缺失。构建/类型/lint、CI/集成/smoke、巡检48/48、P2 179/179、P3 28/28、统一光照42/42和P4 9/9通过。生产Editor35项、SOURCE/DIST四配置与独立Viewer实际运行，静态318275像素changed/max为0。CI既有外部EXR条件SKIP和139项未整体执行的环境/人工候选明确保留，不计为全部通过；P2总验收仍未完成，动静合批缺省false。

---

## 五、 风险控制与执行准则

1. **工作区隔离与基线保护**：启动任一阶段前，先确认或归档当前工作树中未提交的改动；涉及多文件重构或构建配置调整时，按子阶段建立清晰的SHA基线与回退点。
2. **证据驱动与实机核对**：构建体积以 `npm run analyze` 生成的 `summary.json` 实际落盘字节为准；渲染帧率与画质以真实硬件 WebGL 2（Editor Electron 与独立 Viewer）同视角 A/B/B/A 采样和截图比对为准，不以 NullEngine 或关闭业务功能的数据充当正式收益。
3. **文档与任务记录同步**：每完成一个子阶段，按规范同步更新 `docs/task-log.md`、`docs/test-inventory.md` 及相关专题文档。
