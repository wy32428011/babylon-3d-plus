# Project Resource Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将底部 `Project` 面板改造成参考图风格的七类资源库浏览器外观，只实现样式与占位交互。

**Architecture:** 采用单组件静态视觉壳方案，在 `ProjectPanel` 内用静态配置驱动七个库页签、筛选占位行和资源卡片占位。样式集中写在 `global.css` 的 Project 面板专属 class 中，不改编辑器 store、资产扫描、场景加载或 Babylon 运行时逻辑。

**Tech Stack:** React、TypeScript、CSS、Vite/Electron、现有编辑器全局样式体系。

---

## 规格来源

- 设计规格：`docs/superpowers/specs/2026-06-28-project-resource-panel-design.md`
- 实施范围：只改样式和占位交互，不接真实资源功能。
- 验证偏好：按用户全局要求，不编写或运行自动化测试；通过代码检查、类型构建和必要的界面运行确认交付质量。
- 提交策略：本计划不包含 `git commit` 步骤；只有用户明确要求时才提交。

## 文件结构

- Modify: `src/editor/panels/ProjectPanel.tsx`
  - 负责 Project 面板的资源库静态配置、当前页签状态、页签渲染、筛选占位行和资源卡片占位。
  - 移除旧的扫描按钮主视觉和旧资产列表展示，避免和新资源库样式冲突。

- Modify: `src/styles/global.css`
  - 负责资源库页签栏、筛选行、资源卡片、横向滚动、占位图标等样式。
  - 保留其他面板样式，不影响 Hierarchy、Scene、Inspector、Toolbar。

- Modify: `README.md`
  - 记录 Project 面板已经切换为资源库外观。
  - 明确当前资源库为占位展示，真实分类、搜索、扫描和导入功能后续接入。

---

### Task 1: 替换 ProjectPanel 为资源库视觉壳

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx`

- [ ] **Step 1: 用静态资源库配置替换旧扫描列表 UI**

将 `src/editor/panels/ProjectPanel.tsx` 完整替换为以下内容：

```tsx
import { useMemo, useState } from 'react';

type ProjectLibraryKey = 'model' | 'poi' | 'theme' | 'composition' | 'environment' | 'chart' | 'image';

type ProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
};

type ProjectLibrary = {
  key: ProjectLibraryKey;
  label: string;
  searchLabel: string;
  searchPlaceholder: string;
  items: ProjectLibraryItem[];
};

const PROJECT_LIBRARIES: ProjectLibrary[] = [
  {
    key: 'model',
    label: '模型库',
    searchLabel: '模型名称',
    searchPlaceholder: '请输入模型名称...',
    items: [
      { id: 'model-trigger', name: '事件触发器', icon: 'cube' },
      { id: 'model-sender', name: '发送器', icon: 'cube' },
      { id: 'model-receiver', name: '回收器', icon: 'cube' },
      { id: 'model-generator', name: '模型产生器', icon: 'ring' },
    ],
  },
  {
    key: 'poi',
    label: 'POI库',
    searchLabel: 'POI名称',
    searchPlaceholder: '请输入POI名称...',
    items: [
      { id: 'poi-chart-marker', name: '图表立标', icon: 'marker' },
      { id: 'poi-panel', name: '图表面板', icon: 'panel' },
      { id: 'poi-alarm', name: '报警管理器', icon: 'cube' },
      { id: 'poi-roam', name: '手动漫游', icon: 'person' },
    ],
  },
  {
    key: 'theme',
    label: '主题库',
    searchLabel: '主题名称',
    searchPlaceholder: '请输入主题名称...',
    items: [
      { id: 'theme-tech-blue', name: '科技蓝主题', icon: 'panel' },
      { id: 'theme-dark-city', name: '暗色城市', icon: 'ring' },
      { id: 'theme-energy', name: '能源监控', icon: 'marker' },
      { id: 'theme-command', name: '指挥中心', icon: 'panel' },
    ],
  },
  {
    key: 'composition',
    label: '组合库',
    searchLabel: '组合名称',
    searchPlaceholder: '请输入组合名称...',
    items: [
      { id: 'composition-device', name: '设备组合', icon: 'cube' },
      { id: 'composition-dashboard', name: '看板组合', icon: 'panel' },
      { id: 'composition-alarm', name: '告警组合', icon: 'marker' },
      { id: 'composition-scene', name: '场景组合', icon: 'ring' },
    ],
  },
  {
    key: 'environment',
    label: '环境库',
    searchLabel: '环境名称',
    searchPlaceholder: '请输入环境名称...',
    items: [
      { id: 'environment-sky', name: '天空环境', icon: 'ring' },
      { id: 'environment-ground', name: '地面环境', icon: 'marker' },
      { id: 'environment-light', name: '灯光环境', icon: 'panel' },
      { id: 'environment-weather', name: '天气环境', icon: 'cube' },
    ],
  },
  {
    key: 'chart',
    label: '图表库',
    searchLabel: '图表名称',
    searchPlaceholder: '请输入图表名称...',
    items: [
      { id: 'chart-board', name: '图表面板', icon: 'panel' },
      { id: 'chart-column', name: '柱状图', icon: 'marker' },
      { id: 'chart-line', name: '折线图', icon: 'panel' },
      { id: 'chart-ring', name: '环形图', icon: 'ring' },
    ],
  },
  {
    key: 'image',
    label: '图片库',
    searchLabel: '图片名称',
    searchPlaceholder: '请输入图片名称...',
    items: [
      { id: 'image-bg', name: '背景图片', icon: 'panel' },
      { id: 'image-icon', name: '图标贴图', icon: 'cube' },
      { id: 'image-mask', name: '遮罩图片', icon: 'ring' },
      { id: 'image-texture', name: '材质贴图', icon: 'marker' },
    ],
  },
];

function ResourceIcon({ icon }: { icon: ProjectLibraryItem['icon'] }) {
  return <span className={`resource-card-icon resource-card-icon-${icon}`} aria-hidden="true" />;
}

export function ProjectPanel() {
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');

  const activeLibrary = useMemo(
    () => PROJECT_LIBRARIES.find((library) => library.key === activeLibraryKey) ?? PROJECT_LIBRARIES[0],
    [activeLibraryKey],
  );

  return (
    <section className="panel project-library" aria-label="Project 资源库">
      <nav className="library-tabs" aria-label="资源库分类">
        {PROJECT_LIBRARIES.map((library) => {
          const isActive = library.key === activeLibrary.key;

          return (
            <button
              aria-pressed={isActive}
              className={isActive ? 'library-tab active' : 'library-tab'}
              key={library.key}
              onClick={() => setActiveLibraryKey(library.key)}
              type="button"
            >
              {library.label}
            </button>
          );
        })}
      </nav>

      <div className="library-filter-row" aria-label={`${activeLibrary.label}筛选占位`}>
        <label className="library-filter-label" htmlFor="project-library-search">
          {activeLibrary.searchLabel}
        </label>
        <input
          className="library-filter-input"
          id="project-library-search"
          placeholder={activeLibrary.searchPlaceholder}
          readOnly
          type="text"
          value=""
        />
      </div>

      <div className="resource-card-list" aria-label={`${activeLibrary.label}资源占位列表`}>
        {activeLibrary.items.map((item) => (
          <button className="resource-card" disabled key={item.id} title="占位资源，功能后续接入" type="button">
            <span className="resource-card-preview">
              <ResourceIcon icon={item.icon} />
            </span>
            <strong className="resource-card-name">{item.name}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 检查本任务的关键边界**

确认 `ProjectPanel.tsx` 中没有以下内容：

```txt
scanAssets
window.editorApi.scanAssets
importModelAsset
loadSceneAsset
asset-list
扫描资源目录
```

预期：这些旧扫描和真实资产动作不再出现在 Project 面板主视觉中。

---

### Task 2: 添加 Project 资源库专属样式

**Files:**
- Modify: `src/styles/global.css`

- [ ] **Step 1: 移除旧资产卡片样式块**

在 `src/styles/global.css` 中删除旧资源列表样式块：

```css
.asset-path {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.asset-item {
  display: grid;
  gap: 4px;
  min-height: 70px;
  padding: 8px;
  border: 1px solid #3c3c3c;
  color: #d7d7d7;
  background: #1e1e1e;
  text-align: left;
}

.asset-item.actionable:hover {
  border-color: #3d6fb6;
  background: #26384a;
}

.asset-item span,
.asset-item small {
  color: #8f8f8f;
  font-size: 11px;
}
```

- [ ] **Step 2: 在同一位置添加新资源库样式**

在删除位置写入以下 CSS：

```css
.project-library {
  display: grid;
  grid-template-rows: 32px 42px minmax(0, 1fr);
  gap: 0;
  padding: 0;
  overflow: hidden;
  background: #262626;
}

.library-tabs {
  display: flex;
  min-width: 0;
  border-bottom: 1px solid #121212;
  background: #171717;
}

.library-tab {
  min-width: 104px;
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-right: 1px solid #242424;
  border-radius: 0;
  color: #d6d6d6;
  background: transparent;
  font-size: 13px;
  text-align: center;
}

.library-tab:hover {
  color: #ffffff;
  background: #2b2b2b;
}

.library-tab.active {
  position: relative;
  color: #ffffff;
  background: #333333;
}

.library-tab.active::before {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: #19c7d4;
  content: '';
}

.library-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 12px;
  border-bottom: 1px solid #3a3a3a;
  background: #303030;
}

.library-filter-label {
  flex: 0 0 auto;
  color: #bdbdbd;
  font-size: 13px;
}

.library-filter-input {
  width: 188px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid #474747;
  color: #d7d7d7;
  background: #202020;
  outline: none;
}

.library-filter-input::placeholder {
  color: #777777;
  font-style: italic;
}

.resource-card-list {
  display: flex;
  gap: 18px;
  min-width: 0;
  padding: 10px 14px 14px;
  overflow-x: auto;
  overflow-y: hidden;
  background: #262626;
}

.resource-card {
  display: grid;
  grid-template-rows: 78px 28px;
  flex: 0 0 124px;
  width: 124px;
  height: 112px;
  padding: 4px;
  border: 1px solid #4a4a4a;
  border-radius: 0;
  color: #d7d7d7;
  background: #343434;
  cursor: default;
}

.resource-card:disabled {
  color: #d7d7d7;
  cursor: default;
  opacity: 1;
}

.resource-card-preview {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid #1e3144;
  background:
    radial-gradient(circle at 50% 78%, rgb(26 214 229 / 22%) 0 18%, transparent 19% 42%),
    linear-gradient(180deg, #141a3a 0%, #10172f 64%, #0d0f17 100%);
}

.resource-card-preview::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgb(32 224 232 / 72%), transparent);
  content: '';
}

.resource-card-name {
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #d2d2d2;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-card-icon {
  position: relative;
  width: 42px;
  height: 42px;
  color: #15d7e6;
  filter: drop-shadow(0 0 8px rgb(21 215 230 / 42%));
}

.resource-card-icon::before,
.resource-card-icon::after {
  position: absolute;
  content: '';
}

.resource-card-icon-cube::before {
  inset: 10px 12px 8px 10px;
  border: 3px solid currentcolor;
  transform: skewY(-18deg);
}

.resource-card-icon-cube::after {
  inset: 4px 6px 14px 18px;
  border: 3px solid currentcolor;
  opacity: 0.82;
}

.resource-card-icon-marker::before {
  left: 19px;
  top: 8px;
  width: 4px;
  height: 28px;
  background: currentcolor;
}

.resource-card-icon-marker::after {
  left: 7px;
  top: 7px;
  width: 28px;
  height: 16px;
  border: 3px solid currentcolor;
  border-radius: 2px;
}

.resource-card-icon-panel::before {
  inset: 8px 4px 10px;
  border: 3px solid currentcolor;
  border-radius: 2px;
}

.resource-card-icon-panel::after {
  right: 10px;
  bottom: 15px;
  left: 12px;
  height: 3px;
  background: currentcolor;
  box-shadow: 0 -8px 0 rgb(21 215 230 / 55%), 0 8px 0 rgb(21 215 230 / 55%);
}

.resource-card-icon-person::before {
  left: 16px;
  top: 5px;
  width: 10px;
  height: 10px;
  border: 3px solid currentcolor;
  border-radius: 999px;
}

.resource-card-icon-person::after {
  left: 12px;
  top: 18px;
  width: 18px;
  height: 22px;
  border: 3px solid currentcolor;
  border-bottom: 0;
  border-radius: 12px 12px 0 0;
}

.resource-card-icon-ring::before {
  inset: 12px 4px 10px;
  border: 3px solid #35e96d;
  border-radius: 50%;
}

.resource-card-icon-ring::after {
  inset: 18px 10px 16px;
  border: 3px solid #35e96d;
  border-radius: 50%;
  opacity: 0.72;
}
```

- [ ] **Step 3: 检查样式隔离边界**

确认新样式只使用以下 Project 专属选择器：

```txt
.project-library
.library-tabs
.library-tab
.library-filter-row
.library-filter-label
.library-filter-input
.resource-card-list
.resource-card
.resource-card-preview
.resource-card-name
.resource-card-icon
```

预期：不会改动 `.toolbar`、`.entity-list`、`.scene-canvas`、`.inspector-row`、`.console-log-list` 等其他区域样式。

---

### Task 3: 更新 README 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新“当前功能”中的 Project 描述**

将 `README.md` 当前功能中的旧 Project 相关条目：

```markdown
- Assets 目录扫描：Project 面板支持扫描 Assets 第一层文件，并按 folder、model、texture、scene、unknown 进行基础分类。
- Assets 场景加载：Project 面板中点击 `.scene.json` 资产可加载为当前场景。
- glTF/GLB 模型导入：Project 面板中点击 `.gltf` 或 `.glb` 资产可作为模型实体导入场景，支持基础 Transform 编辑、选择、保存与加载。
```

替换为：

```markdown
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片占位。
- Assets 目录能力：历史扫描、场景加载与 glTF/GLB 模型导入能力已暂时让位于资源库外观改造，真实资源分类、搜索、扫描与导入会在后续资源库功能中重新接入。
```

- [ ] **Step 2: 更新“基础操作”中的扫描资产描述**

将旧操作条目：

```markdown
- 扫描资产：点击 Project 面板的 `扫描资源目录`。
- 加载场景资产：扫描后点击 `.scene.json` 资产。
- 导入模型资产：扫描后点击 `.gltf` 或 `.glb` 资产。
```

替换为：

```markdown
- 浏览资源库外观：在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库的占位展示。
- 资源库功能边界：当前搜索框和资源卡片仅作为样式占位，不执行真实搜索、扫描、加载或导入。
```

- [ ] **Step 3: 更新“当前限制”**

将旧限制条目：

```markdown
- Project 面板当前只扫描 Assets 目录第一层，不递归扫描子目录。
- 纹理资产目前只分类展示，暂未支持拖拽赋值到材质。
```

替换为：

```markdown
- Project 资源库当前只完成外观与占位交互，暂未接入真实资源目录扫描、搜索过滤、资源加载、拖拽或导入。
- 纹理、图片、图表、POI、主题、组合与环境资源目前只作为资源库占位分类展示，暂未建立真实数据模型。
```

- [ ] **Step 4: 更新“最近完成”**

在 `README.md` 的“最近完成”列表顶部添加：

```markdown
- 2026-06-28：将底部 Project 面板切换为资源库浏览器外观，补齐七类资源库页签、筛选占位行和横向资源卡片占位。
```

---

### Task 4: 验证代码与界面行为

**Files:**
- Check: `src/editor/panels/ProjectPanel.tsx`
- Check: `src/styles/global.css`
- Check: `README.md`

- [ ] **Step 1: 运行 TypeScript 构建检查**

Run:

```bash
npm run build
```

Expected:

```txt
vite build completes successfully
```

说明：这是构建验证，不是自动化测试；如果用户明确要求完全跳过命令验证，则改为静态代码检查并在交付说明中注明未运行构建。

- [ ] **Step 2: 手动检查 ProjectPanel 静态行为**

检查 `ProjectPanel.tsx` 是否满足：

```txt
默认 activeLibraryKey 为 model
PROJECT_LIBRARIES 包含 7 个库
每个库都有 label、searchLabel、searchPlaceholder、items
点击页签只调用 setActiveLibraryKey
资源卡片 disabled，title 为“占位资源，功能后续接入”
```

Expected：满足以上条件。

- [ ] **Step 3: 界面运行确认**

如需界面截图确认，启动应用：

```bash
npm run dev:electron
```

Expected：Electron 窗口底部 Project 区域显示：

```txt
模型库 / POI库 / 主题库 / 组合库 / 环境库 / 图表库 / 图片库
模型名称 输入占位框
横向资源卡片占位列表
```

检查后关闭本次启动的 Electron/Node 进程；只回收当前任务启动且命令行包含 Claude 会话关联的 Node 进程，避免误杀用户其他 Node 任务。

- [ ] **Step 4: 最终交付前自检**

确认以下内容：

```txt
未引入真实资源扫描或导入逻辑
未修改 editorStore、AssetDatabase、SceneSerializer、SceneRuntime
README 已记录样式改造和功能边界
底部 Project 面板不再出现“扫描资源目录”主按钮
```

Expected：全部满足后再向用户报告完成情况。

---

## 计划自审

- 规格覆盖：七个页签、筛选占位行、横向资源卡片、默认模型库、点击切换、功能暂不接、README 更新均已映射到任务。
- 占位扫描：计划中没有未决的 `TBD`、`TODO` 或未定义步骤；所有代码改动给出完整片段。
- 类型一致性：`ProjectLibraryKey`、`ProjectLibraryItem`、`ProjectLibrary`、`PROJECT_LIBRARIES`、`activeLibraryKey`、`activeLibrary` 命名一致。
- 范围控制：计划不改 store、资产数据库、场景序列化或 Babylon 运行时。
