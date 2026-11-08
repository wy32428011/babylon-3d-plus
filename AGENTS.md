# AGENTS.md

ZENDING 3D EDITOR（`zending-3d-editor`）：基于 Electron + Vite + React + TypeScript + Babylon.js 的桌面数字孪生 3D 编辑器，附带可发布的 Web Viewer（player）。面向用户的说明见 `README.md` 与 `docs/`，本文件只写给编码代理。

## 技术栈

- 渲染：`@babylonjs/core` / `loaders` / `serializers` / `ktx2decoder` 9.12（WebGL；不使用 three.js）
- UI：React 19 + Zustand 5，Vite 8（`@vitejs/plugin-react`）
- 桌面：Electron 42（主进程 `electron/main.ts`，受控 preload `electron/preload.ts`）
- 语言：TypeScript 6，ESM（`"type": "module"`）
- 其他：`mqtt`（设备遥测）、`@linkiez/dxf-renew`（CAD）、`fflate` / `archiver` / `unzipper`（打包）
- 测试：Node 内置 `node --test`（TS 测试用 `--experimental-strip-types` 或 `--experimental-transform-types`），浏览器/Electron 验收用 Playwright
- Node：`^22.15.0 || >=24.0.0`，CI 使用 Node 22

## 常用命令

```bash
npm install
npm run dev:electron      # 开发版 Electron 编辑器（自动选端口并预热 renderer）
npm run dev               # 仅 Vite renderer，127.0.0.1
npm run typecheck         # TypeScript 类型检查
npm run typecheck:quality # 新纯模块未使用项检查
npm run lint              # ESLint（仅 error 失败）
npm run format:check      # 只检查 4 份配置文件格式
npm test                  # core 测试组，等同 npm run test:ci
npm run test:integration  # 集成组
npm run test:smoke        # 完整容量 smoke
npm run build             # 完整构建（含 build:viewer）
```

提交前至少通过与 CI 一致的门禁：`npm run typecheck`、`npm run typecheck:quality`、`npm run test:entries`、`npm run lint`、`npm run format:check`、`node scripts/generate-test-inventory.mjs --check`、`npm test`。

- 只改某个子系统时，先跑 `package.json` 中对应的 `test:<领域>` 脚本（如 `test:manual-roam`、`test:light-editor`、`test:babylon-optimization`），再跑 core 组。
- 新增或移动测试入口、夹具后，执行 `node scripts/generate-test-inventory.mjs` 更新清单；分组规则见 `docs/test-groups.md`，平台与隔离要求见 `docs/test-inventory.md`。
- 需要 Blender、GPU、真实 WebGL 或 Electron 的检查（`*.webgl.mjs`、`*.ui.mjs`、`*:electron`、`smoke:*`）不进入 core 组，需单独运行，并如实报告是否已运行。

## 目录结构

- `electron/`：主进程、IPC（`electron/ipc`）、preload、离线光照烘焙（`electron/lighting-bake`）
- `src/editor/`：编辑器 UI 与领域模型（`store`、`commands` 撤销/重做、`panels`、`hierarchy`、`model`、`cad`、`deployment` 等）
- `src/runtime/`：Babylon 运行时（`babylon` 场景同步、`mqtt`、`roam` 漫游、`patrol` 巡检、`effects`、`history` 时光回溯）
- `src/player/`：发布后的数字孪生 Viewer
- `src/shared/`、`src/server/`、`src/standalone-opening/`：共享代码、本地服务、独立开场
- `scripts/`：构建、演示、smoke、资产维护脚本（`.mjs`）
- `tests/`：按领域分目录（`editor`、`runtime`、`roam`、`lightingBake`、`digitalTwin`、`encoding` 等），夹具在 `tests/fixtures`
- `docs/`：专题文档、任务验收记录（`docs/tasks/`）、变更记录 `docs/changelog.md`

不要手改以下生成物或本机数据：`node_modules/`、`dist/`、`dist-electron/`、`dist-viewer-template/`、`build/`、`output/`、`artifacts/`、`release/`、`*.tsbuildinfo`、`.babylon-editor/`、`Assets/`、`SharedResources/`、`Platforms/`、`Conflicts/`。模型资产索引用 `npm run refresh:model-assets` 刷新，不手写。

## 代码约定

- Prettier：单引号、分号、尾随逗号、`printWidth: 100`。`npm run format` 只格式化配置文件，不要对全仓批量格式化。
- 文件统一 UTF-8（无 BOM），中文文本须保持可读；改动编码相关逻辑后运行 `npm run test:encoding`。
- 场景与模型以米为单位；改动导入、尺寸或参数逻辑后运行 `npm run smoke:units`。
- 编辑操作经 `src/editor/commands` 形成可撤销命令，场景数据以 SceneDocument 为唯一数据源，运行时增量同步，不在 Babylon 对象上直接存业务状态。
- renderer 不直接使用 Node 能力；本地文件与资产通过 preload 受控 API、受控 IPC 和 `editor-asset://` 协议访问。
- 光源与阴影只使用 Babylon 原生能力（`ShadowGenerator` / `CascadedShadowGenerator`、ENV/IBL），不要自研深度或阴影替换路径；间接光烘焙走 Blender/Cycles 独立资产流程（见 `docs/hybrid-lighting.md`）。
- 性能优化优先做程序级改进（加载、同步、编辑开销），默认关闭的新优化不得写入场景配置，也不得改变旧场景行为。

## 提交与 PR

- 提交信息使用 Conventional Commits 前缀加中文描述，如 `feat: 接入参数化模型工作台`、`fix: …`、`perf: …`、`docs: …`。
- 用户可见的变更需同步 `docs/changelog.md` 或对应专题文档；README 只保留索引。
- PR 说明需列出已运行的检查命令，以及未运行的 GPU/Electron/Blender 验收。
