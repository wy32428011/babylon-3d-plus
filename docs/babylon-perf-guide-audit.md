# Babylon 性能指南检测与无损优化（2026-10-19）

依据用户提供的 `babylon-perf-guide.md`，对当前 Babylon.js 9.12 项目核对性能环境、测量、编辑器与 Viewer 热路径。用户要求保持参数化脚本和动作逻辑，本轮仅修改 HTML 大屏叠加层和巡检路线编辑辅助标记。几何、材质、纹理、阴影、分辨率、消息顺序、动作频率和参数脚本均保持原样。

## 检测与取舍

| 指南章节 | 当前证据和处理 |
|---|---|
| 1 环境 | `createEngine.ts` 已有高性能偏好、硬件 WebGL 校验、`preserveDrawingBuffer: false`。本轮 Electron 实测 Intel UHD 630 / ANGLE D3D11 / WebGL 2，硬件加速正常，禁用 GPU 的负向门控也通过。 |
| 2 测量 | 复用 `ScenePerformanceMonitor`、编辑器“性能运行”和 Viewer `?performance=1`；已有 CPU/GPU、Draw Call、活动网格、Long Task、逐帧间隔报告。GPU 计时不可用仍为 null。 |
| 3 瓶颈分类 | 区分完整场景与组件成本，采集同输入、视角和尺寸下的静止/移动或数据回放。没有用关闭业务回调或特效后的 FPS 冒充正式收益。 |
| 4 React/Zustand | 引擎在 effect 中创建并释放；Hierarchy 已虚拟化。单体 Gizmo 的状态预览仍是后续候选，涉及属性反馈、撤销和参数联动，本次未改变。 |
| 5 Picking | 业务点选有专用拾取路径。脚本可注册 Babylon 事件，因此不全局设置 `skipPointerMovePicking` 或 `fastCheck`，避免改变悬停/最近命中。 |
| 6 选中/Gizmo | 保留现有 SelectionOutlineLayer、当前选择更新与监听释放；未替换描边材质或改变操作反馈。 |
| 7 每帧回调/GC | 已减少 Overlay 数学临时对象和重复 DOM 操作；巡检编辑标记仅在缩放变化时标脏，保留每帧相机/位置检查。 |
| 8 Draw Call | 已有参数变体和动态模型保护的 thin instance 合批；不按顶点数量粗分组，不合并脚本引用的节点或共享可变材质。 |
| 9 可见性 | 已有实例视锥脏检查；保持相机、脚本和动态模型的正常失效路径，不冻结全场活动网格。 |
| 10 离线资源 | 已有本地解码器与资源处理工具；本次不 flatten/join/prune 脚本模型或覆盖原 GLB。 |
| 11 GPU 效果 | 保持阴影、灯光、透明、后处理和渲染分辨率；不采用交互降画质。 |
| 12 纹理 | 不替换纹理或启用有损压缩；压缩需独立资产级验证。 |
| 13 标签/GUI | 已使用 HTML Overlay。本轮保留全部屏幕、视频/跑马灯、遮挡与点击，仅消除重复计算和写入。 |
| 14 MQTT | 保留现有按帧动作推进和原消息处理。不使用附录“每设备只留最新值”来丢弃中间动作事件。 |
| 15 加载/存储/发布 | 已序列化业务 SceneDocument，资源路径与来源校验保留；没有发现需要新建自动保存订阅的依据。完整资源门控失败不能计作性能样本。 |
| 16 按需渲染/WebGPU | 脚本、遥测、视频和动作需要持续更新，附录唤醒条件不完整，本轮保持现有渲染循环。 |
| 17 画质回归 | 真实硬件 WebGL A/B 固定视角截图、透明与遮挡交互回归；具体结果及证据见下。 |
| 18 分区/流式 | 未发现足以改变场景内容生命周期的证据，不引入代理、隐藏远处内容或流式卸载。 |
| 19–21 执行顺序与结果 | 先建立基线与可复现计数，再做两项外围优化，最后回归并记录限制。附录只复用适用思路，没有整体复制。 |

Babylon 官方也明确说明冻结世界矩阵后会忽略后续变换、关闭 pointermove picking 会停止相应网格事件；这些不是本任务可直接启用的无损开关：[官方优化说明](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/scene/optimize_your_scene.md)。

## 两项实现

### HTML 大屏/图表立标

`DataPlatformScreenOverlay.tsx` 在同一次相机回调中复用 canvas/root 尺寸、viewport 和投影矩阵；下一回调重新读取。五个临时向量、单位矩阵和视锥平面改为复用。样式写入按请求值与浏览器规范化结果去重，外部改动仍能被纠正。每块屏幕的世界矩阵、运动、视频播放判定、深度遮挡与点击处理保留。

### 巡检路线编辑标记

`EditorAutoPatrolRuntime.ts` 保持原缩放公式和每帧检查，相同缩放不再执行 `setAll`。通过 Babylon 的 `isSynchronized()` 判定是否强制更新世界矩阵，避免同一 renderId 内再次同步父节点时读到旧矩阵。此处只涉及路线原点和巡检点的编辑辅助显示；运行预览仍沿用原跳过规则，播放控制器未修改。

## 验证方法与边界

可复用的定向命令：

```powershell
node --test tests/runtime/dataPlatformScreenOverlayPerformance.test.mjs
node --test tests/runtime/editorAutoPatrolScreenScale.test.mjs
node scripts/smoke-screen-overlay-performance.mjs
node scripts/smoke-chart-marker-occlusion.mjs
node tests/editor/chartMarkerTransparency.integration.mjs
```

`smoke-screen-overlay-performance.mjs` 使用生产构建、真实 React/Babylon 和 36 个完整 iframe 大屏。可通过 `--baseline-module <旧版同目录模块路径>` 进行 A/B/B/A；默认只检查当前实现。旧版模块必须保留相对依赖路径，不应长期留在生产目录。报告与截图默认写入 `output/playwright/screen-overlay-performance/`。

确定性回归证明：120 个屏幕的 Overlay 单帧 DOMRect 读取 **240 → 2**，稳定样式写入 **720 → 0**，创建新对象的旧数学 API 调用 **2,880 → 0**。501 个巡检编辑标记静止 300 帧，重复缩放写入和世界矩阵更新均为 **150,300 → 0**。这里使用 NullEngine 与组件挂载替身，只证明工作量，不代表整场景 FPS。

“两次 DOM 尺寸读取”只指 Overlay 投影路径；图表立标的 DepthSurface 交互等路径仍可能读取布局。没有声称整个应用每帧只有两次布局读取。

本轮证据目录：`output/playwright/perf-guide-20261019/`。真实工厂使用已有 370 实体、77 项发布资源的本地副本及历史 MQTT 消息的本机回放，不作为线上 Broker 或现场验收。

初次通过编辑器打开 SOURCE 副本时，中台资源准备要求配置地址，完整加载门控阻断；该失败保留在 `factory-before/result.json`，不计入 FPS。后续使用既有完整 Viewer 资源包进行隔离测量，不跳过资源就绪校验。

## 组件实测结果

生产 React/Babylon、Edge 硬件 WebGL 2、1280×900、DPR 1、36 个可点击 iframe，预热 5 秒；按原版/优化版/优化版/原版交错，各状态采样 5 秒。下表为每版本两轮平均，未控制机器其他任务、温度和功耗状态。

| 指标 | 原版 | 优化版 |
|---|---:|---:|
| 静止时 Overlay 回调平均耗时 | 1.433 ms | 1.323 ms |
| 相机移动时 Overlay 回调平均耗时 | 3.917 ms | 1.787 ms |
| 相机移动时 FPS | 59.98 | 60.00 |
| 每帧投影路径 DOMRect 读取 | 72 | 2 |
| Draw Call / 活动 Mesh | 36 / 36 | 36 / 36 |

相机移动时该组件平均耗时减少约 54.4%；两版均接近刷新率上限，因此不声称 FPS 提升 54.4%。正面、倾斜、正交三种视角在四轮间的截图 SHA-256 全部相同；真实 iframe 点击、视口尺寸变化、隐藏恢复和卸载均通过。证据为 `overlay-final-verified/result.json`、`overlay-comparison.json` 和对应 PNG。

## 验证记录

- 基于当前源码的优化前与优化后 `npm run build` 均成功，包含 TypeScript、编辑器及 Viewer。构建保留原有 chunk size / ineffective dynamic import 提示。
- 新定向回归 `node --test --test-concurrency=1 tests/runtime/dataPlatformScreenOverlayPerformance.test.mjs tests/runtime/editorAutoPatrolScreenScale.test.mjs` 最终 **7 passed / 0 failed**（含父 test）。
- 两个生产文件 ESLint **0 errors / 1 既有 warning**，`git diff --check` 通过。
- 36 个受保护参数/动作相关文件 SHA-256 前后一致，见 `protected-before.json` 和 `protected-after.json`。基线 Git 版本为 `e6f7a32`。
- `npm run test:auto-patrol` 的 17 个数据用例通过，播放测试在 Vite SSR 导入时超时；旧 `smoke-auto-patrol.mjs` 和 `tests/editor/dataPlatformScreenOverlay.test.ts` 也在 SSR 导入阶段超时。它们没有完成的业务断言不计入通过，没有为通过测试修改动作逻辑。
- 第一轮优化版工厂静止/动作帧率采样与 ESLint 执行时间重叠，已排除其性能读数；该轮完整加载与独立/iframe Viewer 功能检查仍有效。被排除的记录保留在 `timing-validity.json`，后续使用无本任务并发构建/静态检查的隔离采样。

## 真实工厂有效对照

采用现有 370 实体、77 项发布资源，1440×900、DPR 1、Intel UHD 630 硬件 WebGL 2。前后场景字节、资源 manifest、历史 MQTT 回放哈希、相机与视口相同，Viewer 功能能力和非代码静态资源相同。JS/HTML 构建散列及引用它们的能力文件散列因本轮代码变化而不同，不能要求二进制产物整体哈希相同。

为排除前述静态检查干扰，原版和优化版另行各采一轮 15 秒，动作窗口均回放 290 条消息：

| 状态 | 原版 FPS | 优化版 FPS | 原版逐帧 P95 | 优化版逐帧 P95 | Draw Call |
|---|---:|---:|---:|---:|---:|
| 静止 | 21.27 | 21.79 | 57.2 ms | 54.2 ms | 1314 |
| 动作回放 | 18.42 | 18.74 | 66.9 ms | 67.3 ms | 1316 |

该结果没有重现受干扰采样中的明显下降，但单轮短样本不支持“整场景 FPS 稳定提升”的结论。系统其他任务、温度、功耗与 OS 文件缓存未被严格控制。它也没有达到 30/60 FPS；不能把组件耗时下降换算成整场景帧率承诺。

优化版窗口末次 1 Hz 样本中 CPU frame 约 44–45 ms、GPU frame 约 31–33 ms、活动网格求值约 8.7–9.3 ms，表明仍有显著的场景 CPU/GPU 负担。该推断用于描述当前测量，不是已完成所有热点归因；本轮没有为降低这些读数削减几何、阴影、材质或动作。

证据：`factory-comparison.json`、`factory-viewer-baseline-repeat/result.json`、`factory-viewer-after-isolated/result.json`。完整资源加载、独立 Viewer 和通用 iframe 在 `factory-viewer-before/result.json` 与 `factory-viewer-after/result.json` 中均通过；后一个文件的性能窗口已单独标为无效，功能结果保留。

### 视觉与交互回归

- `smoke-chart-marker-occlusion.mjs`：12 项通过，覆盖部分/全部/后方遮挡、跨域点击、锁定遮挡物、相机移动、实时内容、空屏操作、交叉屏幕、局部读回与卸载。
- `chartMarkerTransparency.integration.mjs`：9 项通过，覆盖透明背景、前景遮挡、透明 PNG、背景替换/清除、实时文字、尺寸变化、颜色切换、场景输入与卸载。
- `smoke-auto-patrol-capture.mjs`：7 项真实编辑器操作通过，覆盖 F1/按钮新增、F1/按钮覆盖、同水平不同高度、聚焦节点、保存重开后恢复真实相机矩阵，`pageErrors=[]`。

验证范围为当前源码和本地构建，不代表已安装版本、线上中台/真实 MQTT Broker 或现场全部设备动作验收。原场景和资源未覆盖，没有执行发布、Git 提交或推送。
