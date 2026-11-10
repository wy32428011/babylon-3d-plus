# AGENTS.md

## 范围与项目概况

本文件是 ZENDING 3D EDITOR（`zending-3d-editor`）的跨工具共享工程指令，适用于整个仓库。处理子目录时同时遵守该范围已有的局部指令；用户明确要求优先于本文件。Claude Code 通过根目录 `CLAUDE.md` 导入本文件。

项目是 Electron 桌面数字孪生 3D 编辑器，附带可发布的 Web Viewer。用户说明入口为 [README.md](README.md)，专题和验收记录在 `docs/`；持续有效的工程约束写在这里，一次性进度留在任务记录。

## 技术栈与架构

依赖版本和 npm 脚本以 `package.json` 为准，安装使用仓库的 `package-lock.json`。当前主要版本为：

- Node.js `^22.15.0 || >=24.0.0`，CI 使用 Node 22；TypeScript 6、ESM。
- Electron 42；Vite 8 + `@vitejs/plugin-react`；React 19 + Zustand 5。
- Babylon.js 9.12：`@babylonjs/core`、`loaders`、`serializers`、`ktx2decoder`；场景使用 WebGL。
- MQTT 使用 `mqtt`，CAD 使用 `@linkiez/dxf-renew`，归档使用 `fflate` / `archiver` / `unzipper`。
- 测试使用 Node 内置 `node --test`；TS 入口按原脚本使用 strip-types 或 transform-types；浏览器/Electron 验收使用 Playwright。

| 路径 | 职责与修改入口 |
| --- | --- |
| `electron/main.ts`、`electron/preload.cts`、`electron/preload.ts`、`electron/ipc/` | 桌面生命周期、受控桥接与 IPC；主窗口加载编译后的 `preload.cjs` |
| `electron/lighting-bake/` | Blender/Cycles 离线烘焙服务 |
| `src/editor/model/`、`src/editor/store/`、`src/editor/commands/` | 场景领域模型、状态与撤销/重做 |
| `src/editor/panels/`、`src/editor/hierarchy/`、`src/editor/cad/`、`src/editor/deployment/` | 编辑器面板、层级、CAD 与发布流程 |
| `src/runtime/` | Babylon 场景同步、MQTT、漫游、巡检、特效与历史回放 |
| `src/player/`、`vite.viewer.config.ts` | 发布后的 Web Viewer 与模板构建 |
| `src/shared/`、`src/server/`、`src/standalone-opening/` | 共享逻辑、本地服务、独立开场 |
| `scripts/`、`tests/`、`tests/fixtures/` | 工具入口、领域测试和夹具 |

## 开发与构建

命令在仓库根目录运行。已有依赖可直接使用，不为修改文档重新安装依赖。

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖，适用于 CI 或全新检出 |
| `npm run dev:electron` | 启动完整桌面编辑器，自动选端口并预热 renderer |
| `npm run dev` | 仅启动 `127.0.0.1` 上的 Vite renderer，不能证明 Electron IPC 正常 |
| `npm run typecheck` | 检查 renderer 并编译 Electron，会更新 `dist-electron/`、增量缓存并复制烘焙 Python 脚本；不是全仓所有源码及测试的类型检查 |
| `npm run typecheck:quality` | 检查 `tsconfig.quality.json` 指定的纯模块与类型依赖 |
| `npm run build` | TypeScript 构建、Vite renderer 构建及 Viewer 模板构建 |
| `npm run build:electron` | 单独构建 Electron 产物 |
| `npm run build:viewer` | 单独构建 Viewer 模板 |

不要以绕过官方启动器、关闭安全边界或软件 WebGL 回退的方式掩盖启动问题；先查看实际编译、Electron 和视口日志。启动与常见问题见 [README.md](README.md)。

## 实现约束

- `SceneDocument` 是可持久化场景数据的权威来源。编辑操作通过 `src/editor/commands`，保留撤销/重做；Babylon 对象承载运行时状态，不能成为持久化业务状态的另一份权威副本。
- renderer 通过 preload、受控 IPC 和 `editor-asset://` 访问本地文件与资产；新增能力沿现有桥接契约实现，不直接在 renderer 使用 Node API。
- 使用 Babylon 原生渲染能力，不引入 Three.js 或 React Three Fiber 替换现有运行时。按项目所用 SDK 版本核对 API。
- 光源、ENV/IBL 和阴影使用 Babylon 原生能力（`ShadowGenerator` / `CascadedShadowGenerator`）；间接光由 Blender/Cycles 生成独立资产，Viewer 消费成品。遵守 [混合光照指南](docs/hybrid-lighting.md)，不增加自研深度或阴影替换路径。
- 场景单位为米。导入、尺寸、参数变更保持源单位与换算契约，并运行 `npm run smoke:units`。
- 保留旧场景加载、资源修订及 SOURCE/DIST 发布兼容性；打开旧文件不能自行写盘或触发 Blender。参数化工作台改动参考 [工作台说明](docs/parametric-authoring-workbench.md)。
- 性能改动优先减少加载、同步和编辑开销。默认关闭的新优化保持关闭，不写入场景配置，不改变旧场景行为。共享几何、材质与缓存必须保持实例隔离和释放所有权，参考 [模型运行时优化](docs/babylon-model-runtime-optimization.md)。
- 代码风格以 `.prettierrc.json` 和 ESLint 配置为准：单引号、分号、尾随逗号、宽度 100。`npm run format` / `format:check` 只处理四份配置文件，不对全仓批量格式化。
- 文件使用 UTF-8（无 BOM），中文保持可读；编码逻辑变更运行 `npm run test:encoding`。

## 测试与验收

先选择 `package.json` 中与变更相关的领域入口，再运行 core。常见对应关系：

| 变更范围 | 定向入口 |
| --- | --- |
| 手动漫游、人物动作 | `npm run test:manual-roam` |
| 光源编辑 | `npm run test:light-editor` |
| 统一光照、烘焙与管理器 | `npm run test:lighting-unified`、`npm run test:lighting-bake`、`npm run test:lighting-manager` |
| 模型缓存、实例化和材质隔离 | `npm run test:babylon-optimization` |
| 场景加载 | `npm run test:scene-loading` |
| 参数化模型 | `npm run test:model-parameters`，并按尺寸变更运行 `npm run smoke:units` |

提交前的 CI 门禁依次包括：

```bash
npm run typecheck
npm run typecheck:quality
npm run test:entries
npm run lint
npm run format:check
node scripts/generate-test-inventory.mjs --check
npm test
```

- `npm test` / `npm run test:ci` 只执行 core；`npm run test:integration`、`npm run test:smoke` 是独立组。core 通过不能表述为全仓测试通过。
- 新增、移动或修改测试入口、测试文件、夹具后，复核分类与前置，再执行 `node scripts/generate-test-inventory.mjs` 更新清单并以 `--check` 校验。不要手改生成的 [测试清单](docs/test-inventory.md)。分组和隔离规则见 [测试说明](docs/test-groups.md)。
- 保留各入口的独立进程、构建前置、临时目录和清理逻辑；GPU、性能采样和烘焙不要并发抢占资源。
- 浏览器/WebGL、Electron、Blender/Cycles、真实资源及安装包检查按任务单独运行；分别报告实际运行命令、结果、未运行项与原因。Node/NullEngine、静态登记、跳过用例不能代替真实渲染或实机性能证据。

## 资源与生成物

- 不手改 `node_modules/`、`dist/`、`dist-electron/`、`dist-viewer-template/`、`release/`、`*.tsbuildinfo` 等生成物；修源码或生成脚本，再通过相应入口生成。`build/icon.ico` 是受跟踪的打包输入，`build/` 不能整体当作生成目录删除或禁止维护。
- `output/`、`artifacts/`、`.babylon-editor/`、`Assets/`、`SharedResources/`、`Platforms/`、`Conflicts/` 属于验收输出或本机工程数据；未经任务明确要求，不修改、清理或提交其中内容。不得使用真实工程替代隔离测试夹具。
- 模型资产索引通过 `npm run refresh:model-assets` 刷新，不手写；执行前核对目标资源根目录，避免改写非任务范围的工程数据。

## 技能选用

技能用于补充专项工作流程，不能替代项目约束或测试。以下三项已由本机 `skills-lock.json` 和 `.claude/skills/` 验证；安装目录当前被 Git 忽略，全新克隆不能假设已经安装。

| 技能 | 来源 | 使用范围 |
| --- | --- | --- |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | React 组件、重渲染、异步与 bundle 性能；按 Vite renderer 选规则，不套用 Next.js/RSC/Server Actions 专属实现 |
| `web-design-guidelines` | `vercel-labs/agent-skills` | 面板、对话框、Viewer 的界面与可访问性审查；按其说明获取远程指南，获取失败时说明依据限制 |
| `digital-twin` | `magnus919/agent-skills` | 孪生身份、同步契约、仿真、可信度与反馈权限；普通 3D 建模或界面修改不触发整套治理流程 |

- 这些技能是外部技能库提供的指南，不称作 Babylon 官方技能。当前未核实安装 Babylon 专项技能；Babylon 开发以官方 SDK 文档、项目源码及领域测试为依据。
- 仅在当前工具明确列出时使用 `blender`、`ui-ux-pro-max`、工程类等可选技能；Blender 技能不等于 Blender MCP 已连接。Three.js 技能的引擎 API 不适用于本 Babylon 运行时。
- 缺少技能时按项目代码和权威文档完成任务；不要为填满技能清单自动安装插件、修改权限或接入外部服务。需要共享新技能时单独核实来源、许可和安装方式。

## 提交与文档维护

- 仅在用户要求时提交或推送。提交信息使用 Conventional Commits 前缀加中文描述，例如 `fix: 修正模型参数同步`。
- 用户可见变更同步 `docs/changelog.md` 或对应专题文档，README 保留入口索引。PR 说明包括实际检查结果和未运行的 GPU/Electron/Blender 验收。
- 跨工具共用约束只维护在本文件；Claude 专属说明放 `CLAUDE.md`，个人偏好留在用户级配置。新增局部规则先核对对应目录是否确有例外，避免重复和相互冲突。

## 指令格式依据

遵循 [AGENTS.md 官方约定](https://agents.md/) 的普通 Markdown、就近范围与可执行指令原则；Codex 的发现与覆盖规则见 [官方项目指令说明](https://developers.openai.com/codex/guides/agents-md)。Claude 的加载与技能配置依据见根目录 `CLAUDE.md`。官方规范不要求项目安装特定第三方技能库。
