# 提升机与换层提升机运行箭头

## 目标与范围

沿用现有堆垛机、RGV 的运动箭头，补齐编辑器运行预览与发布 Viewer。提升机提供升降、前工位、后工位，换层提升机提供升降。保持原有设备动作、MQTT 协议和参数化脚本。

## 验收清单

- [x] 数据驱动面板可配置开关、既有样式、外观、挂点和预览；保存重开、复制保留配置，预览不持久化。
- [x] 箭头消费本帧实际运动，升降正反向、工位交接与设备动作一致；排除初始化吸附和约束纠偏。
- [x] 升降覆盖立柱并动态避让载货台；工位跟随台面和实际输送轴；缺失或无效挂点明确诊断。
- [x] 停止、故障、急停、过期、冲突、模型隐藏和释放时箭头正确隐藏或回收。
- [x] 旧场景默认关闭，显式零值保留；编辑器和发布 Viewer 使用同一运行实现。
- [x] 定向回归、类型与构建检查、实际 WebGL 编辑器及解包 DIST Viewer 验证通过，记录验证边界。

## 分工与文件状态

- 主代理：SceneRuntime 集成、真实场景夹具、编辑器/发布包/Viewer 验证、文档和最终复核。
- 配置代理：liftMotionArrows、session、Inspector、telemetryBinding 及对应测试。
- 驱动代理：lift/hclift 驱动只读采样、liftMotionState 及对应测试。
- 渲染代理：LiftMotionArrowSurface/Renderer/System 及对应测试。

## 已确认依据

- 现有 RGV/堆垛机在驱动后消费当前 frameId 的 WeakMap 运动摘要。
- lift 台面轴由来料/送料绑定或模型声明推断，不能固定为局部 X；运行摘要提供世界水平轴。
- 未配置的旧场景继续关闭；发布场景通过 telemetryBinding 序列化复用 SceneRuntime。
- 工作区开始时 git clean；部分受保护源文件需通过 Node fs 读取及精确编辑。

## 验证与待办

已完成。最终源码构建与 Electron 构建通过；定向回归共 67 项通过（配置/会话/编辑 store 15、驱动及摘要 34、渲染几何 12、System 6），分组机制另 5 项通过。真实编辑器与实际解包 DIST Viewer 均通过硬件 WebGL 2、本地 MQTT 升降及双工位取货，SOURCE/DIST 各 4 场景配置保留检查通过。

证据：output/lift-motion-arrows/editor-result.json、packages-result.json、viewer-result.json、build.log、eslint.json。代码复核发现并修复旁路提前缓存业务轴、急停非即时隐藏、斜向自动条带越界；新增相应回归。

验证边界：使用自产 GLB 和本地 WebSocket MQTT，未连接现场 Broker、未升级已安装编辑器、未发布服务器或提交 Git。test:entries 因 HEAD 已有的 test:manual-roam 与 manifest 漂移失败，未扩大修复范围。ESLint 无错误，31 条警告位于既有大文件及原有未使用代码。
