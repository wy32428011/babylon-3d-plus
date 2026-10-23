# 本机 Blender 烘焙引擎配置

## 目标与约束

用户已确认 UI 示意：光照与烘焙管理器 / 总览与烘焙 / 烘焙参数中增加本机引擎入口；发布缺少 Blender 时可打开同一个配置窗口。配置属于当前系统用户，所有工程共用，不进入场景或发布包。保留工作区既有修改，不提交、推送、远端发布或修改用户真实 AppData；验收使用隔离用户目录。

## 实施与验收清单

- [x] 主进程提供本机配置读取、原生路径选择、指定路径检测、原子保存和恢复自动查找；保留未知字段，错误不覆盖旧值。
- [x] 检测只验证所选可执行文件与 Blender >= 4，返回实际版本和设备；区分配置路径、实际生效路径和环境变量优先来源。
- [x] 管理器按已确认的深色紧凑界面接入同一配置窗口；保存不改变场景和撤销历史；烘焙进行中禁止修改。
- [x] 部署导出和数据中台发布提供缺少引擎的配置入口；保存后保留原表单并刷新检查，不绕过已有发布校验。
- [x] 针对性测试覆盖保存、重新读取、无效路径保留、自动查找、环境变量和读写失败。
- [x] 真实 Electron UI 验证选择、检测、保存、重开和进程重启；真实 Blender 版本/设备检测与烘焙；正式本地 DIST 导出及 Viewer 读取。
- [x] 类型检查、受影响构建与定向 lint、代码/安全审查完成；记录实际证据和验证边界（全量清单生成的既有摘要漂移单独保留）。

## 分工

- 主代理：配置对话框、管理器接入、任务文档、整体验证与交付。
- 后端代理：配置服务、检测、IPC、双 preload、全局 API 类型与后端回归。
- 发布代理：两个发布窗口与公共检查组件、相关回归。
- 验收代理：独立真实 Electron / Blender / 本地导出 smoke；构建后统一运行。

## 检查记录

- 已核实当前引擎读取顺序：环境变量、本机 JSON、系统默认安装目录；旧检测会回退其他候选，因此指定路径检测需要独立验证。
- 当前工作区已有大量光照、性能和发布相关未提交修改；仅在现有内容上做必要增量。
- 部分源码由本机透明加密机制管理，PowerShell 读取呈二进制；Node fs 可读取明文，读取和修改时使用受支持路径，禁止将密文作为文本重写。
- `npm run test:lighting-engine-configuration` 22/22 通过；后端含原有 backend/preflight 共 27/27 通过。配置模块行覆盖率 100%、分支 89.36%、函数 87.5%，不将模拟版本子进程作为真实 Blender 证据。
- 完整 `npm run typecheck`、最终 `npm run build:electron`、`npx vite build`、`npm run build:viewer` 和受影响 17 文件 ESLint 均退出 0；Editor/Viewer 构建有原有大 chunk 提示。
- 新 npm 命令与 `test-entry-manifest.json` 完全一致，已更新该元数据的分类摘要。全量清单生成被入场已存在且本轮未修改的 `scripts/smoke-lighting-bake-electron.mjs` 分类摘要漂移阻断；未替其他任务更新该摘要，也未把清单生成记作通过。
- 真实 UI 第二轮已验证版本/CPU、配置保存/错误保留/重启、自动发现、390px及发布表单保持，Cycles生成7表面/12探针并完成正式保存。仓库 output 下正式导出复制292文件后rename出现EPERM，原始报告保留在 `output/lighting-engine-configuration/1792742072553-19be7469/`，改用本次专属临时输出目录复验，不修改发布器。
- 人工截图发现原生dialog在`height:auto`下因上下定位伸满视口，与已确认紧凑示意不符；已改为`height:fit-content`，下一轮以实际窗口高度/表单高度断言复验。

## 最终实机验收

- `node scripts/smoke-lighting-engine-configuration.mjs` 最终 PASS，报告 `output/lighting-engine-configuration/1792742592897-0b434bf7/result.json`。正式API、双preload、原生文件选择器以及真实 EditorLayout 均运行交付实现，仅系统文件选择器由夹具返回本次已授权路径。
- 本机真实 Blender 5.2.2 / CPU：选择、指定路径检测、保存JSON、无效路径拒绝且旧文件逐字节不变、关闭重开、整个Electron重启读回、恢复自动安装目录发现均通过。真实UI场景内容保持不变。
- 配置窗口桌面高度紧贴表单，390px下无水平溢出且底栏可操作；部署导出 Esc/保存后工程名与ZIP选择保留；中台发布 Esc/保存后名称、备注与Origin保留，无项目绑定时确认发布保持禁用，未向真实中台提交。
- 实际Cycles生成7个表面和12个探针，正式场景保存通过；UI正式DIST目录导出成功（296文件、25.6MiB级别，以截图/正式进度为准），目录位于报告的 `uiExports`。独立正式Viewer导出也成功。
- Viewer报告 `output/lighting-engine-configuration/1792742592897-0b434bf7/viewer-1792742718962-50260825/result.json`：9份光照资产完整读取且摘要一致，硬件Intel UHD630/WebGL2、真实MQTT升降/回落和静态GI稳定通过，无未恢复网络错误、页面异常、GPU/shader错误。首次初始化取消请求另有恢复记录，不计为未恢复失败。
- 主代理已人工检查实际配置窗口、窄屏与导出成功截图。编辑端捕获8条通用 `ERR_FILE_NOT_FOUND` 控制台记录，报告保留但未附URL，未进一步归因；本次PASS不表示编辑器所有控制台诊断均为零，Viewer有独立完整性及失败检查。
- 本次两轮Electron所有8个已记录PID均退出，Editor/MQTT及Viewer两个loopback端口均拒绝连接，专属bootstrap已移除，`cleanupErrors=[]`；保留隔离工程、输出与原始失败报告用于审查。
- 范围：代码及本地Editor/Electron/Viewer构建完成；未重打安装包、未更新已安装编辑器、未操作用户真实AppData/工程、未远端发布、未提交推送。
