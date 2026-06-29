# 模型文件夹导入功能设计

## 背景

当前底部 Project 面板已经具备资源库浏览器外观，其中“模型库”仍主要展示静态占位卡片。用户明确提出模型库应当用于放模型，并希望参考本地目录 `F:\3d-models\models` 下的模型和脚本，为编辑器添加“导入模型文件夹”的功能。

现有项目已经具备部分可复用基础能力：

- Electron 主进程已有 `assets:scan`，能够选择目录、授权资产根目录，并为 `.glb/.gltf` 模型生成 `editor-asset://` URL。
- Renderer 侧已有 `AssetEntry` 类型和 `editorStore.importModelAsset()`，可以把 `kind: 'model'` 的资产导入为场景实体。
- Babylon 运行时已经能通过 `SceneLoader.LoadAssetContainerAsync()` 加载 `modelAsset.sourceUrl` 指向的 `.glb/.gltf`。
- 参考目录 `F:\3d-models\models` 呈现规律的“模型包”结构：每个一级子目录通常包含主 `.glb`、`meta.json` 和可选 `.model.ts` 脚本。

本次设计目标是把“模型库”从静态占位升级为可从模型包目录扫描真实模型，并允许用户点击模型卡片导入到 Scene。

## 目标

- 在模型库页签提供“导入模型文件夹”入口。
- 用户选择类似 `F:\3d-models\models` 的模型根目录后，扫描其一级子目录中的模型包。
- 每个模型包识别一个主 `.glb/.gltf` 文件。
- 读取同目录 `meta.json` 中的参数脚本元数据，用于提取展示名称和记录元信息。
- 记录同目录 `.model.ts` 脚本路径，但第一版不执行脚本。
- 模型库展示扫描到的真实模型卡片。
- 点击模型卡片后复用现有 `importModelAsset()`，将模型加入场景。
- 继续通过 `editor-asset://` 授权 URL 加载本地模型文件。
- README 记录该功能和当前边界。

## 非目标

- 不复制模型文件夹到项目目录。
- 不设计项目级 `Assets/Models` 资源目录。
- 不递归扫描任意深层目录；第一版只扫描模型根目录下一级子目录。
- 不执行、编译或热加载 `.model.ts`。
- 不把脚本绑定到 Babylon 节点。
- 不生成 Inspector 参数表单。
- 不做缩略图预览。
- 不保存最近导入过的模型库目录。
- 不做搜索过滤。
- 不做资源拖拽到 Scene。
- 不改变 POI库、主题库、组合库、环境库、图表库、图片库的占位边界。

## 选定方案

采用“扫描模型包文件夹并引用原目录”方案。

用户选择模型根目录后，主进程扫描该目录下一级模型包，并为每个可识别模型返回扩展后的 `AssetEntry`。Renderer 侧模型库保存这批资产条目并渲染真实模型卡片。点击卡片时，继续把 `AssetEntry` 交给现有 `editorStore.importModelAsset()`，由当前场景实体和 Babylon 运行时加载链路完成导入。

该方案的关键取舍：

- **引用原目录，不复制文件。** 速度快，复用现有授权机制，但如果原目录移动或删除，场景中保存的模型路径会失效。
- **读取元数据，不执行脚本。** 能利用 `meta.json` 提供友好展示名和脚本字段信息，同时避免 TS 编译、沙箱、安全和运行生命周期复杂度。
- **只扫描一级模型包。** 贴合参考目录结构，规则明确，避免第一版陷入任意目录递归和主模型推断问题。

## 参考模型包结构

参考目录示例：

```text
F:\3d-models\models
├─ RGV
│  ├─ RGV.glb
│  ├─ meta.json
│  └─ rgv.model.ts
├─ LED
│  ├─ LED.glb
│  ├─ meta.json
│  └─ led.model.ts
└─ Stacker
   ├─ Stacker.glb
   ├─ meta.json
   └─ stacker.model.ts
```

第一版将根目录下每个一级子目录视为一个候选模型包。

## 模型包识别规则

1. 用户在模型库中点击“导入模型文件夹”。
2. Electron 主进程弹出目录选择对话框。
3. 用户选择模型根目录，例如 `F:\3d-models\models`。
4. 主进程授权该根目录为资产根目录。
5. 主进程读取根目录下的一级子目录。
6. 每个一级子目录作为候选模型包。
7. 在候选模型包中查找 `.glb` 或 `.gltf`：
   - 优先选择与文件夹同名的 `.glb/.gltf`，例如 `RGV/RGV.glb`。
   - 如果没有同名模型文件，但只有一个 `.glb/.gltf`，使用这个唯一模型文件。
   - 如果存在多个 `.glb/.gltf` 且无法判断主模型，则跳过该模型包，并返回跳过原因。
   - 如果没有 `.glb/.gltf`，跳过该模型包。
8. 如果存在 `meta.json`，尝试读取并解析。
9. 如果存在 `.model.ts`，记录脚本路径列表。
10. 为成功识别的模型包生成 `AssetEntry(kind: 'model')`。

## 元数据读取规则

第一版只读取 `meta.json`，不执行 `.model.ts`。

展示名优先级：

1. `meta.json` 中 `parameterScripts[].values.deviceName.value`。
2. `meta.json` 中 `parameterScripts[].fields` 里 `key === 'deviceName'` 的 `defaultValue`。
3. 模型包文件夹名。
4. 主模型文件名去掉扩展名。

脚本信息处理：

- 读取 `parameterScripts[].scriptFilename`，用于确认脚本文件名。
- 扫描同目录下的 `.model.ts` 文件，记录为 `scriptPaths`。
- 不读取脚本文本内容。
- 不编译脚本。
- 不执行脚本。

## 类型设计

当前 `AssetEntry`：

```ts
type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
};
```

建议扩展为兼容结构：

```ts
type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  packagePath?: string;
  metadataPath?: string;
  scriptPaths?: string[];
  displayName?: string;
};
```

字段说明：

- `id`：稳定标识，第一版使用主模型文件绝对路径。
- `name`：主模型文件名，例如 `RGV.glb`。
- `path`：主 `.glb/.gltf` 文件路径，继续供 `createModelEntity()` 使用。
- `sourceUrl`：主模型对应的 `editor-asset://` URL。
- `kind`：模型包资产固定为 `'model'`。
- `packagePath`：模型包文件夹路径，例如 `F:\3d-models\models\RGV`。
- `metadataPath`：`meta.json` 路径；不存在时不设置。
- `scriptPaths`：同目录 `.model.ts` 脚本路径列表；不存在时为空数组或不设置。
- `displayName`：模型库卡片展示名，优先来自 `meta.json` 的设备名称。

新增 IPC 返回类型：

```ts
type ImportModelFolderSkippedEntry = {
  packagePath: string;
  reason: string;
};

type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  assets: AssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};
```

新增 preload API：

```ts
window.editorApi.importModelFolder(): Promise<ImportModelFolderResult>
```

该 API 独立于旧 `scanAssets()`，避免改变历史通用资产扫描语义。

## 主进程设计

建议在 `electron/ipc/assetIpc.ts` 中新增 `assets:importModelFolder` handler。

职责：

- 弹出目录选择对话框。
- 处理取消选择。
- 授权选择的模型根目录。
- 扫描一级子目录。
- 识别主模型文件。
- 读取 `meta.json`。
- 记录 `.model.ts` 路径。
- 为每个主模型生成 `editor-asset://` URL。
- 返回资产列表和跳过项。

主进程不得执行 `.model.ts`，也不得把脚本文本注入 renderer。

## Renderer 设计

`ProjectPanel` 从纯静态占位调整为“模型库真实数据 + 其他库占位”。

状态建议：

```ts
const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
const [modelAssets, setModelAssets] = useState<AssetEntry[]>([]);
const [isImportingModelFolder, setIsImportingModelFolder] = useState(false);
const [modelFolderMessage, setModelFolderMessage] = useState<string | null>(null);
```

行为：

- 当 `activeLibraryKey === 'model'` 时显示“导入模型文件夹”按钮。
- 点击按钮后调用 `window.editorApi.importModelFolder()`。
- 如果返回 `canceled: true`，不改变当前列表。
- 如果返回 `assets`，用它替换模型库真实列表。
- 如果 `assets.length === 0`，显示空状态。
- 如果存在 `skipped`，显示或记录跳过数量。
- 模型卡片可点击；点击后调用 `importModelAsset(asset)`。
- 其他资源库页签继续使用现有占位卡片。

## UI 设计

模型库页签结构：

```text
[模型名称] [请输入模型名称...]                         [导入模型文件夹]

┌────────────┐ ┌────────────┐ ┌────────────┐
│  RGV       │ │  LED       │ │  Stacker   │
│  glb icon  │ │  glb icon  │ │  glb icon  │
│  异形环穿车 │ │ LED 状态灯  │ │ 堆垛机     │
└────────────┘ └────────────┘ └────────────┘
```

状态文案：

- 初始状态：显示当前占位模型卡片，并提供“导入模型文件夹”按钮。
- 扫描中：按钮禁用，显示“正在扫描模型文件夹...”。
- 扫描成功：显示真实模型卡片，卡片可点击。
- 扫描成功但无模型：显示“未发现可导入模型包”。
- 扫描有跳过项：显示“已跳过 N 个目录”。
- 扫描失败：显示“导入模型文件夹失败：错误信息”。

## 日志设计

建议复用 `editorStore.pushLog()`，让 Console 能显示导入反馈。

日志示例：

- `模型文件夹已导入：F:\3d-models\models，发现 11 个模型。`
- `模型文件夹扫描跳过 1 个目录。`
- `导入模型：RGV.glb`
- `导入模型文件夹失败：错误信息`

如果实现阶段发现 `ProjectPanel` 直接接入 `pushLog()` 会造成不必要耦合，可以先保留面板内状态文案，但最终 README 和规格应记录实际实现边界。

## 数据流

```text
用户点击“导入模型文件夹”
  ↓
ProjectPanel 调用 window.editorApi.importModelFolder()
  ↓
preload 转发到 assets:importModelFolder
  ↓
主进程弹出目录选择并扫描模型包
  ↓
主进程授权模型根目录并生成 AssetEntry[]
  ↓
ProjectPanel 保存 modelAssets 并渲染真实卡片
  ↓
用户点击模型卡片
  ↓
ProjectPanel 调用 editorStore.importModelAsset(asset)
  ↓
createModelEntity(asset.path, asset.sourceUrl, asset.displayName 或 asset.name)
  ↓
SceneRuntime 通过 editor-asset:// 加载主模型
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 用户取消选择文件夹 | 返回 `canceled: true`，前端不改变当前模型库列表 |
| 选择的目录为空 | 返回空 `assets`，前端显示“未发现可导入模型包” |
| 子目录没有 `.glb/.gltf` | 跳过该目录，记录跳过原因 |
| 子目录有多个 `.glb/.gltf` 且无法判断主模型 | 跳过该目录，记录跳过原因 |
| `meta.json` 不存在 | 仍导入模型，只是不设置 `metadataPath` 和元数据展示名 |
| `meta.json` 解析失败 | 仍导入模型，返回跳过/警告信息或在状态文案中提示元数据读取失败 |
| `.model.ts` 不存在 | 正常导入，`scriptPaths` 为空 |
| 文件读取异常 | 前端显示“导入模型文件夹失败：错误信息” |
| 点击模型卡片导入场景 | 复用现有 `importModelAsset()`；如果不是 `kind: 'model'` 则不导入 |

核心策略：**能识别主模型文件就导入，不因元数据或脚本缺失阻断模型导入。**

## 安全边界

- Renderer 不直接访问任意本地路径，只通过 preload 暴露的受控 API 获取资产条目。
- 主进程只授权用户主动选择的模型根目录。
- `editor-asset://` 仍只服务已授权资产文件或授权资产根目录内的文件。
- `.model.ts` 第一版不执行、不编译、不注入页面。
- 读取 `meta.json` 失败不影响主模型导入。

## 验证标准

- 模型库页签出现“导入模型文件夹”按钮。
- 选择 `F:\3d-models\models` 后，模型库能扫描到该目录下的真实模型包，例如 `RGV`、`LED`、`Stacker`、`Shelf`、`链条机`、`辊道机`。
- 模型库卡片优先显示 `meta.json` 中的设备名称；缺失时显示模型包名或模型文件名。
- 点击真实模型卡片后，场景中出现对应模型实体。
- SceneRuntime 仍通过 `editor-asset://` 加载 `.glb/.gltf`。
- `.model.ts` 不执行，不影响导入。
- 扫描空目录、取消选择、多模型无法判断主文件等边界有明确 UI 或日志反馈。
- 其他资源库页签继续保持占位展示。
- README 记录模型库支持导入模型文件夹、引用原目录、不复制资源、只读 `meta.json`、不执行 `.model.ts`。

## 后续扩展

后续可以单独设计以下能力：

- 保存最近导入的模型根目录。
- 支持模型库搜索过滤。
- 支持模型卡片缩略图。
- 支持拖拽模型到 Scene。
- 支持复制模型包到项目资产目录。
- 支持读取并展示参数 Inspector。
- 支持安全沙箱内执行受信任模型脚本。
- 支持递归扫描多级模型包。
