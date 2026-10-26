# Babylon 原生无限远天空盒与 `.env` 资源链路改造方案

日期：2026-10-25  
基线：`F:\babylon-3d-plus` 当前工作树，HEAD `d96ec04`，Babylon.js 实际安装版本 `9.12.0`。  
状态：**2026-10-26 实现已完成，关键本机验收通过；综合回归仍有入场即存在的非天空盒失败，不宣称全仓测试全绿。R1–R12 的实现、证据与限制见下表及第 14 节。**

## 0. 结论、范围与阅读方法

本次按对话中连续确认的目标设计，不再保留两种天空显示模式作为最终产品：

1. 所有场景统一使用 Babylon 原生无限远天空盒。
2. HDR/EXR 保留为导入、重新生成、SOURCE 和烘焙的原始资产。
3. 解码、全景转立方体、球谐与预过滤前移到编辑端资源准备阶段，生成 `.env`。
4. Editor 正常渲染及新版 Viewer 的天空盒路径只消费已生成的 `.env`；Viewer 不回退运行时 HDR/EXR 转换。
5. 清理有限球体的移动、缩放、拾取、聚焦、相机边界与可视距离规则。
6. 保存、打开、资源同步、恢复、光照烘焙、SOURCE/DIST、独立部署、缓存、诊断、构建和测试一起调整。

这比“只把 CreateSphere 换成 createDefaultSkybox”范围大得多。前述仅显示替换的文件数量估算，不能用于本次完整 `.env` 链路。

### 调查覆盖

- 扫描 2,031 个仓库文本文件；直接命中 319 个文件，调用链补充 36 个文件，共 **355 个索引项**。
- 其中：**85 个现有文件列为明确修改入口**（包含配置及维护文档）、**8 个文件保留算法但迁出 Viewer 天空转换路径**、**1 个有限球体模块退役**；另有 68 个保留/关联审查项、166 个测试/夹具/脚本候选、27 个历史文档或清单项。
- 这不是说要修改全部 355 个文件。导入类型名、通用哈希工具、空场景测试夹具也会命中；必须区分语义影响与文本引用。
- 完整路径、分类、命中行号见：[完整引用索引](2026-10-25-native-skybox-impact-index.md)。本文件解释各领域如何改以及如何验收。
- 排除 `node_modules` 的全量扫描、构建输出、旧运行产物、Python 字节码和用户实际工程目录；Babylon 相关 API 只定向核对已安装实现。不以扫描结果冒充实际场景验收。
- 当前工作树有大量已有修改。实施前应刷新相关文件状态，按当前文件集成，不 reset、覆盖或清理其他任务改动。

### 明确不做

不引入 SkyMaterial/体积云/天气系统，不自动更换照明预设，不降低旧分辨率或预过滤质量，不修改中台服务端上传协议，不批量转换用户全部历史项目，不提交、推送或对外发布。

## 1. 原始基线事实（改造前快照，行号为调查时记录）

| 事实 | 代码证据 | 对方案的影响 |
| --- | --- | --- |
| 当前是 10 km 有限球体、PBR 材质、可拾取实体，资源完成后再安装反射纹理 | [SceneSkyboxRuntime.ts:221](../../src/runtime/babylon/SceneSkyboxRuntime.ts:221)、[SceneDocument.ts:90](../../src/editor/model/SceneDocument.ts:90) | 不能只改创建函数；生命周期和交互都需要处理 |
| 运行时仍做 Worker 解码、立方体转换、HDR 预过滤 | [SceneSkyboxRuntime.ts:248](../../src/runtime/babylon/SceneSkyboxRuntime.ts:248) | 必须切开“编辑端生成”和“运行时消费”依赖 |
| 原生 helper 已提供 infiniteDistance、ignoreCameraMaxZ、不可拾取，且默认会写 scene.environmentTexture | [安装版 sceneHelpers.pure.js:86](../../node_modules/@babylonjs/core/Helpers/sceneHelpers.pure.js:86) | 使用 PBR 分支并传 setGlobalEnvTexture=false，统一照明仍由项目管理 |
| 项目按模块导入 Babylon，目前副作用入口没有显式注册 sceneHelpers | [babylonSideEffects.ts](../../src/runtime/babylon/babylonSideEffects.ts) | 实施时补可靠注册，验证开发与生产包，不能假设原型方法必然存在 |
| 已有离线 Sandbox `.env` 路径 | [SandboxEnvironmentRuntime.ts:64](../../src/runtime/babylon/SandboxEnvironmentRuntime.ts:64) | 复用加载模式，但不要把所有上传天空替换成 Sandbox 图像 |
| 当前 Hierarchy 实际过滤天空盒实体 | [hierarchyRows.ts:19](../../src/editor/hierarchy/hierarchyRows.ts:19) | 沿用场景设置与资源库作为主入口；不把“恢复层级条目”混为已有功能 |
| 自定义源格式、序列化和部署校验只接受 HDR/EXR | [components.ts:39](../../src/editor/model/components.ts:39)、[SceneSerializer.ts:373](../../src/editor/project/SceneSerializer.ts:373)、[deploymentExportScene.ts:1118](../../electron/ipc/deploymentExportScene.ts:1118) | 不能仅将 sourceUrl 改成 .env 或全局给旧 format 联合类型加 env |
| 有两份 preload；真实主窗口加载 preload.cjs | [electron/main.ts:206](../../electron/main.ts:206)、[preload.ts](../../electron/preload.ts)、[preload.cts](../../electron/preload.cts) | 新转换桥接必须同时覆盖 .ts、.cts、类型声明和测试 |
| 本地 HTTP 协商缓存白名单没有 `.env`，但部署资产类型推断已经认识 `.env` | [editorAssetCacheHeaders.ts:13](../../electron/ipc/editorAssetCacheHeaders.ts:13)、[deploymentExportScene.ts:1148](../../electron/ipc/deploymentExportScene.ts:1148) | 补缺失处，不误把已支持的通用分类重写 |
| 内置轻量天空包严格要求仅一个 HDR 文件 | [builtinSkyboxAssets.ts:29](../../electron/ipc/builtinSkyboxAssets.ts:29) | 不可直接往原包里塞 env；增加独立登记的派生包 |
| GI 捕获有读取旧 sceneSettings.skybox 的分支，无原图时可能取平均环境辐照度 | [lightingRuntimeCapture.ts:94](../../src/runtime/babylon/lightingRuntimeCapture.ts:94)、[SceneLightingRuntime.ts:334](../../src/runtime/babylon/SceneLightingRuntime.ts:334) | 必须统一解析实体/旧字段/实际照明来源，不能因格式替换静默退化 |
| GI 签名包含天空实体组件；搬迁等价校验也涉及资源字段 | [sceneLightingBakeContract.ts:277](../../electron/shared/sceneLightingBakeContract.ts:277)、[sceneLightingBakeRelocation.ts:62](../../electron/shared/sceneLightingBakeRelocation.ts:62) | 新派生描述不能整体参与物理输入签名；不得重签已经过期结果 |
| 编辑器支持正交投影和六面视角 | [ArcRotateCameraViewController.ts:221](../../src/runtime/babylon/ArcRotateCameraViewController.ts:221) | 原生 helper 的默认盒尺寸不能未经测试就当成所有视口的完整解决方案 |

## 2. 唯一需求与验收总表

以下是唯一验收总表。实现全部落地；“通过”仅指列出的实际检查，不覆盖第 14 节明列的环境及既有失败限制。证据目录为 `output/native-skybox-implementation-20261025/`。

| ID | 要求 | 实现与实际证据 |
| --- | --- | --- |
| R1 | 统一原生无限远天空 | 已实现；真实 GPU 验证 12 三角形、不可拾取、25 km 平移无背景变化，透视/正交正确；移除球内外拾取、Gizmo、F 聚焦和相机边界规则。 |
| R2 | 运行期不再转换 HDR/EXR | 已实现；编辑端编译器与 ENV-only runtime 分离；实际导出 Viewer 无 HDR/EXR 和天空转换 Worker 请求，读取 ENV 后正常运行。 |
| R3 | 上传/导入资源可生成产物 | 已实现；真实 Electron 导入/改分辨率/失败重试通过；六种 EXR 离线编译通过；中台与多场景发布使用本地模拟服务验证，不等同真实中台生产验收。 |
| R4 | 原资产与派生产物分离 | 已实现；源 SHA、ENV SHA、recipe 和 faceSize 独立校验；原图保留；SOURCE 双资源，DIST/独立导出仅 ENV。 |
| R5 | 旧数据可迁移但不伪装视觉无变化 | 已实现；v1–v7 可读取、v8 拒绝；旧位姿保留，不再驱动背景或抬高可视距离；界面明确说明；真实保存/重开不改原图。 |
| R6 | 光照语义保持 | 已实现；真实 GPU 捕获在生成/搬迁 ENV 前后使用同一原图、强度、37°旋转和 GI 签名，背景隐藏保留 IBL；Sandbox 独立；无原图且实际需要原图的重新烘焙被拒绝。实际 Blender 环境节点检查通过，完整 Cycles 回归受既有探针断言阻断。 |
| R7 | 异步切换和恢复可靠 | 已实现；52 项定向组包含取消出队、共享消费者、会话隔离；真实 GPU 验证 A→B→A、失败保留、迟到销毁、context restore；真实转换验证 commit 回调取消不提交、提交中取消及时发送主进程取消。 |
| R8 | 所有发布入口一致 | 已实现；最新 SOURCE/DIST 集成、真实 Electron 目录/ZIP 导出通过，实际独立 Viewer 已打开；校验未引用资源剔除、内置库不随包复制、orphaned、固定 SHA 与最终复制。 |
| R9 | 缓存与授权不退化 | 已实现；旧受控 URL、源 SHA 版本化读取、主进程授权、畸形 ENV、损坏缓存重建、Junction 拒绝与缓存租约回归通过；不回退外网转换。当前会话租约保守保留，满额时明确提示完成操作后重开工程释放。 |
| R10 | 就绪与诊断真实 | 已实现；编译与读取/上传分阶段，失败不变 ready；真实重开等待总加载蒙版消失，记录 stable=true、forcedSettled=false；设置区显示实际 ENV 状态与重试。 |
| R11 | 画质与成本有证据 | 已提供同原生网格编码 A/B、六方向天空与三种粗糙度金属；256/512 对照最大通道差为 1/255，低于预冻结预算；有三次页面冷编译及每档十次 ENV 加载数据。不是旧有限球体逐像素兼容承诺，也不是工厂 FPS 或峰值显存结论。 |
| R12 | 维护闭环 | 已完成类型检查、Editor/Electron/Viewer 构建、ESLint、52 项专项、14 项登记/版本兼容检查；测试入口与生成清单、功能/操作/发布/光照/缓存文档已更新。综合回归的既有失败保持原样并列于第 14 节。 |

## 3. 数据契约与版本设计（A）

### 3.1 源、派生、显示、照明分别建模

共享契约已落在 `electron/shared/sceneSkyboxContract.ts`，由 Editor、主进程、Viewer 和发布器共用。**实际实现保留现有扁平 HDR/EXR 源字段，新增独立 `environment` 描述和仅运行包使用的 `sourceAvailable:false`；没有把旧 `format` 扩为 ENV。**这避免重写中台源协议，仍满足源/派生的独立身份和位置。下列 nested source 结构是原设计建议，不是当前 API：

```ts
type SkyboxSource = {
  format: 'hdr' | 'exr';
  sha256: string;
  dataPlatformResourceId?: string;
  location?: { packagePath: string; sourcePath: string; sourceUrl: string };
};

type SkyboxEnvironment = {
  format: 'env';
  sourceSha256: string;
  recipeKey: string;
  sha256: string;
  byteLength: number;
  faceSize: 256 | 512 | 1024;
  sourceUrl: string;
  sourcePath?: string;
  packagePath?: string;
};

type PreparedSkyboxResource = {
  version: 1;
  source: SkyboxSource;
  environment?: SkyboxEnvironment;
};
```

具体规则：

- Editor/SOURCE 必须保留可重新获取的源 location；新 Viewer 快照可以只有源身份、不含本机原图地址，但必须有有效 environment。
- 未准备好的编辑资产允许 environment 缺失；这不是 runtime ready。运行时所需资源缺失时进入准备/错误状态。
- 场景的目标 resolution 与产物 faceSize 必须一致；不能在后台生成失败后悄悄使用另一档。
- 继续以实体 `transform.rotation.y` 作为已有水平旋转权威来源；兼容读取旧 `rotationDegrees`。本轮不增加第二套可同时写入的 yaw。
- 位置、缩放、X/Z 倾斜只保留为旧数据，不再驱动无限远背景网格；不擅自归零或销毁。
- `lighting.environmentIntensity` 仍是强度唯一来源；旧天空盒 intensity 只按现有迁移规则读取。
- 队列进度、AbortController、临时路径、错误对象放运行状态，不混进场景可序列化契约。
- 引用者通过统一 resolver 获取 `source` 与 `environment`，不要每个调用点自己判断新旧字段。

### 3.2 文件版本

调查时外层场景版本为 6；现在已采用场景文件 v7，并显式兼容 1–6，使旧编辑器不会静默丢弃派生描述或仍按有限球体解释。以下为本轮遵循的迁移规则：

- 在 `sceneFileVersion.ts` 显式保留 1–6 支持，再加入 7。不能只把 CURRENT 改为 7，因为当前白名单中的 6 由 CURRENT 提供。
- 旧文件打开时做内存迁移，源文件不自动覆盖；原图已存在则在准备阶段生成 env，成功后用户保存为新格式。
- 共享版本判断涉及 14 个 Electron 入口，均已列入索引：项目打开、SOURCE 读取、本地恢复、发布快照、发布身份、CAD 清理与烘焙资源入口不能遗漏。
- 旧 Viewer 不承诺解释新格式；新版发布必须验证模板能力。已经部署的旧包不在线修改，需重新发布才能切换新天空。
- 文件版本、天空派生 recipe、光照配置版本、烘焙签名版本、发布 manifest 版本分别维护，不混用。

### 3.3 必改位置

| 文件 | 修改内容 |
| --- | --- |
| [components.ts](../../src/editor/model/components.ts)、[SceneDocument.ts](../../src/editor/model/SceneDocument.ts) | 新资源结构、校验、默认值、旧数据适配；退役球体尺寸函数及运行语义；唯一实体约束保留 |
| [SceneSerializer.ts](../../src/editor/project/SceneSerializer.ts) | 兼容旧扁平/实体资源，移除球体尺度归一化与最低可视距离迁移；按源工程/运行快照区分字段完整性 |
| [sceneFileVersion.ts](../../electron/shared/sceneFileVersion.ts) | 新版本及完整旧版本白名单 |
| [sceneResourceTraversal.ts](../../electron/shared/sceneResourceTraversal.ts) | 按 source/environment 两个资源拥有者枚举；区分原图与派生可重建资源；新 URL 不进入普通业务参数替换 |

不能仅给旧 `SkyboxFormat` 加 `'env'`：中台 API 和原图校验仍只支持 HDR/EXR，应定义独立运行时格式。

## 4. 编辑端预处理服务与资产存储（C、E）

### 4.1 推荐运行位置

采用**编辑端专用转换队列＋受控主进程持久化**：

- CPU 解码仍使用现有 Worker/缓存/双线性转换。
- GPU 预过滤和 env 导出在 Editor renderer 的专用离屏 canvas/Engine 上执行；按需创建，队列复用，用完释放。不绑定当前业务 Scene，也不依赖用户已经打开 3D 视口。
- 主进程负责授权源读取、生成任务身份、索引、暂存、校验和原子提交；Node 主进程不直接调用需要 WebGL 的转换 API。
- 首版 GPU 转换并发 1，CPU 队列沿用有界机制。不要每次切换场景创建一批不受控 Engine。
- 普通 Web Editor 只消费已经准备的 env；持久化迁移通过桌面编辑器完成。内置资源预生成，避免无工程主页使用天空还必须现场转换。

### 4.2 生成步骤

1. 主进程对已授权原文件校验实际类型、大小和源 SHA；不要只相信 renderer 自报的 assetRevision。
2. 依据源 SHA、面尺寸、Babylon 版本、双线性转换版本、预过滤参数、env 编码形成 recipeKey。
3. 命中有效产物则返回；同 key 的并发消费者复用准备任务，不重复转换。
4. 解码原图、转换六面，保持当前方向、线性空间、经度循环/纬度钳制与采样质量。
5. 执行原有质量的预过滤（当前代码约定 4096 采样），等待球谐数据；不将未过滤纹理冒充预过滤 env。
6. `CreateEnvTextureAsync(texture, { imageType: 'image/png' })` 导出。显式固定编码，而非依赖库默认值。
7. 主进程校验 env 元数据、六面/Mip 范围、大小与 SHA；renderer 重新加载验证实际可用。
8. 再核对源 SHA 和请求代次，写暂存后原子提升；才更新派生索引及消费者绑定。
9. 失败保留原始资产和旧有效产物，记录错误并可重试；不把“原图导入成功”冒充“env 准备成功”。

### 4.3 能力与离线边界

安装版 `CreateEnvTextureAsync` 明确要求 GPU 支持 float 或 half-float render。转换前检查，无法满足则报“当前设备无法生成环境资源”，不能输出不完整文件或静默降低质量。

现有 Worker 对部分 EXR 压缩类型返回 unsupported 并走 Babylon 备用解码。迁移时保留该功能，但确保备用路径的解压依赖来自本地构建；不能在离线导入 ZIP/ZIPS/PXR24 EXR 时再临时请求 CDN。新增所需依赖须先核实锁文件/已安装包，不能假定已支持。

### 4.4 存储与缓存策略

- 原图继续存放当前源包；不覆盖、不删除。
- 生成缓存建议放项目 `.babylon-editor/skybox-derived/<sourceSha>/<recipe>/`；目录由主进程选定，不接受 renderer 指定任意目标。
- SOURCE 中将实际引用的派生资源映射到独立 `Assets/Skyboxes/Runtime-<hash>-<recipe>/` 包，避免破坏原图单文件包约束。
- 内置天空的派生资源使用单独登记目录，不向 `partly-cloudy-light` 源目录直接加文件。
- 源 SHA、env SHA、recipeKey 分开校验。旋转、强度、曝光、显隐、相机位置不进入产物 key。
- 文件型产物缓存采用有界空间策略；正在使用或等待发布的产物持有租约。清理不能删除源文件或其他任务资源。
- 已取消的 GPU 工作不能中途释放输入纹理；安全结束后清理，禁止提交。一个消费者取消不能误杀其他消费者的共享任务。

### 4.5 触发入口

| 入口 | 要做什么 |
| --- | --- |
| 本地导入 | 源导入成功后准备默认所需分辨率；UI 分开显示“已导入/处理中/可用/失败” |
| 中台资源同步 | 源同步事务保持原子性；仅对当前引用、用户选用或发布所需的资源准备 env，不默认转换整库 |
| 选择/拖入天空 | 统一走同一准备器；拖放位置不再作为球心 |
| 修改分辨率 | 准备新 recipe，成功后提交匹配产物；旧有效画面可继续显示，但当前请求不算 ready |
| 打开旧场景/SOURCE | 资源恢复后、业务运行时就绪前确保 env；不能卡成“等 runtime 加载原图、runtime 又等 env”的循环 |
| 中台同步/本地修复换回原图 | 按最终源内容身份重选产物，不能沿用旧 env |
| 独立导出/中台发布/非入口场景 | 对捕获快照中引用的所有天空准备 env，不只依赖当前活动 Scene |

### 4.6 必改位置

- [assetIpc.ts:168](../../electron/ipc/assetIpc.ts:168)、[projectAssetStore.ts:965](../../electron/ipc/projectAssetStore.ts:965)：源导入接口保持原义，增加派生查询/提交或准备协调入口；源扫描与产物索引分离。
- [electron/types.ts](../../electron/types.ts)、[preload.ts](../../electron/preload.ts)、[preload.cts](../../electron/preload.cts)、[vite-env.d.ts](../../src/vite-env.d.ts)：新增有界类型化协议、取消及进度订阅；主进程绑定 sender、任务 token 和合法源身份。
- [AssetDatabase.ts](../../src/editor/assets/AssetDatabase.ts)、[skyboxAssets.ts](../../src/editor/assets/skyboxAssets.ts)、[projectLibrary.ts](../../src/editor/assets/projectLibrary.ts)、[projectLibrarySyncContracts.ts](../../src/editor/panels/project-library/projectLibrarySyncContracts.ts)：资源元数据、拖放载荷、重关联和准备状态。源 ID 与来源/availability 规则不放宽。
- [builtinSkyboxAssets.ts](../../electron/ipc/builtinSkyboxAssets.ts)、[内置许可](../../public/builtin-skyboxes/LICENSE.md)、[package.json](../../package.json)：登记原图和派生文件各自的路径/哈希/许可，安装包正确分发。

保留但回归：`skyboxAssetStore.ts` 的源安全校验，`dataPlatformSkyboxContract.ts` 的服务端 HDR/EXR 协议，`dataPlatformSkyboxIndex.ts` 的 stable ID/orphaned/原图 SHA，`dataPlatformSkyboxSync.ts` 的整批原子同步，`skyboxSyncController.ts` 的会话取消机制。若要合并显示转换进度，应使用独立阶段，不把源同步完成定义悄悄改掉。

## 5. 原生 runtime 与资源生命周期（B）

### 5.1 SceneSkyboxRuntime

修改 [SceneSkyboxRuntime.ts](../../src/runtime/babylon/SceneSkyboxRuntime.ts)：

- 移除运行时对 PreparedSkyboxTexture、Bilinear HDR/EXR、prepareSkyboxData、HDRFiltering 的值导入。
- 从经验证的 environment 描述加载 `CubeTexture`，Blob URL 路径要显式标明 `.env`，不能按 Blob URL 后缀猜格式。
- 天空资源签名使用 env 内容 SHA、recipe 和面尺寸，而不是只用原图 SHA。弱身份路径仍需隔离，不得误复用。
- 注册原生 helper，使用 PBR、零模糊基线、`setGlobalEnvTexture=false`；旋转只应用在约定的纹理方向上，不再同时旋转背景网格。
- 不创建可编辑球体占位。无有效资源时使用现有 clearColor/加载 UI；有旧有效资源则保留到新候选提交。
- 逻辑 skybox 实体存在性与 GPU mesh 是否已创建分开，避免 `hasCompleteRuntimeEntity` 在加载期间反复触发全量同步。
- 移除天空选择高亮层和 selected/pickable 球体流程；不销毁普通模型的共享选择系统。
- 原生 helper 会 clone 反射纹理，释放时区分背景 clone、主 IBL、Sandbox、内部共享纹理。不能因清除背景误 dispose 仍被照明使用的资源。
- URL 生命周期覆盖正常加载、clone、取消、替换、Scene dispose 和 context restore；不提前 revoke，也不永久泄漏。
- 背景与 scene IBL 绑定同源时协调提交；来源为 Sandbox 时，背景替换不触碰 Sandbox 纹理。

### 5.2 原生 helper 不是全部渲染约束的替代品

必须检查正交大范围、极宽视口、透视、透明物体和远距离模型。`ignoreCameraMaxZ` 是 Babylon 绘制时的相机投影处理，不等于业务网格必然不会被天空遮挡，也不保证默认 size=1000 适配任意正交范围。

以原生 helper 为基线，必要时只对背景网格调整内部尺寸、绘制次序与深度写入策略；不回退到限制用户相机，也不修改全部业务 mesh 的渲染组。具体配置须通过专项真实 WebGL 验证后固定。无限远背景不能被普通静态冻结流程冻结为不再随相机更新的世界矩阵。

### 5.3 相关入口

- [EnvironmentAndSkyboxController.ts](../../src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts)：目标改为有效 env 资源及旋转/显隐；保留统一强度、草稿预览恢复、readiness 和 trace 会话身份。
- [SceneDocumentController.ts](../../src/runtime/babylon/scene-runtime/SceneDocumentController.ts)：增量/全量同步、逻辑实体存在性接新 runtime，不依赖旧球体已经创建。
- [babylonSideEffects.ts](../../src/runtime/babylon/babylonSideEffects.ts)：可靠注册 helper；保留 spherical polynomial 等现有扩展。
- [skyboxTextureLoad.ts](../../src/runtime/babylon/skyboxTextureLoad.ts)：共享下载/取消/Blob 生命周期可以保留，但运行期阶段与编辑端转换阶段拆分。
- [SandboxEnvironmentRuntime.ts](../../src/runtime/babylon/SandboxEnvironmentRuntime.ts)：保持原有 `.env` 基线、离线地址与独立照明语义，主要做接线与回归。

### 5.4 迁出 Viewer 而不是删除的模块

以下 8 个模块转为编辑端转换依赖，保留算法与已有测试：

`PreparedSkyboxTexture.ts`、`BilinearSkyboxTexture.ts`、`skyboxDecodedData.ts`、`skyboxDecodedData.worker.ts`、`skyboxDecodedCache.ts`、`skyboxDecodedValidation.ts`、`skyboxPanoramaSampling.ts`、`skyboxPrefilter.ts`。

具体目录可按编辑资产服务归档，不为改名而大搬迁。关键是生产 Viewer 的天空加载依赖不再触达它们。

特别保留 `skyboxContentHash.ts`：它实际复用通用 SHA-256，发布缓存、开场素材等还在引用。不能按名字把所有 skybox 文件删除。

## 6. 编辑交互、相机与业务排除（D）

| 文件/入口 | 修改方案 |
| --- | --- |
| [SceneSettingsPanel.tsx:606](../../src/editor/panels/SceneSettingsPanel.tsx:606) | 改为“天空背景”；保留选择、水平旋转、清除和质量档；显示源格式与运行时 ENV 状态；移除 10 km/12 km 提示 |
| [InspectorPanel.tsx:511](../../src/editor/panels/InspectorPanel.tsx:511) | 移除球体直径、尺寸倍率及 position/scale 说明；旧选中态显示配置摘要或引导场景设置，不显示虚假可操作 Transform |
| [ProjectPanel.tsx:1635](../../src/editor/panels/ProjectPanel.tsx:1635) | 导入→准备→应用，重关联后重新匹配 env；“放置并选中球体”改为“应用天空背景”；源/派生进度区分 |
| [SkyboxLibraryTab.tsx](../../src/editor/panels/project-library/SkyboxLibraryTab.tsx) | 源可用性与派生状态分别展示，提供重试；orphaned 规则不变 |
| [useSceneAssetDropHandler.ts:127](../../src/editor/panels/scene-view/useSceneAssetDropHandler.ts:127) | 拖入只选择资源，不将 placementPosition 写入天空；普通模型拖放保持 |
| [sceneEnvironmentOperations.ts](../../src/editor/store/slices/sceneEnvironmentOperations.ts) | upsert 不抬高相机距离、不改变球心；保留唯一性、旧源引用和现有隐藏祖先语义 |
| [projectAssetsSlice.ts:344](../../src/editor/store/slices/projectAssetsSlice.ts:344)、[editorStoreTypes.ts:354](../../src/editor/store/slices/editorStoreTypes.ts:354) | 应用/清除/分辨率命令接准备器；变更名称、撤销边界及 placementPosition 参数；异步结果只提交当前请求 |
| [sceneDocumentSlice.ts:654](../../src/editor/store/slices/sceneDocumentSlice.ts:654)、[entityValueOperations.ts](../../src/editor/store/slices/entityValueOperations.ts) | 阻止通用入口再修改天空位置/缩放；去掉等比缩放特殊处理；复制/粘贴/阵列的场景唯一性限制保留，更新文案 |
| [SceneViewPanel.tsx:772](../../src/editor/panels/SceneViewPanel.tsx:772)、[TransformGizmoController.ts](../../src/runtime/babylon/TransformGizmoController.ts) | 天空不挂移动/缩放/实体旋转 Gizmo；去掉只有天空使用的 uniformScale 路径前先确认其他调用 |
| [SceneTransformPreviewController.ts](../../src/runtime/babylon/scene-runtime/SceneTransformPreviewController.ts) | getGizmoTarget、preview、commit 三处不再返回/修改天空 mesh，防止群组操作旁路 |
| [ScenePickingAndSelectionController.ts:67](../../src/runtime/babylon/scene-runtime/ScenePickingAndSelectionController.ts:67) | 天空始终排除拾取，移除球内外距离判断；覆盖 CPU/GPU 拾取和框选 |
| [SceneWorldBoundsController.ts:242](../../src/runtime/babylon/scene-runtime/SceneWorldBoundsController.ts:242)、[useSceneFocusTransition.ts:27](../../src/editor/panels/scene-view/useSceneFocusTransition.ts:27) | 不返回天空几何 bounds；移除天空 F 聚焦和临时 20 km 距离；混选/全场景聚焦忽略天空 |
| [selectionAndViewportSlice.ts:208](../../src/editor/store/slices/selectionAndViewportSlice.ts:208)、SceneSerializer、SceneSettingsPanel | 移除天空导致的最低 12 km；已有保存的 camera.viewDistance 保持，不主动缩短 |
| [PlayerApp.tsx:683](../../src/player/PlayerApp.tsx:683) | 移除天空球边界实例创建与两条清理分支；保留正常相机、巡检与漫游自己的限制 |
| [publishedSkyboxCameraBounds.ts](../../src/player/publishedSkyboxCameraBounds.ts) | 所有调用和替代回归就绪后退役整个有限球体边界模块 |

背景 metadata 建议使用语义明确的新标记，同时兼容识别旧标记，避免一次性改名导致排除规则失效。以下四处须同步：

- [manualRoamCollisionPolicy.ts](../../src/runtime/roam/manualRoamCollisionPolicy.ts)
- [manualRoamCollisionBounds.ts](../../src/runtime/roam/manualRoamCollisionBounds.ts)
- [modelTriangleStatistics.ts](../../src/runtime/babylon/modelTriangleStatistics.ts)
- [SceneShadowRuntime.ts](../../src/runtime/babylon/SceneShadowRuntime.ts)

`hierarchyRows.ts` 当前已隐藏天空，保留；`HierarchyPanel.tsx`、`sceneEntityArrayOperations.ts`、`entityClipboardOperations.ts` 继续验证唯一性与隐藏规则，不为了新天空添加模型树条目。

`createEngine.ts`、`ArcRotateCameraViewController.ts` 作为正交/透视和保存视角的关联回归入口，不预设必须修改相机业务。

## 7. 光照、显示与 GI（H）

### 保持的规则

- `appearance.skyboxVisible` 控制背景，不重置环境强度。
- scene/Sandbox 来源切换仍由统一光照配置决定，主光和补光不自动变化。
- 旧实体及父级隐藏对 scene 来源的既有影响需要保留或显式迁移；不能把“外观隐藏”与“停用实体”混为一谈。
- `SceneAppearanceRuntime` 的曝光、ACES、雾和泛光不随 `.env` 换格式重设。
- `refreshSceneLightingMaterialDrawCaches` 仍用于环境切换/旋转，尤其不能漏掉离场实例源和冻结材质。
- 昼夜周期仍只在已授权的统一参数上作用，旋转/强度更新不触发 env 重新生成。

### 必改位置

1. [lightingRuntimeCapture.ts:67](../../src/runtime/babylon/lightingRuntimeCapture.ts:67)：统一解析实际照明源。scene 来源从新 source 或旧实体/扁平字段取原图；不要按最终 env URL 决定是否使用原始全景。
2. [SceneLightingRuntime.ts:334](../../src/runtime/babylon/SceneLightingRuntime.ts:334)：更新捕获日志和状态判断；不能对所有 `.env` 都提示“采用平均辐照度”，也不能掩盖缺少烘焙源图。
3. [sceneLightingBakeContract.ts:277](../../electron/shared/sceneLightingBakeContract.ts:277)：从源身份、有效旋转、强度等真正输入构造签名，不把 environment 的路径、缓存元数据、任务时间或新字段整体纳入。
4. [sceneLightingBakeRelocation.ts](../../electron/shared/sceneLightingBakeRelocation.ts)：将新源/产物的运输地址与物理输入区分；SOURCE/DIST 路径改写只在等价证明成立时保留烘焙结果。

### 已烘焙场景的迁移

保留旧签名验证分支。旧结果先按旧规则确认本来有效，再检查迁移前后的真实输入等价。若捕获从平均环境改为方向性原图、旋转发生实际变化或编码影响超出认可范围，应明确要求重新烘焙。

禁止通过“移除验证、重算签名写回”让旧结果看起来有效。场景外层版本变化不等于烘焙结果自动兼容。

`lightingBakeService.ts` 的 `.hdr/.exr` 白名单、`lightingBakeValidation.ts`、二进制传输、预检和 `cycles_bake.py` 继续消费原图，不扩展为读取 Babylon `.env`。Sandbox 的已有平均环境策略也不能在本次被未经说明地改变。

## 8. 加载就绪、打开入口和诊断（F）

把阶段分为两组：

- 编辑准备：`source-read / decode / convert / prefilter / encode / validate / commit`。
- 运行消费：`env-read / env-decode-upload / material-ready / first-frame`。

这些名字是建议新增的诊断字段，不把旧 `prefiltering` 强行重命名后继续承载多种工作。

### 资源需求判断

- 可见背景需要 env 就绪。
- 隐藏背景但 scene IBL 仍使用它，需要 env 就绪。
- 隐藏背景且使用独立 Sandbox，不启动无用的背景转换，也不被其失败阻塞；重新显示时恢复真实状态。
- 新资源失败但旧画面仍在显示，应报告新目标错误，不把旧画面当作新资源 ready。
- 保持当前“必需资源＋首帧验证”契约，不引入默认渐进加载。

### 涉及入口

- [HomePage.tsx](../../src/editor/home/HomePage.tsx)、[ProjectPanel.tsx](../../src/editor/panels/ProjectPanel.tsx)：主页进入、本地加载、资源同步/恢复完成后接统一准备器；本地工程不自动联网。
- [scenePreparationProgress.ts](../../src/editor/loading/scenePreparationProgress.ts)、[projectOpenTrace.ts](../../src/editor/loading/projectOpenTrace.ts)、[共享 projectOpenTrace.ts](../../electron/shared/projectOpenTrace.ts)：加入派生资源准备真实阶段与会话 token，保留可取消和进展判定。
- [SceneViewPanel.tsx:1681](../../src/editor/panels/SceneViewPanel.tsx:1681)：重试先修复/生成产物，再重试 runtime；修改“读取、解码或预过滤”文案和等待条件。
- [SceneTriangleAndReadinessController.ts](../../src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts)、[SceneLoadDiagnostics.ts](../../src/runtime/babylon/SceneLoadDiagnostics.ts)、[SceneRuntime.ts](../../src/runtime/babylon/SceneRuntime.ts)、[sceneRuntimeTypes.ts](../../src/runtime/babylon/scene-runtime/sceneRuntimeTypes.ts)：readiness、诊断快照、错误传播与任务结束边界。
- [PlayerApp.tsx](../../src/player/PlayerApp.tsx)、[playerInitialLoadMonitor.ts](../../src/player/playerInitialLoadMonitor.ts)：env 读取/上传/材质/首帧状态；取消旧“准备天空盒光照”运行期预过滤描述，保持超时提示与停滞判定。

不能在 ProjectPanel 和 SceneViewPanel 各启动一次相同转换；统一任务身份和 in-flight 复用。

## 9. 保存、恢复、SOURCE/DIST 与独立导出（G）

### 9.1 三种交付边界

| 类型 | 必须携带/保留 | 不应携带/执行 |
| --- | --- | --- |
| 本地源工程 | 原图、源身份、生成配方、可用 env 引用 | 不自动覆盖旧场景文件，不删除原图 |
| SOURCE | 引用的原图＋场景参数；建议同时携带已认证 env 以便离线重开 | 不复制整个缓存库，不丢失重新生成和烘焙能力 |
| DIST/独立部署 | 实际需要的 env、运行参数、源内容身份和完整性清单 | 不携带原图路径作为必需资源，不运行 HDR/EXR 预处理 |

若包内只保留 env，runtime 快照必须显式允许无源 location，不能留下指向未打包 HDR 的“正常”URL。

### 9.2 准备顺序

捕获场景快照 → 完成必要资源恢复/重关联 → 准备该快照的 env → 验证 runtime 与 GI 状态 → 验证 Viewer 能力 → 收集文件/改写引用 → 生成 hash 清单/压缩 → 原子完成包。

处理全部待发布场景，包括非入口场景；背景隐藏但 SOURCE 仍保留的资产要按源工程契约收集。所有步骤绑定 requestId、sceneSessionId 和快照内容，取消或切换后不能提交旧绑定。

### 9.3 前端修改

- [useDeploymentExport.ts:265](../../src/editor/deployment/useDeploymentExport.ts:265)：当前直接 serialize 后调用 exportWebProject，需加入 env 准备和相应取消路径；不能只改中台发布按钮。
- [useDigitalTwinPublish.ts](../../src/editor/deployment/useDigitalTwinPublish.ts)、[preparePublishScene.ts](../../src/editor/deployment/preparePublishScene.ts)：资源恢复后、等待 runtime 前确保产物；GI 准备使用源身份。
- [preparePublishSceneSnapshots.ts:18](../../src/editor/deployment/preparePublishSceneSnapshots.ts:18)：已有 prepareSkyboxes 钩子应升级为完整源/产物准备，覆盖非入口场景，避免临时 runtime 内部解码原图。
- [repairPublishSceneSkyboxes.ts](../../src/editor/deployment/repairPublishSceneSkyboxes.ts)：复制/失效新派生引用，不能只更新旧六个字段而留下旧 env。
- [deploymentExport.ts](../../src/editor/deployment/deploymentExport.ts)、[DeploymentExportDialog.tsx](../../src/editor/deployment/DeploymentExportDialog.tsx)：资源统计区分逻辑天空数量与实际源/产物文件，显示预处理状态。

### 9.4 主进程修改

| 文件 | 修改内容 |
| --- | --- |
| [deploymentExportScene.ts](../../electron/ipc/deploymentExportScene.ts) | 分离源引用解析与运行资源解析；新 env 文件进入显式 bundle；按角色改写；保留路径和 SHA 校验，不把 `.env` 格式伪装为 HDR |
| [deploymentSkyboxCache.ts](../../electron/ipc/deploymentSkyboxCache.ts) | 现有 stable ID 校验继续针对源；补 sourceSha＋recipe→env 的解析及独立完整性校验 |
| [digitalTwinSourcePackage.ts](../../electron/ipc/digitalTwinSourcePackage.ts) | 源包与派生包分别登记；稳定天空子树的跳过逻辑不能把新 env 引用漏掉；保留源 ID/orphaned 提示 |
| [digitalTwinDistPackage.ts](../../electron/ipc/digitalTwinDistPackage.ts) | 接收已准备 runtime 快照，验证 env 资源完整，再生成 DIST |
| [viewerTemplateCapabilities.ts](../../electron/ipc/viewerTemplateCapabilities.ts) | 增加天空契约/文件版本能力，验证实际构建入口和资源；旧模板明确拒绝新需求 |
| [publishSceneSnapshots.ts](../../electron/ipc/publishSceneSnapshots.ts) | 原有资源字段更新白名单需认识源/派生资源；只允许经过验证的资源变化，不放松实体身份/参数/绑定保护 |
| [publishSkyboxRecovery.ts](../../electron/ipc/publishSkyboxRecovery.ts) | 源恢复后失效不匹配产物，内容相同搬迁可复用；不可拿 env 哈希去匹配中台源图 |
| [localSceneResourceRecovery.ts](../../electron/ipc/localSceneResourceRecovery.ts)、[localSceneRecoveryService.ts](../../electron/ipc/localSceneRecoveryService.ts) | 原图缺失与可重建 env 缺失分开；前者走现有授权恢复，后者进入编辑端重建；原图/产物的 SHA 校验各自正确 |
| [dataPlatformSceneRelocation.ts](../../electron/ipc/dataPlatformSceneRelocation.ts) | 新嵌套拥有者 URL/路径随 SOURCE 重定位，身份元数据不当文件路径处理 |

`digitalTwinPublishService.ts`、`digitalTwinPublishResourceRecovery.ts`、`dataPlatformProjectService.ts`、`projectIpc.ts`、`dataPlatformIpc.ts`、`deploymentExportIpc.ts`、`digitalTwinPublishIpc.ts` 等协调入口列为关联审查。尽量让准备发生在明确层次，避免在每个入口复制同一套转换代码。

现有部署资产推断已经把 `.env` 识别为 texture；秘密文件排除中的文件名 `.env` / `.env.*` 是另一含义。必须继续防止打包配置秘密，不能为了环境纹理把该保护整体删除。产物使用 `environment.env` 等明确文件名。

## 10. 下载协议、缓存、安全与构建（I、J）

### 缓存/协议

- [editorAssetCacheHeaders.ts](../../electron/ipc/editorAssetCacheHeaders.ts)：为授权的 `.env` 加协商缓存；脚本/JSON 既有 no-store 规则不动。
- [electron/main.ts:231](../../electron/main.ts:231)、[assetRegistry.ts](../../electron/ipc/assetRegistry.ts)：验证新产物通过正常受控授权读取；不扩大任意目录读取权限。
- `runtimeAssetFetch.ts` / `editorAssetUrl.ts`：保持部署虚拟 URL 解析和下载缓存入口，env 不能绕过它们另行裸 fetch。
- `publishedAssetCache.ts`、`publishedRawStore.ts`、`publishedReleaseCache.ts`、`publishedReleaseStorage.ts`、`publishedCacheVersion.ts`：主要保留。新 env 必须进入原发布清单，使用自身 SHA/size，查询参数规范化不得误用源 SHA。
- `deploymentPrecompression.ts`：按现有文件清单生成压缩伴生文件，回归 env 实际响应及版本切换，不无依据改压缩算法。
- 原解码 IndexedDB 留给转换器；不在每次打开场景时全库清理，也不删除其他功能借用的缓存。

### 安全约束

源文件继续沿用 512 MiB/像素等现有上限。env 新增：文件魔数/版本、有界头部、合法 faceSize、六面与 Mip 数量、有限且不越界的 offset/length、声明图像尺寸、球谐数值有限性、文件大小/SHA、源 SHA 与 recipe 一致性检查。

路径只由受控项目/缓存/内置资源映射产生；拒绝符号链接/Junction 越界、协议混淆、未知 sender 和伪造任务。无需在 UI 里开放“任意输出路径”来写 env。

### 构建

- [vite.config.ts](../../vite.config.ts)：转换服务仅由编辑入口引用；内置 env 和转换所需本地解码依赖正确分发。
- [vite.viewer.config.ts](../../vite.viewer.config.ts)：能力清单包含新天空契约，验证生产输出；避免把编辑转换器和自定义解码 Worker 打入 Viewer 必要代码。
- [package.json](../../package.json)：内置产物打包、新专项测试入口和必要的预生成命令。默认不升级 Babylon 或其他无关依赖。
- `scripts/babylon-build-chunks.ts` / build-analysis 工具：主要用于验证新增 helper/转换依赖对 bundle 的影响，不因改天空就重写全局切包。

验收要区分“没有运行旧转换链”与“Babylon 通用加载器内部完全不存在任何 HDR/EXR 字符串/可选模块”。硬指标是 Viewer 天空路径不请求原图、不启动自定义转换 Worker、不调用 HDRFiltering，不用字符串全局零命中冒充依赖分析。

## 11. 建议新增模块（名称可按项目风格收敛）

以下都是建议路径，当前尚不存在：

| 建议路径 | 职责 |
| --- | --- |
| `electron/shared/sceneSkyboxContract.ts` | 源/运行资源、recipe、迁移、校验与角色解析 |
| `electron/ipc/skyboxDerivedAssetStore.ts` | 内容寻址、源与产物验证、暂存、原子提交、租约/受控清理 |
| `electron/ipc/skyboxPreparationIpc.ts` | 准备 token、授权查询、提交/取消与进度；或小范围合并到现有 assetIpc |
| `src/editor/assets/skyboxPreparationService.ts` | 全 Editor 共用准备队列、消费者复用、会话取消 |
| `src/editor/assets/skyboxEnvironmentCompiler.ts` | 专用 Engine、原算法解码/预过滤、env 导出和重新加载验证 |
| `src/runtime/babylon/skyboxEnvironmentResource.ts` | 只负责验证后的 env 读取/上传/签名，不导入编译器 |
| `scripts/prepare-builtin-skybox-env.mjs` | 显式生成并核验内置产物的开发工具，不在 Viewer 执行 |

不要机械拆成大量控制器：共享契约、编辑准备、文件存储、运行消费四个职责清楚即可。新增 IPC 注册可复用 assetIpc 的现有注册入口，是否增加独立文件由代码体量决定。

## 12. 测试、脚本与证据安排

### 12.1 现有专项入口如何处理

| 领域 | 现有测试/脚本 | 处理 |
| --- | --- | --- |
| 场景设置 | `tests/telemetry/skyboxSettings.test.ts` | 更新有限球体、缩放、12 km、旧格式期待；保留保存/旋转/唯一性/撤销断言 |
| 相机边界 | `tests/digitalTwin/publishedSkyboxCameraBounds.test.ts` | 用“无限远不钳制相机＋正常相机限制仍有效”回归替代，不只删除测试 |
| 生命周期 | `tests/runtime/skyboxRuntimeState.test.ts`、`skyboxTextureLoad.test.ts` | 保留 A→B→A、迟到、取消、失败、重试；换成 env 描述并检查 clone 释放 |
| 解码/采样 | `skyboxDecodedData.test.ts`、`skyboxContentHash.test.ts`、`skyboxFallbackSampling.test.ts`、`skyboxPanoramaSampling.test.ts`、`skyboxPrefilter.test.ts` | 转为编辑转换器回归；不得因 Viewer 不再使用就删掉格式覆盖 |
| 缓存 | `skyboxHttpCache.integration.mjs`、`skyboxDecodedCache.integration.mjs`、`publishedAssetCache.test.ts`、`editorAssetCacheHeaders.test.ts` | 新 env 身份、热命中、损坏重建、源版本与 recipe 变化 |
| 同步/恢复 | `tests/dataPlatform/skybox*.test.ts`、`publishSkyboxRecovery.test.ts`、`repairPublishSceneSkyboxes.test.ts` | 原 stable ID/SHA/orphaned/安全约束不变；新增重关联后派生绑定校验 |
| 发布 | `deploymentSkyboxCache.test.ts`、`digitalTwinSourcePackage.test.ts`、`sourceResourcePlan.test.mjs`、`viewerTemplateCapabilities.test.ts` | 源/产物双角色、env-only DIST、旧模板拒绝、非入口场景、SOURCE 重定位 |
| 光照 | `sandboxEnvironmentRuntime.test.mjs`、`canonicalEnvironmentLighting.test.mjs`、`glbStandardPreview.webgl.mjs`、`sceneLightingRuntime.test.mjs`、烘焙搬迁/持久化测试 | 背景隐藏、Sandbox、离场实例源、原图 GI 输入、签名迁移、已有过期结果不得复活 |
| 打开/首帧 | `sceneStartupResourceGate.test.ts`、`sceneEnvironmentReadinessContract.test.ts`、`playerInitialLoadMonitor.test.ts`、`playerInitialLoadRenderState.test.ts` | 编译与 env 消费阶段分离，失败/取消/缺资源不提前完成 |
| 安装/内置 | `builtinSkybox.test.ts`、`builtinSkybox.integration.mjs`、`builtinSkyboxAsset.test.ts` | 原图单文件包与独立 env 包、安装路径、许可、实际发布文件 |

完整索引包含 132 个测试/夹具文件和 34 个脚本/入口登记命中。许多集成夹具只含 `skybox: null` 或共用签名，先保持原测试意义；不要批量把旧数字/字段替换掉以求通过。

### 12.2 新增回归主题

- 新旧天空契约迁移、源位置可选边界、v1–v7 读取门禁。
- 主进程产物校验、并发去重、原文件中途变化、假 SHA、越界路径、临时写入失败。
- `.env` 六面/Mip/球谐/LOD 参数 round-trip；PNG/RGBD 转换误差。
- EXR 各原有压缩支持的离线编译，float/half-float 能力不足的显式失败。
- 正交/透视、极宽视口、远近模型、透明物体、相机快速移动。
- 选择、框选、Gizmo、混合聚焦、漫游碰撞、模型统计、阴影和 GI 几何排除。
- Editor 切项目、切场景、撤销、连续改分辨率和 A→B→A；共享消费者分别取消。
- WebGL context lost/restored 后 env、背景 clone、IBL 恢复；循环切换无持续纹理/内存增长。
- 新 Viewer 冷缓存也只请求 env；阻断 HDR/EXR 地址和转换入口仍能完整显示。
- SOURCE 多场景重开与独立目录/ZIP、中台 SOURCE+DIST 的完整准备路径。
- 物理光照输入不变时只换路径/缓存不使 GI 无故失效；真正变更时必须失效。

### 12.3 画质对照必须分离变量

**对照 A：只比较编码。**同一个原生无限远网格、同相机/曝光/色调映射/IBL 参数，将当前算法生成的内存立方体与其导出后重载的 env 比较。这用于判断 env 编码和重载误差。

**对照 B：只比较天空显示语义。**同纹理比较旧有限球体与新无限远背景，明确标记旧球心偏移、缩放、倾斜导致的预期差异。不能把这些差异归罪于 env，也不能宣称全面替换后逐像素相同。

数值检查覆盖六面/Mip、球谐、强光与暗部；视觉检查覆盖天空接缝、太阳、低/高粗糙度金属、普通 GLB、Standard 基础对象、烘焙对象和移动设备。误差门槛应在实施基线阶段冻结，不在看到失败结果后放宽。PNG 图像编码不等于对源 Float32 数值无损。

### 12.4 性能与运行证据

- 使用同一源文件、面尺寸、采样质量和目标 GPU，对比首次生成成本、再次打开的天空阶段、完整首帧与下载字节。
- 冷缓存至少 3 次、热缓存至少 10 次作为初始采样建议；分别报告中位数与尾部，不混同生成成本和运行收益。
- Viewer 新路径 HDR/EXR 请求数、自定义转换 Worker 数、HDRFiltering 调用数必须为 0。
- `.env` 自身解析、PNG 解码和上传仍计时，不能伪装为零成本。
- 测试时不并发烘焙/构建/profile 干扰性能；需要真实 WebGL，不以 NullEngine 或 Mock 证明画质与显存。
- 无预先承诺的 FPS 倍数或加载百分比；性能结论以产物版本和实测报告为准。

### 12.5 测试入口与文档维护

实施中按阶段运行新增定向用例，再覆盖 `test:scene-loading`、`test:data-platform-skybox`、`test:lighting-unified`、相关发布/烘焙及实际 WebGL 回归；最终 typecheck、lint、Editor/Viewer build。具体测试名新增后再登记，不在本次虚构已存在命令。

更新 `scripts/test-entry-manifest.json`、`scripts/test-entry-classification.json`、`docs/test-inventory.md` 时遵循现有生成流程；若既有摘要漂移，应报告和定位，不改摘要绕过门槛。

维护文档：README、features、editor-operations、scene-web-export、hybrid-lighting、published-viewer-cache、test-groups。历史 changelog/release/旧方案保留原事实，增加取代关系而不是全局替换“球形”字样。

## 13. 实施顺序、完成条件和回退

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| P0 基线与契约 | 冻结源样本、旧视觉/光照行为，验证原生 helper 的正交/深度边界，确定新契约及误差预算 | 原生兼容性有真实证据；新/旧数据和验收规则明确 |
| P1 共享协议与转换闭环 | 新契约、v7 门禁、编辑队列、IPC、产物存储、内置预生成 | 导入→生成→重载→校验闭环；失败/取消不破坏原图 |
| P2 原生 runtime 与交互清理 | env-only runtime、删除有限球体规则、配置入口调整 | Editor 可完整使用；无隐式 raw 回退；相机/拾取/光照正确 |
| P3 打开/恢复/光照迁移 | 全打开入口、恢复、就绪、GI 源解析与受控签名迁移 | 新旧工程均能按规则完成准备；不会平均光降级或重签旧失效结果 |
| P4 所有发布入口 | SOURCE、DIST、独立导出、非入口场景、模板能力、缓存清单 | 新 Viewer 离线资源闭环；缺产物/旧模板明确拒绝 |
| P5 完整回归与收尾 | 实机、性能、context restore、故障注入、测试入口和文档 | R1–R12 全部有交付版本证据或用户明确批准的范围变化 |

开发期间可以分阶段提交本地候选，不代表完成；对用户交付时不留下“新 Viewer 仍临时解码 HDR”“非入口场景未处理”等半条链路。

回退保留原 HDR/EXR、原场景文件和旧发布包。旧数据的生成缓存可重建。只停止/清理本任务创建的 Engine、Worker、临时产物和浏览器，不动其他任务资源。新文件版本不能通过把版本号改小伪装为旧格式。

## 14. 实施结果、证据与剩余限制（2026-10-26）

### 已完成的实现

第 2 节为唯一验收清单。现有源字段与独立 ENV 描述、串行队列、会话隔离、受控 IPC、内容寻址缓存及保守租约、v7 兼容、原生天空、旧交互清理、统一照明/GI 捕获、所有打开/保存/发布/导出入口、内置三档产物与维护文档均已落地。原图不被 ENV 覆盖；原场景只在用户明确保存时写入；没有提交、推送或外部发布。

### 实际检查记录

证据根：`output/native-skybox-implementation-20261025/`。

- 最终 `npm run build` 成功（`final-build-2.log`，含类型构建与 Editor/Viewer）；Electron 增量构建和全量 ESLint成功，最后两处增量有定向 ESLint。Vite 仍有已有的大 chunk 提示。
- `test:native-skybox` **52/52**（`final-native-unit-3.log`）；登记与受影响大屏版本兼容 **14/14**（`final-test-registration.log`）；`generate-test-inventory.mjs --check` 成功。仅在审阅变更和运行条件后更新三份版本测试及 manifest 元数据摘要，未放宽断言。
- 此前完整 `npm test` core 成功（`t-core-2.log`）；后续收尾没有重复整个 core，而重跑本次受影响路径。统一光照 **43/43**、光照管理 **82/82**、引擎配置 **26/26**、部署预压缩 **17/17** 的原结果可复用。
- 最新真实 Electron（RTX 4060 Ti）：`electron-ui-zkkdfg/result.json`、`saved-reopened.png`。原图导入、旋转/分辨率、缺源保留旧天空、重试、保存重开、总加载结束、目录与 ZIP 导出通过；page/console error 均为 0。目录/ZIP 均不携带 HDR/EXR 或未引用内置天空库。
- 最新真实 WebGL（RTX 2070 SUPER）：`native-webgl.json` / `final-native-webgl.log`。透视/正交、25 km 平移、GI 捕获与签名、隐藏背景保留 IBL、切换/失败/释放、context restore 均通过；无外网请求。恢复前后天空像素相同且只留一份立方体纹理。
- EXR：`exr-fixtures-final/webgl-result.json`。Blender 5.2.2 生成的 NONE/RLE/ZIPS/ZIP/PIZ/PXR24 六种原图均在阻断外网的真实浏览器中完成 ENV 编译、54 张 Mip 图像结构校验和原生重载；本地 fflate 备用路径可用，提交取消检查通过。生成器还调用实际 Cycles 后端核对原图节点、强度和旋转。
- SOURCE/DIST：`final-source-dist.log`，真实 Electron 主进程配合本机模拟中台，覆盖多场景、内置/本地/中台/orphaned、未引用剔除、源与 ENV 的最终复制完整性、发布取消/重试/绑定恢复，通过。未对真实业务中台发布。
- 实际独立目录 `electron-ui-zkkdfg/exports/NativeSkybox-web` 已由 Browser 打开：显示“场景运行中”，无总加载蒙版/阻断/控制台错误；请求为场景 ENV 与独立 Sandbox ENV，无 HDR/EXR 或天空转换 Worker。同版本生产 Viewer 的拉远/旋转像素验证见 `viewer/report.json`。
- 画质与成本：`quality/quality-report.json`。预冻结天空预算 meanAbs≤1.5、p99≤8，IBL预算 meanAbs≤2.5、p99≤12（8位通道）；256/512 六方向及粗糙度0.05/0.4/0.9金属比较最大差1。运行时每档10次，256/512/1024 ready中位约95/151/344ms，含真实读取和PNG/GPU上传；不是零成本。三次页面冷编译256约3.37–3.39s，其中一次含对照诊断；不据此声称业务加载加速比例。内置 ENV 分别为728,031、2,280,803、6,840,120字节，不能宣称一定比HDR更小。

### 综合回归仍有的既有失败

下列不因本次迁移而忽略，也不扩展修复范围。对照使用本任务开始前的 `baseline/`，并保留 `suite-summary.txt`、`r2-summary.txt` 及逐组日志；不是仅凭 HEAD 归因。

- `test:data-platform-skybox` 156/157：两份 preload 的既有 `getProjectOpenTrace` API 不一致；入场备份已是 `.ts` 有、`.cts` 无。新增三个天空 IPC 在两份文件均已接线且真实主窗口通过。
- `test:scene-loading` / 本地恢复 / 模型同步组：原源码截取测试没有注入既有 `getSceneProjectOpenContext` 等诊断依赖；保持失败可见。因 v7 升级引起的旧断言已修复，未把未来版本当兼容版本放行。
- `test:lighting-bake` 251/254：两项源码截取缺少 `getRequestedLightingLightmapEncoding`，一项既有材质回滚颜色断言失败。该服务与 Python 文件和入场备份相同；SceneLightingRuntime 的本次变化仅在天空原图捕获说明/门禁，不涉及材质回滚。
- `test:source-resource-plan` 2/16：旧夹具启用了要求烘焙的配置却无烘焙结果，HEAD 对照同样14项失败；没有禁用正式烘焙校验绕过。
- 完整 `test:lighting-bake:cycles` 在既有 `cycles_probe_gpu_checks.py` 探针重试断言失败（`cycles-1.log`）；`test:lighting-optimization` 有既有 Python 裁剪执行依赖缺失。**本次没有证明整个 Cycles 套件或实际工厂烘焙全通过。**

未测的范围包括业务工厂完整GI/FPS、峰值显存、低端GPU机型覆盖和真实中台网络环境。已有有限球体的球心偏移、缩放或倾斜不再产生相同背景，这是已明确展示的语义变化，不是编码误差。因上述全仓/环境限制，本轮交付表述为“实现完成、关键本机验收通过”，不表述为“全部检查全绿”。

### 执行事故与恢复

基线对照曾误用共享 `node_modules` Junction，清理该临时 worktree 时误清空依赖目录。已按现有 lockfile 执行 `npm ci` 恢复，并经官方入口重新准备 Electron 42.4.0；没有删除源码或用户工程，锁定依赖未因此变化。恢复后的类型检查、构建、真实 Editor/Viewer 均已执行。经验已记录，后续不再用共享依赖 Junction 做此类清理。


交付物只有本方案、完整引用索引及简短任务记录；不代表对工作树已有业务修改的审核结论。
