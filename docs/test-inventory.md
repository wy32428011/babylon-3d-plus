# 测试入口清单

由 `node scripts/generate-test-inventory.mjs` 生成；`--check` 只检查漂移。

## 统计与证据边界

- 候选文件总数：660；测试/runner/smoke 候选：592；fixture/helper：68。
- npm 测试/smoke 入口：77；有静态入口的候选：308；无静态入口/未确认：284。
- CI 静态可达候选：94。这些数字不是测试执行数、断言数或通过数，不能宣称全仓单测已覆盖。
- 范围为 tests/ 的全部文件及 scripts/ 中 含 test/smoke 分隔词或 run-*integration 命名的文件（排除清单生成器）；其他目录/自定义命名测试不在自动发现范围。
- 解析 package.json 名称含 test/smoke 的入口（排除 test:inventory 工具）、npm run 递归、node/electron 的显式文件与 * / ** glob。构建/打包只记录前置，不运行。动态编译与 Electron runner 使用已核对的限定适配；其他动态调用保守标记待复核。
- CI 只读取 workflow 单行 run；可达表示配置选中，不代表远端执行成功。平台为源码线索，未标 Windows 的文件也未证明跨平台。
- 文件/源码断言候选可能包含行为测试；NullEngine 不证明真实 GPU/FPS；browser/WebGL 候选不代表已获得真实渲染证据。
- runner 条件按入口传播；各入口应单独运行，不合并测试进程。串行、Electron 编译和临时目录/junction 要求必须保留。

## 未覆盖或无法静态确认的候选

| 文件 | 类型 | 当前 npm 入口 | 平台边界 | 构建前置与隔离要求 | CI 静态可达 |
|---|---|---|---|---|---|
| scripts/electron-mqtt-test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/model-asset-relink-test.mjs | runner | 未发现；需补入口或人工复核 | 未证明跨平台；junction/symlink 权限 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-alarm-appearance.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-alarm-custom-property.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-alarm-manager.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-alarm-reference.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-asset-stream-throughput.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-bound-screen-selection.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| scripts/smoke-builtin-skybox.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-large-reference.mjs | 需人工判定 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-reference.mjs | 需人工判定 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-streaming-electron.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| scripts/smoke-camera-shadow.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-chart-marker-host.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| scripts/smoke-chart-marker-occlusion.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-chart-marker-ring.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-chart-marker-video.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-chart-marker.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-composition-cargo-motion.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-composition-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-conveyor-arrow-effect-surfaces.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-conveyor-arrow-effects-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-conveyor-arrow-effects.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-conveyor-surface-arrow-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-conveyor-surface-arrows.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-data-platform-config.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-digital-twin-effects-viewer.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-digital-twin-effects.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-dissolve-completion.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-editable-composition.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| scripts/smoke-effect-binding.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-effect-configuration-viewer.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-environment-building-effect-viewer.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-environment-building-effect.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-extreme-scene-performance.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| scripts/smoke-factory-static-shadows.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-flow-arrow-direction.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-generated-follow-viewer.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-geographic-opening-breathing.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-geographic-opening-editor.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/smoke-geographic-opening-host.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-geographic-opening.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/smoke-hierarchy-group-transform.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-light-wall-fence.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-light-wall-viewer.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-lit-environment-lights.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-local-shadow-full-scene.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-local-shadow-priority.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-manual-roam-occlusion.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-material-texture-clone.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-entrance-editor.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-entrance-loading.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| scripts/smoke-model-entrance.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-load-preparation.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-model-template-cache.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-multi-effect-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-opening-package-editor.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-opening-package-runtime.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-prismatic-opening-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-prismatic-opening.mjs | NullEngine；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-project-session-close.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-published-cache-storage.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-published-cache.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-published-opening.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-published-release-cache.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| scripts/smoke-published-response-cache.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-published-viewer-cache.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| scripts/smoke-real-project-loading.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/smoke-reference-opening-lifecycle.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-region-views.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/smoke-rgv-motion-arrow-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-rgv-motion-arrows.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-scene-load-diagnostics.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/smoke-scene-open-performance.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| scripts/smoke-scene-reopen-snapshots.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-scene-theme-presets.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-scene-theme-skybox.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-scene-theme-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-skybox-assets.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-skybox-decoded-data.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-skybox-mosaic.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-stacker-motion-arrow-viewer.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-stacker-motion-arrows.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-standalone-opening.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/test-cad-streaming.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/test-entry-manifest.json | 需人工判定 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/test-groups.mjs | 需人工判定 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/test-model-download-progress.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/currentProjectMetadata.integration.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/environmentBindingAuthority.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/environmentBindingAuthority.runner.mjs | runner；Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/environmentFileValidation.asar.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/environmentFileValidation.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/localSceneResources.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/localSceneResources.runner.mjs | runner；Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/modelDownloadProgress.integration.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/projectSessionClose.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/workspaceProjectOpen.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/alarmManagerPublish.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/builtinSkybox.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/chartMarkerVideoPublish.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/compositionPublish.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/conveyorArrowEffectsPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/conveyorSurfaceArrowPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/deploymentReleaseCacheManifest.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/digitalTwinEffectsPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/effectConfigurationPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/effectTemplatePackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/digitalTwin/environmentBuildingEffectPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/generatedFollowPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/generatedFollowViewerPackage.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/geographicOpeningPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/lightWallFencePackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/localScenePublishResourceRoots.integration.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/modelEntrancePackages.integration.mjs | NullEngine；Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/multiEffectBindingPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/openingPluginPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/prismaticOpeningPublish.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/projectCadAssetStore.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/publishSceneSnapshots.integration.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/digitalTwin/publishedLargeRawStore.browser.test.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/digitalTwin/publishedReleaseHttp.browser.test.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/digitalTwin/publishedReleaseStorage.browser.test.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/digitalTwin/publishedResponseCache.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/digitalTwin/regionViewPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/releaseCacheManifestPackages.integration.mjs | Electron 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/rgvMotionArrowPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/sceneThemePackages.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/stackerMotionArrowPackages.integration.mjs | Electron 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/syncedImageRead.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/digitalTwin/viewerCapabilitiesBuild.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/alarmCustomProperty.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/alarmManager.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/alarmReference.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/alarmTargetDrop.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/cadReferenceLoadStatus.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/cadReferenceRenderLayers.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/cadReferenceWorkerClient.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/cadTaskProgress.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarker.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerBackground.integration.mjs | Electron 候选；browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/editor/chartMarkerBackground.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerClick.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerDepthSurface.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/chartMarkerDrag.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerGizmo.integration.mjs | Electron 候选；browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerRing.integration.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/chartMarkerRing.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerRingGeometry.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerRuntime.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerSurfaceBridge.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/chartMarkerTransform.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerTransparency.integration.mjs | Electron 候选；browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerVideo.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/chartMarkerVisibility.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/clickEventBinding.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/composition.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/compositionPackage.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/editor/compositionRemote.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/editor/conveyorArrowEffect.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/conveyorArrowEffect.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/conveyorSurfaceArrowDrag.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/conveyorSurfaceArrows.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/dataPlatformScreenBridge.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/dataPlatformScreenOverlay.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/dataPlatformScreenScene.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/dataPlatformViewportScreen.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/deferredEnvironmentReadiness.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/digitalTwinEffect.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/digitalTwinEffect.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/editorPerformanceRunEntry.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/editorPerformanceRunSession.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/effectConfiguration.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/effectDataBindingInspector.webgl.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/effectPathDrawing.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/effectPathDrawing.webgl.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/effectTargets.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/environmentBuildingEffect.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/environmentPreparationFailure.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/environmentRuntimeOverride.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/environmentSyncAuthority.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/generatedFollowControls.browser.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/groupInspectorTransform.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/groupSpatialInfo.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/hierarchyGroupSelection.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/hierarchyPanelStateBinding.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/hierarchyStateButtonStyles.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/lightWallFence.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/lightWallFence.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/localSceneResourcePreparation.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/modelAssetRelink.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/modelSyncRefreshPolicy.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/modelTypeIdentity.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/multiEffectBinding.browser.mjs | browser / WebGL 候选；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/multiEffectTargets.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/editor/openingPackage.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/openingRouteCoordinates.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/pendingOpeningAlarmFocus.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/prismaticOpeningPackage.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/prismaticOpeningStageEditor.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/projectLoadingCancellation.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/publishContextRetry.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/repairPublishSceneSkyboxes.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/returnToHomePage.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/rgvMotionArrows.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/runtimeVisibilityRoundTrip.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/sceneEnvironmentReadinessContract.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneFullscreen.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/sceneModelEntranceConfig.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneModelEntrancePersistence.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/sceneOpenConfirmation.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneOpeningAnimation.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/sceneOpeningAnimation.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneOpeningConfig.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneOpeningReference.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/scenePreparationProjectPanelContract.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneRegionViews.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/sceneRemoteDownloadProgress.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/stackerMotionArrows.integration.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/editor/visibilityToggleEffectiveState.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/alarmReferenceEffects.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/autoPatrolInspectionRecordStore.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/autoPatrolInspectionReplayController.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/autoPatrolRuntimeIntegration.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/cadReferenceRuntime.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/conveyorArrowEffect.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/conveyorSurfaceArrowRenderer.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/conveyorSurfaceArrowSystem.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/digitalTwinEffectsRuntime.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/effectBindingRuntime.integration.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/effectDataRuntime.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/environmentAssetOptimization.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/environmentBuildingEffect.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/environmentRenderReadiness.test.ts | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/frameTimingWindow.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/generatedEffectTargets.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/generatedFollow.webgl.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/geographicOpeningData.test.ts | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/geographicOpeningFlightsBreathing.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/geographicOpeningFlightsLayout.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/geographicOpeningMath.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/geographicOpeningTechBreathing.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/lightWallFence.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/materialCloneDirtyGuard.test.ts | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/modelEntranceAlarm.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/modelEntranceEnvironment.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/modelEntranceRuntime.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/modelEnvironmentConfiguration.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/modelEnvironmentConfiguration.webgl.mjs | browser / WebGL 候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/openingEnvironmentSnapshot.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/openingImageBudget.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/openingPackageAssets.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/openingPackagePlayback.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/runtime/openingPackageTimeline.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/openingPlaybackCoordinator.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/openingPlaybackVisibility.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/openingReferenceRoutes.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/runtime/performanceMqttReplay.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/prismaticOpeningMath.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/referenceOpeningTimeline.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/referencePainterTimeline.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/runtime/rgvMotionArrowRenderer.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/rgvMotionArrowSystem.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/runtimeEffectTargets.test.mjs | 包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/sceneModelEntrancePlayback.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/runtime/sceneOpenAcceptance.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/scenePreparationFrameBudget.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/skyboxDecodedCache.integration.mjs | Electron 候选；browser / WebGL 候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/skyboxFallbackSampling.test.ts | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/skyboxHttpCache.integration.mjs | Electron 候选；browser / WebGL 候选 | 未发现；需补入口或人工复核 | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/runtime/skyboxPanoramaSampling.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/spatialEffects.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/spatialEffectsConfiguration.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/runtime/stackerFocusBounds.test.ts | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/stackerMotionArrowGap.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/stackerMotionArrowRenderer.test.mjs | NullEngine | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/stackerMotionArrowSystem.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/standaloneOpeningController.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/standaloneOpeningSettings.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/runtime/targetModelEffects.test.mjs | NullEngine；包含文件/源码断言候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/shared/randomUuid.test.ts | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/shared/viteDevStartup.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/telemetry/conveyorSurfaceArrowDefaults.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/telemetry/conveyorSurfaceArrowState.test.mjs | Node 测试候选 | 未发现；需补入口或人工复核 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |

## 有静态入口的候选

| 文件 | 类型 | 当前 npm 入口 | 平台边界 | 构建前置与隔离要求 | CI 静态可达 |
|---|---|---|---|---|---|
| scripts/builtin-slot-test.mjs | runner | test:builtin-slot | 未证明跨平台；junction/symlink 权限 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/dist-test-win.mjs | 需人工判定 | dist:win:test | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/model-array-test.mjs | runner | test:model-array | 未证明跨平台；junction/symlink 权限 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/run-digital-twin-publish-integration.mjs | runner；Electron 候选 | test:digital-twin、test:digital-twin:integration、test:integration | 未证明跨平台 | 前置 npm run build:electron | 否 / 未确认 |
| scripts/run-publish-model-recovery-integration.mjs | runner；Electron 候选 | test:publish-model-recovery | 未证明跨平台 | 前置 npm run build:electron | 否 / 未确认 |
| scripts/run-scene-model-update-integration.mjs | runner | smoke:scene-model-update | 未证明跨平台 | 前置 npm run build:electron；前置 npm run build:viewer | 否 / 未确认 |
| scripts/smoke-asset-load-scheduler.mjs | Node 测试候选 | smoke:scene-capacity、test:smoke | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-auto-patrol-capture.mjs | browser / WebGL 候选 | smoke:auto-patrol-capture | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-auto-patrol.mjs | NullEngine | smoke:auto-patrol | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-block-instances.mjs | NullEngine | smoke:cad、smoke:units | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-extended-geometry.mjs | Node 测试候选 | smoke:cad、smoke:units | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-cad-geometry-fidelity.mjs | Node 测试候选 | smoke:cad、smoke:units | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-camera-view.mjs | NullEngine | smoke:camera-view | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-composition-array.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:composition-array | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-data-platform-project.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:data-platform | 含 Windows 路径/命令，需 Windows 复核 | 前置 npm run build；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-data-platform-skybox.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:data-platform、smoke:data-platform-skybox、smoke:data-platform-skybox:built | 未证明跨平台 | 前置 npm run build；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-device-spawner.mjs | NullEngine；包含文件/源码断言候选 | smoke:device-spawner | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-editor-ground-grid.mjs | NullEngine；包含文件/源码断言候选 | smoke:grid | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-editor-large-scene-performance.mjs | NullEngine；包含文件/源码断言候选 | smoke:editor-performance、smoke:scene-capacity、test:smoke | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-environment-light-isolation.mjs | browser / WebGL 候选 | smoke:environment-light | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-environment-shadows.mjs | browser / WebGL 候选 | smoke:environment-shadows | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-folder-group-move.mjs | NullEngine | smoke:folder-group-move | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-folder-group-runtime.mjs | NullEngine | smoke:folder-group-runtime | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-generated-cargo-click.mjs | NullEngine；包含文件/源码断言候选 | smoke:generated-cargo-click | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-gpu-acceleration.mjs | browser / WebGL 候选 | smoke:gpu | 未证明跨平台 | 前置 npm run build | 否 / 未确认 |
| scripts/smoke-hierarchy-clipboard.mjs | Node 测试候选 | smoke:hierarchy-clipboard | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-hierarchy-virtualization.mjs | 包含文件/源码断言候选 | smoke:editor-performance、smoke:scene-capacity、test:smoke | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-light-editor.mjs | NullEngine | smoke:light-editor | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-lighting-types.mjs | browser / WebGL 候选 | smoke:lighting-types | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-meter-unit-contract.mjs | 包含文件/源码断言候选 | smoke:units | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-array.mjs | NullEngine | smoke:model-array、smoke:units | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-measurement.mjs | NullEngine | smoke:model-measurement、smoke:units | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-parameter-meters.mjs | NullEngine；browser / WebGL 候选；包含文件/源码断言候选 | smoke:model-parameters、smoke:units | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-model-picking.mjs | NullEngine | smoke:model-picking | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-multilevel-static-shadows.mjs | browser / WebGL 候选 | smoke:static-shadows | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-packaged-gpu.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:installer:gpu、smoke:packaged:gpu | 含 Windows 路径/命令，需 Windows 复核 | 前置 npm run dist:win | 否 / 未确认 |
| scripts/smoke-packaged-remote-scene.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:scene-loading | 含 Windows 路径/命令，需 Windows 复核 | 前置 npm run build；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-packaged-windows.mjs | 需人工判定 | smoke:packaged:win | 含 Windows 路径/命令，需 Windows 复核 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-parametric-model-array-packages.mjs | NullEngine；包含文件/源码断言候选 | smoke:model-array-packages | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-parametric-model-array-visual.mjs | Electron 候选；browser / WebGL 候选；包含文件/源码断言候选 | smoke:model-array-visual | 含 Windows 路径/命令，需 Windows 复核 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-persisted-scene-batching.mjs | 包含文件/源码断言候选 | smoke:persisted-scene-batching、smoke:scene-capacity、test:smoke | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-real-scene-reimport-performance.mjs | browser / WebGL 候选；包含文件/源码断言候选 | smoke:reimport-performance | 未证明跨平台 | 前置 npm run build；含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| scripts/smoke-scene-capacity.mjs | NullEngine；包含文件/源码断言候选 | smoke:scene-capacity、test:smoke | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-scene-theme.mjs | browser / WebGL 候选 | smoke:scene-theme | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-selection-highlight.mjs | NullEngine | smoke:selection-highlight | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-shadow-quality.mjs | browser / WebGL 候选 | smoke:static-shadows | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-shelf-shared-instancing.mjs | NullEngine；包含文件/源码断言候选 | smoke:shelf-instancing | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-static-model-instancing-policy.mjs | NullEngine | smoke:scene-capacity、test:smoke | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-static-shadow-settings.mjs | Node 测试候选 | smoke:static-shadows | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-static-shadow-ui.mjs | browser / WebGL 候选 | smoke:static-shadows | 未证明跨平台 | 含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-static-shadows.mjs | browser / WebGL 候选 | smoke:static-shadows | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-transform-gizmo.mjs | NullEngine | smoke:transform-gizmo | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| scripts/smoke-viewer-gpu-contract.mjs | 包含文件/源码断言候选 | smoke:viewer:gpu | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/telemetry-test.mjs | runner | test:telemetry | 未证明跨平台；junction/symlink 权限 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| scripts/test-composition-array-runtime.mjs | NullEngine；包含文件/源码断言候选 | test:composition-array | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| scripts/test-composition-array.mjs | 包含文件/源码断言候选 | test:composition-array | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/buildAnalysis.test.ts | 包含文件/源码断言候选 | test、test:build-analysis、test:ci | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/buildTypeScript.test.mjs | 包含文件/源码断言候选 | test、test:ci、test:typescript-build | 未证明跨平台 | 引用 dist-electron；核对 build:electron 前置 | .github/workflows/ci.yml: windows-latest |
| tests/dataPlatform/assetFileByteStream.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/currentProjectMetadata.test.ts | Electron 候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/dataPlatformProjectLocation.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/downloadByteProgress.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/editorAssetFileError.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/environmentContract.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/environmentIndex.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/environmentLargeGlb.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/environmentRemoteHttp.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/dataPlatform/environmentResourceMatch.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/environmentSync.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/glbModelContract.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/localSceneRecoveryService.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；模块加载 hook；保留进程隔离；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/localSceneRemoteRecovery.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/localSceneResourceRecovery.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/modelAssetRelink.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/modelIncrementalSync.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/modelPreloadProgressGateContract.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/modelSourceSnapshot.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/dataPlatform/modelSyncIndex.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/preloadProgressGate.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:data-platform-skybox | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/projectPackageSizeLimit.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/projectSessionClose.test.ts | Electron 候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/remoteDownloadProgress.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/requestJsonHttpError.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/sceneModelResourceValidation.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:scene-model-update、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/sceneModelSyncConcurrency.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/sceneModelUpdate.integration.mjs | Electron 候选；包含文件/源码断言候选 | smoke:scene-model-update | 未证明跨平台 | Electron 二进制；独立临时目录；240s 超时；前置 npm run build:electron；前置 npm run build:viewer；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/dataPlatform/sceneModelUpdatePlan.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:scene-model-update、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/sceneModelVersionSync.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/dataPlatform/skyboxContract.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:data-platform-skybox | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/skyboxIndex.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:data-platform-skybox | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/skyboxLifecycle.test.ts | 包含文件/源码断言候选 | smoke:data-platform、test:data-platform-relink、test:data-platform-skybox | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/dataPlatform/skyboxRelink.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink、test:data-platform-skybox | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/dataPlatform/skyboxSyncQueue.test.ts | Node 测试候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build；模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/dataPlatform/workspaceProjectOpen.test.ts | Electron 候选 | smoke:data-platform、test:data-platform-relink | 未证明跨平台 | Node 原生 strip-types；前置 npm run build | 否 / 未确认 |
| tests/devAssetPaths.test.ts | Node 测试候选 | test、test:ci、test:dev-asset-paths | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/assetFocusCameraTransition.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/backgroundFrameRequester.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/builtinSkybox.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/cameraInteractionStandard.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/clickEventBindingPublish.integration.mjs | Electron 候选 | test:click-events:integration | 未证明跨平台 | Electron 二进制；前置 npm run build:electron；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/clickEventModelIdentity.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/clickEventModelRecovery.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformBindingStore.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformChartBridge.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformChartLibrary.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformChartPanel.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformChartSync.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformConfigSave.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/dataPlatformSkyboxSync.test.ts | 包含文件/源码断言候选 | test、test:ci、test:data-platform-skybox、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/deepLink.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 含 Windows 路径/命令，需 Windows 复核 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/deferredAutoPatrolStartGate.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/deploymentExportFileSystem.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/deploymentSceneSanitizer.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/deploymentSkyboxCache.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinAssetCodes.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinDisplayBridge.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinForceOverwrite.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinFullscreenBridge.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinInteractionController.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinInteractionProtocol.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinParentOrigins.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinPublish.integration.mjs | Electron 候选；包含文件/源码断言候选 | test:digital-twin、test:digital-twin:integration、test:integration | 未证明跨平台 | Electron 二进制；共享 TEST_ROOT；runner 顺序执行；前置 npm run build:electron；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置；引用 dist-viewer-template；核对 build:viewer 前置 | 否 / 未确认 |
| tests/digitalTwin/digitalTwinPublishAssetWarnings.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinPublishProtocol.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinPublishRuntimeConfig.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinSlotCodes.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/digitalTwinSourcePackage.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/editorAssetCacheHeaders.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/effectDeploymentReferences.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/environmentShadowMaterial.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/externalAssetHighlight.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/geographicOpeningBridge.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/homeDataPlatformProject.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/modelClickFocusParity.test.ts | NullEngine；包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/modelSelectionControls.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/openingPackageFiles.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/openingPackageStore.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/openingPublishPlan.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerAutoPatrolStartup.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerEnvironmentLoadContract.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerGlobalOverview.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerInitialLoadMonitor.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerInitialLoadRenderState.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerInitialLoadState.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerLoadingFileName.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerLoadingProgress.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerPerformanceDiagnostics.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerPerformanceMonitor.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/playerStatusOverlayControls.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/preparePublishResources.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/projectLibraryTabs.test.ts | 包含文件/源码断言候选 | test、test:ci、test:data-platform-skybox、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishBindingRecovery.integration.mjs | Electron 候选；包含文件/源码断言候选 | test:digital-twin、test:digital-twin:integration、test:integration | 未证明跨平台 | Electron 二进制；共享 TEST_ROOT；runner 顺序执行；前置 npm run build:electron；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/publishModelPackageRecovery.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；模块加载 hook；保留进程隔离；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishModelRecovery.integration.mjs | Electron 候选；包含文件/源码断言候选 | test:publish-model-recovery | 未证明跨平台 | Electron 二进制；独立临时 userData；退出后清理；前置 npm run build:electron；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/publishOrchestration.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishParameterWarnings.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishPreloadBridge.test.mjs | 包含文件/源码断言候选 | test:publish-model-recovery、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/digitalTwin/publishResourceErrorMessage.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishResourceIdentity.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；含服务/端口；复核端口与关闭流程；模块加载 hook；保留进程隔离 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishSceneSnapshots.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishSkyboxRecovery.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedAssetCache.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedBlobHash.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedCacheSetup.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedCacheStore.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedCacheVersion.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedFetchDrive.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedRawStore.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedReleaseManifest.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedReleasePrefetch.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedReleaseStorage.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/publishedSkyboxCameraBounds.test.ts | NullEngine；包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/regionViewProtocol.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/runtimeConfig.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneCadReferenceSanitizer.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneFilePath.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneModelSelectionPointer.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/scenePublishScope.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneRuntimeSelection.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneRuntimeShadows.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneSelectionHighlight.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sceneSwitchPublishGuard.test.ts | 包含文件/源码断言候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/skyboxSyncController.test.ts | Node 测试候选 | test、test:ci、test:data-platform-skybox、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/sourceResourcePlan.test.mjs | 包含文件/源码断言候选 | test:source-resource-plan | 未证明跨平台 | 前置 npm run build:electron；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/digitalTwin/staticShadowBake.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/staticShadowReceivers.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/viewerModelClick.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | .github/workflows/ci.yml: windows-latest |
| tests/digitalTwin/viewerTemplateCapabilities.test.ts | Node 测试候选 | test、test:ci、test:digital-twin、test:digital-twin:unit | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/editor/autoPatrol.test.ts | Node 测试候选 | test:auto-patrol | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/editor/autoPatrolPlayback.test.ts | Node 测试候选 | test:auto-patrol | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/builtInSlotAssetSync.test.ts | Node 测试候选 | test:builtin-slot | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/editor/builtInSlotRowReconcile.test.ts | Node 测试候选 | test:builtin-slot-rows | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/editor/dataPlatformSceneResourcePreparation.test.ts | 包含文件/源码断言候选 | test:scene-loading、test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/entityArrayDialog.test.mjs | Node 测试候选 | test:composition-array | 未证明跨平台 | 含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/editor/lightEditor.test.ts | Node 测试候选 | test:light-editor、test:scene-theme | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/lightLibrary.test.mjs | Node 测试候选 | test:light-editor | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/lightSettings.integration.test.mjs | Node 测试候选 | test:light-editor | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/lightSettings.test.ts | Node 测试候选 | test:light-editor、test:scene-theme | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/localSceneEnvironmentChoice.test.ts | 包含文件/源码断言候选 | test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/localSceneRecoveryTransaction.test.ts | 包含文件/源码断言候选 | test:local-scene-recovery、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/modelArray.test.ts | Node 测试候选 | test:model-array | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/editor/modelAssetUpdateMerge.test.ts | Node 测试候选 | test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/modelParameterRestoration.test.mjs | NullEngine | test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/modelStringParameters.test.mjs | 包含文件/源码断言候选 | smoke:model-parameters、smoke:units、test:model-parameters | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/editor/publishModelRecovery.test.ts | Node 测试候选 | test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/remoteDownloadUiContract.test.ts | 包含文件/源码断言候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/restoreFailedSceneResources.test.ts | Node 测试候选 | test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneLatestModelUpdate.test.ts | Node 测试候选 | test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneModelLibrarySync.test.ts | 包含文件/源码断言候选 | test:local-scene-recovery、test:scene-loading、test:scene-model-update、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneModelSyncOverlay.test.mjs | 包含文件/源码断言候选 | test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneModelSyncTransaction.test.ts | Node 测试候选 | test:scene-model-update、test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/scenePreparationInteractionGateContract.test.ts | 包含文件/源码断言候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/scenePreparationProgress.test.ts | Node 测试候选 | test:scene-loading、test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/scenePreparationRuntimeMonitorContract.test.ts | 包含文件/源码断言候选 | test:scene-loading、test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/scenePreparationTimings.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneStartupResourceGate.test.ts | 包含文件/源码断言候选 | test:local-scene-recovery、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneTheme.integration.test.mjs | Node 测试候选 | test:scene-theme | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/sceneTheme.test.ts | Node 测试候选 | test:scene-theme | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/editor/unifiedModelAssetUpdate.test.ts | Node 测试候选 | test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/encoding/cadTextEncoding.test.ts | Node 测试候选 | test:encoding | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/encoding/utf8Integrity.test.mjs | 包含文件/源码断言候选 | test:encoding | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/encoding/utf8Transport.test.ts | Node 测试候选 | test:encoding | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamAvatar.integration.mjs | Electron 候选；包含文件/源码断言候选 | test:manual-roam:integration | 未证明跨平台 | Electron 二进制；前置 npm run build:electron；引用 dist-electron；核对 build:electron 前置 | 否 / 未确认 |
| tests/roam/manualRoamAvatarRuntime.test.ts | NullEngine | test:manual-roam | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/roam/manualRoamCollisionBounds.test.ts | NullEngine | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamCollisionPolicy.test.ts | NullEngine | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamCollisionProxyPool.test.ts | NullEngine | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamControlsContract.test.ts | 包含文件/源码断言候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamCore.test.ts | Node 测试候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamLocalTriangleCollider.test.ts | NullEngine | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamSceneSession.test.ts | 包含文件/源码断言候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/manualRoamSpawn.test.ts | Node 测试候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/roam/manualRoamSpawnContract.test.ts | 包含文件/源码断言候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/roam/proceduralAvatarAnimation.test.ts | Node 测试候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/runtime/environmentAssetContainerCache.test.ts | NullEngine | test、test:ci、test:digital-twin、test:digital-twin:unit、test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | .github/workflows/ci.yml: windows-latest |
| tests/runtime/environmentTransformPreparation.test.ts | NullEngine | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/externalModelScriptLoad.test.ts | 包含文件/源码断言候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/localLightShadows.test.ts | NullEngine | test:light-editor | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/manualRoamAvatarAsset.test.ts | 包含文件/源码断言候选 | test:manual-roam | 未证明跨平台 | Node 原生 strip-types | 否 / 未确认 |
| tests/runtime/materialTextureClone.test.ts | NullEngine | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/modelAssetTemplateCache.test.ts | NullEngine | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/modelInitializationScheduler.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/modelLoadingTraversal.test.ts | NullEngine | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/modelParameterBindingExecution.test.ts | Node 测试候选 | test:unified-model-sync | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/modelParameterExpression.test.ts | Node 测试候选 | test、test:ci、test:coverage、test:expression | 未证明跨平台 | Node 原生 strip-types | .github/workflows/ci.yml: windows-latest |
| tests/runtime/sceneEnvironmentEffects.test.mjs | NullEngine；包含文件/源码断言候选 | test:scene-theme | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/sceneLoadDiagnostics.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/sceneModelReadinessError.test.ts | NullEngine | test:scene-loading、test:scene-model-update | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/sceneRenderReadiness.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/sceneResourceRetry.test.ts | 包含文件/源码断言候选 | test:local-scene-recovery | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/sceneThemeRuntime.test.mjs | NullEngine；包含文件/源码断言候选 | test:scene-theme | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/skyboxContentHash.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/skyboxDecodedData.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/skyboxPrefilter.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/skyboxRuntimeState.test.ts | 包含文件/源码断言候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/skyboxTextureLoad.test.ts | Node 测试候选 | test:scene-loading | 未证明跨平台 | Node 原生 strip-types；含全局状态/环境变量；保留独立进程；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/themeEnvironmentLighting.test.mjs | NullEngine；包含文件/源码断言候选 | test:scene-theme | 未证明跨平台 | Node 原生 strip-types；模块加载 hook；保留进程隔离；该 node 命令 --test-concurrency=1 | 否 / 未确认 |
| tests/runtime/virtualConveyorPackage.test.mjs | NullEngine；包含文件/源码断言候选 | test:virtual-conveyor | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/telemetry/builtinSkyboxAsset.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出；含服务/端口；复核端口与关闭流程 | 否 / 未确认 |
| tests/telemetry/cameraSettings.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorCargoAxialLength.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorCargoLifecycle.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorCargoTravel.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorCargoTravelConfig.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorSurfaceArrowSession.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorSurfaceArrowsConfig.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorTaskHandoff.test.ts | NullEngine；包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/conveyorTelemetryProxy.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/defaultCargoGeneratorSettings.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/deviceSpawn.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/deviceSpawnerRuntime.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/deviceTelemetry.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出；含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/telemetry/deviceTelemetryJsonPathOrdering.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/editorTelemetryConfig.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/electronMqttClientGeneration.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/environmentRuntime.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/environmentSettings.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/fetchSyncIntervalSettings.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/liftDrive.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/locatorFetchRuntime.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/mqttBrowserClientSuback.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/mqttConnectionTest.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出；含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/telemetry/mqttConnectionTestUiContract.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出；含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/telemetry/mqttRuntimeStatus.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/rgvColumnHandoff.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/rgvMotionArrowSession.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/rgvMotionArrowsConfig.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/rgvMotionState.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/runtimeNodeGeometry.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/sceneMigration.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/shadowSettings.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/shuttleDrive.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/skyboxAssetDragPayload.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/skyboxSettings.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/specializedTelemetryBinding.test.ts | 包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerFrontCellDrive.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerMotionArrowSession.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerMotionArrowsConfig.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerMotionState.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerPlatformPlaceHandoff.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/stackerStorageLocation.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/telemetryDeviceTypeNormalization.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/telemetryFrameCaching.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/telemetryPreviewBaseline.test.ts | NullEngine；包含文件/源码断言候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/thinInstanceInstancedMeshCoexistence.test.ts | NullEngine | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/telemetry/virtualConveyorRecognition.test.ts | Node 测试候选 | test:telemetry | 未证明跨平台；junction/symlink 权限 | runner 临时 tsc 编译；junction；清理临时输出 | 否 / 未确认 |
| tests/testGroups.test.mjs | 包含文件/源码断言候选 | test、test:ci、test:groups | 未证明跨平台 | 未静态确认；保留当前运行方式 | .github/workflows/ci.yml: windows-latest |

## Fixture 与 helper（不计独立测试覆盖）

| 文件 | 类型 | 当前 npm 入口 | 平台边界 | 构建前置与隔离要求 | CI 静态可达 |
|---|---|---|---|---|---|
| tests/dataPlatform/fixtures/dataPlatformEnvironmentIndexStub.mjs | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/fixtures/electronStub.mjs | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/fixtures/modelPackageScannerStub.mjs | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/dataPlatform/fixtures/modelUnitsStub.mjs | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/alarmAppearance.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/alarmInspector.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/alarmManager.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/alarmReference.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/autoPatrolCapture.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/builtinSkybox.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/composition-array.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/composition.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/conveyorArrowEffects.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/conveyorSurfaceArrows.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/digitalTwinEffects.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/digitalTwinEffectsGallery.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/digitalTwinInteraction.v1.json | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/dissolveCompletion.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/effectBindingEditor.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/effectPathDrawing.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/environmentBuildingEffect.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/flowArrowDirection.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/generatedFollow.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningDemo.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningDemo.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningEditor.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/geographicOpeningEditor.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningHost.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningHost.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/geographicOpeningHostLegacyViewer.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/lightWallFence.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/lightingTypes.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/model-packages/image-library-texture-drop-check.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/shelf-assets/Shelf.glb | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/shelf-assets/meta.json | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/shelf-assets/shelf.model.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/shelf-assets/shelf.model.txt | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/stacker-assets/Stacker.glb | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/stacker-assets/meta.json | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/stacker-assets/stacker.model.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/stacker-assets/stacker.model.txt | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-assets/YZJ.glb | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-assets/meta.json | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-assets/yzj.model.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-assets/yzj.model.txt | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-conveyor-runtime-check.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-direction-arrow-check.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/model-packages/yzj-reference-parameters-check.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/modelEntrance.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/modelEntranceEditor.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/modelEnvironmentConfiguration.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/openingPackageEditor.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/openingPackageEditor.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/prismaticOpening.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/prismaticOpening.html | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/publishedOpeningHost.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/publishedOpeningUmi.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/rgvMotionArrows.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/sceneTheme.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/fixtures/skyboxMosaic.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/spatialEffectConfiguration.harness.ts | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/fixtures/stackerMotionArrows.harness.tsx | fixture / harness | 辅助文件，不计执行覆盖 | 未证明跨平台 | 含全局状态/环境变量；保留独立进程 | 否 / 未确认 |
| tests/helpers/alarmTestModules.mjs | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/helpers/conveyorSurfaceArrowModules.mjs | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 模块加载 hook；保留进程隔离 | 否 / 未确认 |
| tests/helpers/extensionlessTypeScriptTestBootstrap.ts | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/helpers/playerContractTestHelpers.ts | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/helpers/rgvMotionArrowFixture.mjs | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |
| tests/helpers/stackerMotionArrowFixture.mjs | helper | 辅助文件，不计执行覆盖 | 未证明跨平台 | 未静态确认；保留当前运行方式 | 否 / 未确认 |

## 必须人工复核的动态调用

- 动态子进程需复核：scripts/smoke-skybox-mosaic.mjs（其子测试不计为已覆盖）
- 动态子进程需复核：scripts/test-model-download-progress.mjs（其子测试不计为已覆盖）
- 动态子进程需复核：tests/dataPlatform/environmentBindingAuthority.runner.mjs（其子测试不计为已覆盖）
