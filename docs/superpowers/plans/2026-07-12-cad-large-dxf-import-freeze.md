# CAD 超大 DXF 导入卡死修复实施计划

**Goal:** 修复导入 `F:\3d-models\test.dxf` 时 UI 无响应的问题，并保持普通 DXF 精确导入。

**Architecture:** 普通文件继续使用现有解析器；大文件转入 Web Worker 轻量扫描并限制预览几何规模。Babylon 运行时按批次创建 LineSystem，场景重载时对高复杂度 CAD 继续使用后台解析。

- [x] 量化目标 DXF 文件规模、块引用展开量和异常坐标。
- [x] 实现 64 MB 阈值、Worker 大文件路径和固定预览预算。
- [x] 过滤异常哨兵坐标，修正单位与 Polyline 标志读取。
- [x] 持久化大文件导入模式，分批创建 Babylon 线稿，并在删除/切换场景时取消 Worker 或 fetch。
- [x] 限制 INSERT 阵列展开、抽样超长 Polyline，并限制单块扫描几何数量。
- [x] 使用目标文件执行 smoke、类型检查、构建和文档更新。
