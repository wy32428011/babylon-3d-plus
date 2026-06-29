# Babylon Electron Unity-like Editor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空目录构建一个可启动、可编辑、可保存/加载的 Babylon.js + Electron Unity-like 3D 编辑器 MVP。

**Architecture:** Electron 主进程只负责窗口、文件系统和安全 IPC；React 渲染进程负责编辑器面板、状态和命令分发；Babylon.js runtime 通过适配层同步 `SceneDocument`，不让 UI 直接持久化 Babylon 对象。

**Tech Stack:** Electron、Vite、React、TypeScript、Babylon.js、Zustand、CSS Modules、Node.js 文件系统 IPC。

---

## Scope Boundary

本计划只实现第一阶段 MVP：工程骨架、Unity-like 五面板布局、基础场景实体、Transform Inspector、Babylon Scene View、选择/同步、Undo/Redo、JSON 场景保存/加载、基础资产目录展示和 README 文档。

以下功能不在本计划中实现：Prefab、动画时间线、脚本热更新、物理编辑器、Terrain、粒子系统、构建发布、插件市场、多用户协作。

## File Structure Map

### Create: project root

- `package.json`：定义 npm scripts、依赖和 Electron/Vite 开发命令。
- `tsconfig.json`：TypeScript 严格配置。
- `tsconfig.node.json`：Electron 主进程 TypeScript 配置。
- `vite.config.ts`：React 渲染进程构建配置。
- `index.html`：Vite HTML 入口。
- `README.md`：启动方式、功能说明、架构说明、路线图。

### Create: Electron

- `electron/main.ts`：创建 BrowserWindow，注册 IPC。
- `electron/preload.ts`：通过 `contextBridge` 暴露安全 API。
- `electron/types.ts`：主进程和 preload 共享类型。
- `electron/ipc/projectIpc.ts`：项目和场景文件读写 IPC。
- `electron/ipc/assetIpc.ts`：资产目录扫描 IPC。

### Create: renderer entry

- `src/main.tsx`：React 入口。
- `src/App.tsx`：应用根组件。
- `src/styles/global.css`：全局样式、Unity-like 暗色主题。
- `src/vite-env.d.ts`：Vite 与 preload 类型声明。

### Create: editor UI

- `src/editor/layout/EditorLayout.tsx`：五面板布局和顶部工具栏。
- `src/editor/layout/EditorLayout.module.css`：布局样式。
- `src/editor/panels/HierarchyPanel.tsx`：实体树、创建/删除对象入口。
- `src/editor/panels/InspectorPanel.tsx`：Transform 表单编辑。
- `src/editor/panels/ProjectPanel.tsx`：资产目录展示、保存/加载按钮。
- `src/editor/panels/SceneViewPanel.tsx`：承载 Babylon canvas。
- `src/editor/panels/ConsolePanel.tsx`：日志输出。
- `src/editor/ui/Toolbar.tsx`：Undo/Redo、保存/加载、创建对象按钮。

### Create: editor domain model

- `src/editor/model/math.ts`：Vector3 数据类型和工具函数。
- `src/editor/model/components.ts`：Transform、MeshRenderer、Camera、Light 组件类型。
- `src/editor/model/Entity.ts`：实体结构。
- `src/editor/model/SceneDocument.ts`：场景文档结构和默认场景创建。
- `src/shared/ids.ts`：稳定 ID 生成。

### Create: editor commands

- `src/editor/commands/Command.ts`：命令接口。
- `src/editor/commands/CommandHistory.ts`：Undo/Redo 栈。
- `src/editor/commands/entityCommands.ts`：创建、删除、更新组件命令。

### Create: editor services/store

- `src/editor/project/SceneSerializer.ts`：场景 JSON 序列化/反序列化。
- `src/editor/assets/AssetDatabase.ts`：资产扫描结果结构。
- `src/editor/store/editorStore.ts`：Zustand 状态、选择、命令执行、保存加载状态。

### Create: Babylon runtime

- `src/runtime/babylon/createEngine.ts`：创建 Engine 和基础 Scene。
- `src/runtime/babylon/SceneRuntime.ts`：把 `SceneDocument` 同步为 Babylon meshes/cameras/lights。
- `src/runtime/babylon/TransformGizmoController.ts`：对象选择和 Transform Gizmo 同步。

---

## Task 1: Scaffold Electron + Vite + React + TypeScript

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles/global.css`
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `electron/types.ts`
- Create: `src/vite-env.d.ts`

- [ ] **Step 1: Create package manifest**

Create `package.json` with this content:

```json
{
  "name": "babylon-electron-unity-editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "dev:electron": "concurrently -k \"npm run dev\" \"wait-on tcp:5173 && npm run build:electron && electron .\"",
    "build": "tsc -b && vite build && npm run build:electron",
    "build:electron": "tsc -p tsconfig.node.json",
    "typecheck": "tsc -b",
    "preview": "vite preview --host 127.0.0.1"
  },
  "dependencies": {
    "@babylonjs/core": "latest",
    "@babylonjs/loaders": "latest",
    "@vitejs/plugin-react": "latest",
    "vite": "latest",
    "typescript": "latest",
    "react": "latest",
    "react-dom": "latest",
    "zustand": "latest",
    "electron": "latest",
    "concurrently": "latest",
    "wait-on": "latest"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create TypeScript configs**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "outDir": "dist-electron",
    "rootDir": "electron",
    "types": ["node"]
  },
  "include": ["electron/**/*.ts"]
}
```

- [ ] **Step 3: Create Vite config and HTML entry**

Create `vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
```

Create `index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Babylon Unity-like Editor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create Electron main and preload**

Create `electron/types.ts`:

```ts
export type SceneFilePayload = {
  name: string;
  content: string;
};

export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
};
```

Create `electron/main.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

Create `electron/preload.ts`:

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
});
```

- [ ] **Step 5: Create React entry**

Create `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface Window {
  editorApi: {
    version: string;
  };
}
```

Create `src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `src/App.tsx`:

```tsx
export default function App() {
  return (
    <main className="app-shell">
      <h1>Babylon Unity-like Editor</h1>
      <p>编辑器工程骨架已启动，当前版本：{window.editorApi.version}</p>
    </main>
  );
}
```

Create `src/styles/global.css`:

```css
:root {
  color: #d7d7d7;
  background: #1e1e1e;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 1180px;
  min-height: 720px;
  overflow: hidden;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  color: #d7d7d7;
}
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
npm install
```

Expected: dependencies installed and `package-lock.json` created.

- [ ] **Step 7: Verify typecheck/build baseline**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit with code 0.

- [ ] **Step 8: Checkpoint**

Record in `README.md` once created in Task 9 that the Electron/Vite/React baseline was established. Because the directory is currently not a git repository, do not run `git commit` unless git is initialized later.

---

## Task 2: Build Unity-like Editor Layout

**Files:**
- Modify: `src/App.tsx`
- Create: `src/editor/layout/EditorLayout.tsx`
- Create: `src/editor/layout/EditorLayout.module.css`
- Create: `src/editor/ui/Toolbar.tsx`
- Create: `src/editor/panels/HierarchyPanel.tsx`
- Create: `src/editor/panels/InspectorPanel.tsx`
- Create: `src/editor/panels/ProjectPanel.tsx`
- Create: `src/editor/panels/SceneViewPanel.tsx`
- Create: `src/editor/panels/ConsolePanel.tsx`

- [ ] **Step 1: Replace App with editor layout**

Modify `src/App.tsx`:

```tsx
import { EditorLayout } from './editor/layout/EditorLayout';

export default function App() {
  return <EditorLayout />;
}
```

- [ ] **Step 2: Create toolbar**

Create `src/editor/ui/Toolbar.tsx`:

```tsx
type ToolbarProps = {
  onCreateCube: () => void;
  onCreateSphere: () => void;
  onCreatePlane: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export function Toolbar(props: ToolbarProps) {
  return (
    <header className="toolbar">
      <strong>Babylon Unity-like Editor</strong>
      <button onClick={props.onCreateCube}>Cube</button>
      <button onClick={props.onCreateSphere}>Sphere</button>
      <button onClick={props.onCreatePlane}>Plane</button>
      <button onClick={props.onUndo} disabled={!props.canUndo}>Undo</button>
      <button onClick={props.onRedo} disabled={!props.canRedo}>Redo</button>
      <button onClick={props.onSaveScene}>保存场景</button>
      <button onClick={props.onLoadScene}>加载场景</button>
    </header>
  );
}
```

- [ ] **Step 3: Create placeholder panels**

Create `src/editor/panels/HierarchyPanel.tsx`:

```tsx
export function HierarchyPanel() {
  return (
    <section className="panel">
      <h2>Hierarchy</h2>
      <p className="muted">场景实体将在这里显示。</p>
    </section>
  );
}
```

Create `src/editor/panels/InspectorPanel.tsx`:

```tsx
export function InspectorPanel() {
  return (
    <section className="panel">
      <h2>Inspector</h2>
      <p className="muted">选择对象后可编辑 Transform。</p>
    </section>
  );
}
```

Create `src/editor/panels/ProjectPanel.tsx`:

```tsx
export function ProjectPanel() {
  return (
    <section className="panel">
      <h2>Project</h2>
      <p className="muted">Assets 目录内容将在这里显示。</p>
    </section>
  );
}
```

Create `src/editor/panels/SceneViewPanel.tsx`:

```tsx
export function SceneViewPanel() {
  return (
    <section className="scene-panel">
      <h2>Scene</h2>
      <div className="scene-placeholder">Babylon Scene View</div>
    </section>
  );
}
```

Create `src/editor/panels/ConsolePanel.tsx`:

```tsx
export function ConsolePanel() {
  return (
    <section className="panel">
      <h2>Console</h2>
      <p className="muted">编辑器日志将在这里显示。</p>
    </section>
  );
}
```

- [ ] **Step 4: Create layout component**

Create `src/editor/layout/EditorLayout.tsx`:

```tsx
import { ConsolePanel } from '../panels/ConsolePanel';
import { HierarchyPanel } from '../panels/HierarchyPanel';
import { InspectorPanel } from '../panels/InspectorPanel';
import { ProjectPanel } from '../panels/ProjectPanel';
import { SceneViewPanel } from '../panels/SceneViewPanel';
import { Toolbar } from '../ui/Toolbar';
import styles from './EditorLayout.module.css';

export function EditorLayout() {
  return (
    <div className={styles.editorShell}>
      <Toolbar
        onCreateCube={() => undefined}
        onCreateSphere={() => undefined}
        onCreatePlane={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onSaveScene={() => undefined}
        onLoadScene={() => undefined}
        canUndo={false}
        canRedo={false}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}><HierarchyPanel /></aside>
        <main className={styles.centerColumn}>
          <SceneViewPanel />
          <ConsolePanel />
        </main>
        <aside className={styles.rightColumn}><InspectorPanel /></aside>
      </div>
      <div className={styles.bottomBar}><ProjectPanel /></div>
    </div>
  );
}
```

- [ ] **Step 5: Create layout styles**

Create `src/editor/layout/EditorLayout.module.css`:

```css
.editorShell {
  display: grid;
  grid-template-rows: 40px minmax(0, 1fr) 180px;
  width: 100vw;
  height: 100vh;
  background: #1e1e1e;
  color: #d7d7d7;
}

.workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
  min-height: 0;
  border-top: 1px solid #111;
  border-bottom: 1px solid #111;
}

.leftColumn,
.rightColumn,
.centerColumn,
.bottomBar {
  min-width: 0;
  min-height: 0;
  border-color: #111;
}

.leftColumn {
  border-right: 1px solid #111;
}

.rightColumn {
  border-left: 1px solid #111;
}

.centerColumn {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 150px;
}

.bottomBar {
  overflow: hidden;
}
```

Append to `src/styles/global.css`:

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid #111;
  background: #2d2d30;
}

.toolbar button,
.panel button {
  border: 1px solid #555;
  border-radius: 3px;
  color: #d7d7d7;
  background: #3c3c3c;
  cursor: pointer;
}

.toolbar button:disabled {
  color: #777;
  cursor: not-allowed;
}

.panel,
.scene-panel {
  height: 100%;
  padding: 10px;
  overflow: auto;
  background: #252526;
}

.panel h2,
.scene-panel h2 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #f0f0f0;
}

.muted {
  color: #8f8f8f;
}

.scene-placeholder {
  display: grid;
  height: calc(100% - 28px);
  place-items: center;
  border: 1px dashed #555;
  color: #8f8f8f;
  background: #1b1b1b;
}
```

- [ ] **Step 6: Verify layout compiles**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` exits with code 0.

---

## Task 3: Add Scene Domain Model and Store

**Files:**
- Create: `src/shared/ids.ts`
- Create: `src/editor/model/math.ts`
- Create: `src/editor/model/components.ts`
- Create: `src/editor/model/Entity.ts`
- Create: `src/editor/model/SceneDocument.ts`
- Create: `src/editor/store/editorStore.ts`

- [ ] **Step 1: Create ID and math helpers**

Create `src/shared/ids.ts`:

```ts
export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
```

Create `src/editor/model/math.ts`:

```ts
export type Vector3Data = {
  x: number;
  y: number;
  z: number;
};

export function vector3(x = 0, y = 0, z = 0): Vector3Data {
  return { x, y, z };
}
```

- [ ] **Step 2: Create component and entity types**

Create `src/editor/model/components.ts`:

```ts
import type { Vector3Data } from './math';

export type TransformComponent = {
  position: Vector3Data;
  rotation: Vector3Data;
  scale: Vector3Data;
};

export type MeshKind = 'cube' | 'sphere' | 'plane';

export type MeshRendererComponent = {
  meshKind: MeshKind;
  materialColor: string;
};

export type CameraComponent = {
  fov: number;
  near: number;
  far: number;
};

export type LightComponent = {
  lightKind: 'hemispheric' | 'directional' | 'point';
  intensity: number;
};

export type EntityComponents = {
  transform: TransformComponent;
  meshRenderer?: MeshRendererComponent;
  camera?: CameraComponent;
  light?: LightComponent;
};
```

Create `src/editor/model/Entity.ts`:

```ts
import type { EntityComponents } from './components';

export type Entity = {
  id: string;
  name: string;
  parentId: string | null;
  childrenIds: string[];
  components: EntityComponents;
};
```

- [ ] **Step 3: Create scene document factory**

Create `src/editor/model/SceneDocument.ts`:

```ts
import { createId } from '../../shared/ids';
import type { MeshKind } from './components';
import type { Entity } from './Entity';
import { vector3 } from './math';

export type SceneDocument = {
  id: string;
  name: string;
  entityIds: string[];
  entities: Record<string, Entity>;
  selectedEntityId: string | null;
};

export function createEmptySceneDocument(name = 'Untitled Scene'): SceneDocument {
  return {
    id: createId('scene'),
    name,
    entityIds: [],
    entities: {},
    selectedEntityId: null,
  };
}

export function createMeshEntity(meshKind: MeshKind): Entity {
  const id = createId('entity');
  const displayName = meshKind.charAt(0).toUpperCase() + meshKind.slice(1);

  return {
    id,
    name: displayName,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      meshRenderer: {
        meshKind,
        materialColor: '#8ab4f8',
      },
    },
  };
}
```

- [ ] **Step 4: Create editor store**

Create `src/editor/store/editorStore.ts`:

```ts
import { create } from 'zustand';
import type { MeshKind } from '../model/components';
import { createEmptySceneDocument, createMeshEntity, type SceneDocument } from '../model/SceneDocument';
import type { Vector3Data } from '../model/math';

type EditorLog = {
  id: string;
  message: string;
};

type EditorState = {
  scene: SceneDocument;
  logs: EditorLog[];
  createMesh: (meshKind: MeshKind) => void;
  selectEntity: (entityId: string | null) => void;
  updateSelectedTransform: (field: 'position' | 'rotation' | 'scale', axis: keyof Vector3Data, value: number) => void;
  pushLog: (message: string) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  scene: createEmptySceneDocument(),
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  createMesh: (meshKind) => {
    const entity = createMeshEntity(meshKind);
    set((state) => ({
      scene: {
        ...state.scene,
        entityIds: [...state.scene.entityIds, entity.id],
        entities: { ...state.scene.entities, [entity.id]: entity },
        selectedEntityId: entity.id,
      },
      logs: [{ id: crypto.randomUUID(), message: `创建 ${entity.name}` }, ...state.logs].slice(0, 100),
    }));
  },
  selectEntity: (entityId) => {
    set((state) => ({ scene: { ...state.scene, selectedEntityId: entityId } }));
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      const selectedId = state.scene.selectedEntityId;
      if (!selectedId) return state;
      const entity = state.scene.entities[selectedId];
      if (!entity) return state;
      const transform = entity.components.transform;

      return {
        scene: {
          ...state.scene,
          entities: {
            ...state.scene.entities,
            [selectedId]: {
              ...entity,
              components: {
                ...entity.components,
                transform: {
                  ...transform,
                  [field]: {
                    ...transform[field],
                    [axis]: value,
                  },
                },
              },
            },
          },
        },
      };
    });
  },
  pushLog: (message) => {
    set((state) => ({ logs: [{ id: crypto.randomUUID(), message }, ...state.logs].slice(0, 100) }));
  },
}));
```

- [ ] **Step 5: Verify model/store typecheck**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes.

---

## Task 4: Wire Hierarchy, Inspector, Console, Toolbar to Store

**Files:**
- Modify: `src/editor/layout/EditorLayout.tsx`
- Modify: `src/editor/panels/HierarchyPanel.tsx`
- Modify: `src/editor/panels/InspectorPanel.tsx`
- Modify: `src/editor/panels/ConsolePanel.tsx`

- [ ] **Step 1: Connect toolbar create actions**

Modify `src/editor/layout/EditorLayout.tsx` so it reads `createMesh` from store:

```tsx
import { ConsolePanel } from '../panels/ConsolePanel';
import { HierarchyPanel } from '../panels/HierarchyPanel';
import { InspectorPanel } from '../panels/InspectorPanel';
import { ProjectPanel } from '../panels/ProjectPanel';
import { SceneViewPanel } from '../panels/SceneViewPanel';
import { useEditorStore } from '../store/editorStore';
import { Toolbar } from '../ui/Toolbar';
import styles from './EditorLayout.module.css';

export function EditorLayout() {
  const createMesh = useEditorStore((state) => state.createMesh);

  return (
    <div className={styles.editorShell}>
      <Toolbar
        onCreateCube={() => createMesh('cube')}
        onCreateSphere={() => createMesh('sphere')}
        onCreatePlane={() => createMesh('plane')}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onSaveScene={() => undefined}
        onLoadScene={() => undefined}
        canUndo={false}
        canRedo={false}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}><HierarchyPanel /></aside>
        <main className={styles.centerColumn}>
          <SceneViewPanel />
          <ConsolePanel />
        </main>
        <aside className={styles.rightColumn}><InspectorPanel /></aside>
      </div>
      <div className={styles.bottomBar}><ProjectPanel /></div>
    </div>
  );
}
```

- [ ] **Step 2: Connect Hierarchy panel**

Replace `src/editor/panels/HierarchyPanel.tsx`:

```tsx
import { useEditorStore } from '../store/editorStore';

export function HierarchyPanel() {
  const entityIds = useEditorStore((state) => state.scene.entityIds);
  const entities = useEditorStore((state) => state.scene.entities);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const selectEntity = useEditorStore((state) => state.selectEntity);

  return (
    <section className="panel">
      <h2>Hierarchy</h2>
      {entityIds.length === 0 ? <p className="muted">点击顶部工具栏创建对象。</p> : null}
      <div className="entity-list">
        {entityIds.map((entityId) => {
          const entity = entities[entityId];
          return (
            <button
              className={entityId === selectedEntityId ? 'entity-item selected' : 'entity-item'}
              key={entityId}
              onClick={() => selectEntity(entityId)}
            >
              {entity.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

Append to `src/styles/global.css`:

```css
.entity-list {
  display: grid;
  gap: 4px;
}

.entity-item {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  color: #d7d7d7;
  text-align: left;
  background: transparent;
}

.entity-item:hover,
.entity-item.selected {
  border-color: #3d6fb6;
  background: #264f78;
}
```

- [ ] **Step 3: Connect Inspector panel**

Replace `src/editor/panels/InspectorPanel.tsx`:

```tsx
import type { Vector3Data } from '../model/math';
import { useEditorStore } from '../store/editorStore';

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];
const fields: Array<'position' | 'rotation' | 'scale'> = ['position', 'rotation', 'scale'];

export function InspectorPanel() {
  const scene = useEditorStore((state) => state.scene);
  const updateSelectedTransform = useEditorStore((state) => state.updateSelectedTransform);
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;

  if (!selectedEntity) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">请选择一个对象。</p>
      </section>
    );
  }

  const transform = selectedEntity.components.transform;

  return (
    <section className="panel">
      <h2>Inspector</h2>
      <h3>{selectedEntity.name}</h3>
      {fields.map((field) => (
        <fieldset className="transform-fieldset" key={field}>
          <legend>{field}</legend>
          {axes.map((axis) => (
            <label className="number-row" key={`${field}-${axis}`}>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                step="0.1"
                value={transform[field][axis]}
                onChange={(event) => updateSelectedTransform(field, axis, Number(event.target.value))}
              />
            </label>
          ))}
        </fieldset>
      ))}
    </section>
  );
}
```

Append to `src/styles/global.css`:

```css
.transform-fieldset {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  border: 1px solid #3c3c3c;
}

.number-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.number-row input {
  width: 100%;
  border: 1px solid #555;
  color: #d7d7d7;
  background: #1e1e1e;
}
```

- [ ] **Step 4: Connect Console panel**

Replace `src/editor/panels/ConsolePanel.tsx`:

```tsx
import { useEditorStore } from '../store/editorStore';

export function ConsolePanel() {
  const logs = useEditorStore((state) => state.logs);

  return (
    <section className="panel">
      <h2>Console</h2>
      <div className="console-log-list">
        {logs.map((log) => (
          <div className="console-log" key={log.id}>{log.message}</div>
        ))}
      </div>
    </section>
  );
}
```

Append to `src/styles/global.css`:

```css
.console-log-list {
  display: grid;
  gap: 2px;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.console-log {
  color: #c8c8c8;
}
```

- [ ] **Step 5: Verify UI/store wiring**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes. Manual check after runtime launch: clicking Cube/Sphere/Plane adds entries to Hierarchy and Console, and selecting an entry displays Transform in Inspector.

---

## Task 5: Add Babylon Scene Runtime

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`
- Create: `src/runtime/babylon/createEngine.ts`
- Create: `src/runtime/babylon/SceneRuntime.ts`

- [ ] **Step 1: Create Babylon engine helper**

Create `src/runtime/babylon/createEngine.ts`:

```ts
import { ArcRotateCamera, Engine, HemisphericLight, Scene, Vector3 } from '@babylonjs/core';

export type BabylonViewport = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
};

export function createBabylonViewport(canvas: HTMLCanvasElement): BabylonViewport {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor.set(0.08, 0.08, 0.09, 1);

  const camera = new ArcRotateCamera('EditorCamera', Math.PI / 4, Math.PI / 3, 8, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 40;

  const light = new HemisphericLight('EditorLight', new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  engine.runRenderLoop(() => {
    scene.render();
  });

  return { engine, scene, camera };
}
```

- [ ] **Step 2: Create scene runtime synchronizer**

Create `src/runtime/babylon/SceneRuntime.ts`:

```ts
import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { SceneDocument } from '../../editor/model/SceneDocument';

export class SceneRuntime {
  private readonly meshes = new Map<string, Mesh>();

  constructor(private readonly scene: Scene) {}

  sync(document: SceneDocument): void {
    const liveIds = new Set(document.entityIds);

    for (const [entityId, mesh] of this.meshes.entries()) {
      if (!liveIds.has(entityId)) {
        mesh.dispose();
        this.meshes.delete(entityId);
      }
    }

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      this.syncEntity(entity, entityId === document.selectedEntityId);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
  }

  private syncEntity(entity: Entity, selected: boolean): void {
    const meshRenderer = entity.components.meshRenderer;
    if (!meshRenderer) return;

    let mesh = this.meshes.get(entity.id);
    if (!mesh) {
      mesh = this.createMesh(entity);
      this.meshes.set(entity.id, mesh);
    }

    const transform = entity.components.transform;
    mesh.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    mesh.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    mesh.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);

    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${entity.id}_mat`, this.scene);
    material.diffuseColor = selected ? Color3.FromHexString('#f7d774') : Color3.FromHexString(meshRenderer.materialColor);
    material.emissiveColor = selected ? Color3.FromHexString('#332400') : Color3.Black();
    mesh.material = material;
  }

  private createMesh(entity: Entity): Mesh {
    const meshKind = entity.components.meshRenderer?.meshKind ?? 'cube';

    if (meshKind === 'sphere') {
      return MeshBuilder.CreateSphere(entity.id, { diameter: 1 }, this.scene);
    }

    if (meshKind === 'plane') {
      return MeshBuilder.CreateGround(entity.id, { width: 2, height: 2 }, this.scene);
    }

    return MeshBuilder.CreateBox(entity.id, { size: 1 }, this.scene);
  }
}
```

- [ ] **Step 3: Mount Babylon canvas in Scene panel**

Replace `src/editor/panels/SceneViewPanel.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { createBabylonViewport, type BabylonViewport } from '../../runtime/babylon/createEngine';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { useEditorStore } from '../store/editorStore';

export function SceneViewPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);

  useEffect(() => {
    if (!canvasRef.current) return;

    const viewport = createBabylonViewport(canvasRef.current);
    const runtime = new SceneRuntime(viewport.scene);
    viewportRef.current = viewport;
    runtimeRef.current = runtime;

    const resize = () => viewport.engine.resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      runtime.dispose();
      viewport.engine.dispose();
      viewportRef.current = null;
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.sync(sceneDocument);
  }, [sceneDocument]);

  return (
    <section className="scene-panel">
      <h2>Scene</h2>
      <canvas ref={canvasRef} className="scene-canvas" />
    </section>
  );
}
```

Append to `src/styles/global.css`:

```css
.scene-canvas {
  display: block;
  width: 100%;
  height: calc(100% - 28px);
  outline: none;
  background: #151515;
}
```

- [ ] **Step 4: Verify Babylon runtime typecheck**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes. Manual check after launch: Scene panel displays a Babylon viewport and created objects appear in 3D.

---

## Task 6: Add Command History for Undo/Redo

**Files:**
- Create: `src/editor/commands/Command.ts`
- Create: `src/editor/commands/CommandHistory.ts`
- Create: `src/editor/commands/entityCommands.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/layout/EditorLayout.tsx`

- [ ] **Step 1: Create command interfaces**

Create `src/editor/commands/Command.ts`:

```ts
import type { SceneDocument } from '../model/SceneDocument';

export type Command = {
  label: string;
  execute: (scene: SceneDocument) => SceneDocument;
  undo: (scene: SceneDocument) => SceneDocument;
};
```

Create `src/editor/commands/CommandHistory.ts`:

```ts
import type { Command } from './Command';
import type { SceneDocument } from '../model/SceneDocument';

export type CommandHistory = {
  undoStack: Command[];
  redoStack: Command[];
};

export function createCommandHistory(): CommandHistory {
  return { undoStack: [], redoStack: [] };
}

export function executeCommand(scene: SceneDocument, history: CommandHistory, command: Command) {
  return {
    scene: command.execute(scene),
    history: { undoStack: [...history.undoStack, command], redoStack: [] },
  };
}

export function undoCommand(scene: SceneDocument, history: CommandHistory) {
  const command = history.undoStack.at(-1);
  if (!command) return { scene, history };

  return {
    scene: command.undo(scene),
    history: {
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [command, ...history.redoStack],
    },
  };
}

export function redoCommand(scene: SceneDocument, history: CommandHistory) {
  const command = history.redoStack[0];
  if (!command) return { scene, history };

  return {
    scene: command.execute(scene),
    history: {
      undoStack: [...history.undoStack, command],
      redoStack: history.redoStack.slice(1),
    },
  };
}
```

- [ ] **Step 2: Create entity commands**

Create `src/editor/commands/entityCommands.ts`:

```ts
import type { Command } from './Command';
import type { Entity } from '../model/Entity';
import type { SceneDocument } from '../model/SceneDocument';
import type { TransformComponent } from '../model/components';

export function createEntityCommand(entity: Entity): Command {
  return {
    label: `创建 ${entity.name}`,
    execute: (scene) => ({
      ...scene,
      entityIds: [...scene.entityIds, entity.id],
      entities: { ...scene.entities, [entity.id]: entity },
      selectedEntityId: entity.id,
    }),
    undo: (scene) => {
      const { [entity.id]: _removed, ...entities } = scene.entities;
      return {
        ...scene,
        entityIds: scene.entityIds.filter((id) => id !== entity.id),
        entities,
        selectedEntityId: scene.selectedEntityId === entity.id ? null : scene.selectedEntityId,
      };
    },
  };
}

export function updateTransformCommand(entityId: string, before: TransformComponent, after: TransformComponent): Command {
  return {
    label: '更新 Transform',
    execute: (scene) => updateTransform(scene, entityId, after),
    undo: (scene) => updateTransform(scene, entityId, before),
  };
}

function updateTransform(scene: SceneDocument, entityId: string, transform: TransformComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          transform,
        },
      },
    },
  };
}
```

- [ ] **Step 3: Refactor store to use command history**

Modify `src/editor/store/editorStore.ts` to add `history`, `undo`, `redo`, and command-based mutations. Preserve the public methods already used by panels:

```ts
import { create } from 'zustand';
import { createCommandHistory, executeCommand, redoCommand, undoCommand, type CommandHistory } from '../commands/CommandHistory';
import { createEntityCommand, updateTransformCommand } from '../commands/entityCommands';
import type { MeshKind } from '../model/components';
import { createEmptySceneDocument, createMeshEntity, type SceneDocument } from '../model/SceneDocument';
import type { Vector3Data } from '../model/math';

type EditorLog = {
  id: string;
  message: string;
};

type EditorState = {
  scene: SceneDocument;
  history: CommandHistory;
  logs: EditorLog[];
  createMesh: (meshKind: MeshKind) => void;
  selectEntity: (entityId: string | null) => void;
  updateSelectedTransform: (field: 'position' | 'rotation' | 'scale', axis: keyof Vector3Data, value: number) => void;
  undo: () => void;
  redo: () => void;
  pushLog: (message: string) => void;
};

function log(message: string, logs: EditorLog[]): EditorLog[] {
  return [{ id: crypto.randomUUID(), message }, ...logs].slice(0, 100);
}

export const useEditorStore = create<EditorState>((set) => ({
  scene: createEmptySceneDocument(),
  history: createCommandHistory(),
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  createMesh: (meshKind) => {
    const entity = createMeshEntity(meshKind);
    const command = createEntityCommand(entity);
    set((state) => {
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: log(command.label, state.logs) };
    });
  },
  selectEntity: (entityId) => {
    set((state) => ({ scene: { ...state.scene, selectedEntityId: entityId } }));
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      const selectedId = state.scene.selectedEntityId;
      if (!selectedId) return state;
      const entity = state.scene.entities[selectedId];
      if (!entity) return state;

      const before = entity.components.transform;
      const after = {
        ...before,
        [field]: {
          ...before[field],
          [axis]: value,
        },
      };
      const command = updateTransformCommand(selectedId, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: log(`${command.label}: ${entity.name}`, state.logs) };
    });
  },
  undo: () => {
    set((state) => {
      const result = undoCommand(state.scene, state.history);
      return { ...result, logs: log('Undo', state.logs) };
    });
  },
  redo: () => {
    set((state) => {
      const result = redoCommand(state.scene, state.history);
      return { ...result, logs: log('Redo', state.logs) };
    });
  },
  pushLog: (message) => {
    set((state) => ({ logs: log(message, state.logs) }));
  },
}));
```

- [ ] **Step 4: Wire toolbar undo/redo**

Modify `src/editor/layout/EditorLayout.tsx` to read `undo`, `redo`, and stack lengths from store:

```tsx
import { ConsolePanel } from '../panels/ConsolePanel';
import { HierarchyPanel } from '../panels/HierarchyPanel';
import { InspectorPanel } from '../panels/InspectorPanel';
import { ProjectPanel } from '../panels/ProjectPanel';
import { SceneViewPanel } from '../panels/SceneViewPanel';
import { useEditorStore } from '../store/editorStore';
import { Toolbar } from '../ui/Toolbar';
import styles from './EditorLayout.module.css';

export function EditorLayout() {
  const createMesh = useEditorStore((state) => state.createMesh);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.history.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.history.redoStack.length > 0);

  return (
    <div className={styles.editorShell}>
      <Toolbar
        onCreateCube={() => createMesh('cube')}
        onCreateSphere={() => createMesh('sphere')}
        onCreatePlane={() => createMesh('plane')}
        onUndo={undo}
        onRedo={redo}
        onSaveScene={() => undefined}
        onLoadScene={() => undefined}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}><HierarchyPanel /></aside>
        <main className={styles.centerColumn}>
          <SceneViewPanel />
          <ConsolePanel />
        </main>
        <aside className={styles.rightColumn}><InspectorPanel /></aside>
      </div>
      <div className={styles.bottomBar}><ProjectPanel /></div>
    </div>
  );
}
```

- [ ] **Step 5: Verify Undo/Redo typecheck**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes. Manual check after launch: creating an object enables Undo, Undo removes it, Redo restores it.

---

## Task 7: Add Scene Serialization and Electron IPC Save/Load

**Files:**
- Create: `src/editor/project/SceneSerializer.ts`
- Modify: `electron/types.ts`
- Create: `electron/ipc/projectIpc.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/layout/EditorLayout.tsx`

- [ ] **Step 1: Create scene serializer**

Create `src/editor/project/SceneSerializer.ts`:

```ts
import { createEmptySceneDocument, type SceneDocument } from '../model/SceneDocument';

export function serializeScene(scene: SceneDocument): string {
  return JSON.stringify({ version: 1, scene }, null, 2);
}

export function deserializeScene(content: string): SceneDocument {
  const parsed = JSON.parse(content) as { version?: number; scene?: SceneDocument };
  if (parsed.version !== 1 || !parsed.scene) {
    throw new Error('场景文件格式不受支持。');
  }

  return {
    ...createEmptySceneDocument(parsed.scene.name),
    ...parsed.scene,
    selectedEntityId: null,
  };
}
```

- [ ] **Step 2: Add project IPC types and handlers**

Modify `electron/types.ts`:

```ts
export type SceneFilePayload = {
  name: string;
  content: string;
};

export type SaveSceneRequest = {
  suggestedName: string;
  content: string;
};

export type SaveSceneResult = {
  canceled: boolean;
  filePath: string | null;
};

export type LoadSceneResult = {
  canceled: boolean;
  filePath: string | null;
  content: string | null;
};

export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
};
```

Create `electron/ipc/projectIpc.ts`:

```ts
import { dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import type { LoadSceneResult, SaveSceneRequest, SaveSceneResult } from '../types';

export function registerProjectIpc(): void {
  ipcMain.handle('scene:save', async (_event, request: SaveSceneRequest): Promise<SaveSceneResult> => {
    const result = await dialog.showSaveDialog({
      title: '保存场景',
      defaultPath: request.suggestedName,
      filters: [{ name: 'Babylon Editor Scene', extensions: ['scene.json'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true, filePath: null };
    }

    await fs.writeFile(result.filePath, request.content, 'utf-8');
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('scene:load', async (): Promise<LoadSceneResult> => {
    const result = await dialog.showOpenDialog({
      title: '加载场景',
      properties: ['openFile'],
      filters: [{ name: 'Babylon Editor Scene', extensions: ['json'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null, content: null };
    }

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf-8');
    return { canceled: false, filePath, content };
  });
}
```

Modify `electron/main.ts` to register IPC before creating window:

```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProjectIpc } from './ipc/projectIpc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  registerProjectIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 3: Expose preload scene API**

Modify `electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { LoadSceneResult, SaveSceneRequest, SaveSceneResult } from './types';

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest): Promise<SaveSceneResult> => ipcRenderer.invoke('scene:save', request),
  loadScene: (): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:load'),
});
```

Modify `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

type SaveSceneRequest = {
  suggestedName: string;
  content: string;
};

type SaveSceneResult = {
  canceled: boolean;
  filePath: string | null;
};

type LoadSceneResult = {
  canceled: boolean;
  filePath: string | null;
  content: string | null;
};

interface Window {
  editorApi: {
    version: string;
    saveScene: (request: SaveSceneRequest) => Promise<SaveSceneResult>;
    loadScene: () => Promise<LoadSceneResult>;
  };
}
```

- [ ] **Step 4: Add store save/load actions**

Add to `EditorState` in `src/editor/store/editorStore.ts`:

```ts
saveScene: () => Promise<void>;
loadScene: () => Promise<void>;
```

Add imports:

```ts
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
```

Add methods inside the store object:

```ts
saveScene: async () => {
  const scene = useEditorStore.getState().scene;
  const content = serializeScene(scene);
  const result = await window.editorApi.saveScene({ suggestedName: `${scene.name}.scene.json`, content });
  useEditorStore.getState().pushLog(result.canceled ? '已取消保存场景。' : `场景已保存：${result.filePath}`);
},
loadScene: async () => {
  const result = await window.editorApi.loadScene();
  if (result.canceled || !result.content) {
    useEditorStore.getState().pushLog('已取消加载场景。');
    return;
  }

  const scene = deserializeScene(result.content);
  set((state) => ({
    scene,
    history: createCommandHistory(),
    logs: log(`场景已加载：${result.filePath}`, state.logs),
  }));
},
```

- [ ] **Step 5: Wire toolbar save/load**

Modify `src/editor/layout/EditorLayout.tsx` to read and pass `saveScene`/`loadScene`:

```tsx
const saveScene = useEditorStore((state) => state.saveScene);
const loadScene = useEditorStore((state) => state.loadScene);
```

Then set toolbar props:

```tsx
onSaveScene={() => void saveScene()}
onLoadScene={() => void loadScene()}
```

- [ ] **Step 6: Verify save/load typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands pass. Manual check after launch: create Cube, save `.scene.json`, restart/load file, Cube appears again.

---

## Task 8: Add Basic Asset Directory Scan

**Files:**
- Create: `electron/ipc/assetIpc.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/vite-env.d.ts`
- Create: `src/editor/assets/AssetDatabase.ts`
- Modify: `src/editor/panels/ProjectPanel.tsx`

- [ ] **Step 1: Create asset database types**

Create `src/editor/assets/AssetDatabase.ts`:

```ts
export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
};
```

- [ ] **Step 2: Create asset IPC**

Create `electron/ipc/assetIpc.ts`:

```ts
import { dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetEntry } from '../types';

function getAssetKind(filePath: string, isDirectory: boolean): AssetEntry['kind'] {
  if (isDirectory) return 'folder';
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.glb' || extension === '.gltf') return 'model';
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.webp') return 'texture';
  if (filePath.endsWith('.scene.json')) return 'scene';
  return 'unknown';
}

export function registerAssetIpc(): void {
  ipcMain.handle('assets:scan', async (): Promise<AssetEntry[]> => {
    const result = await dialog.showOpenDialog({
      title: '选择 Assets 目录',
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    const root = result.filePaths[0];
    const entries = await fs.readdir(root, { withFileTypes: true });

    return entries.map((entry) => {
      const fullPath = path.join(root, entry.name);
      return {
        id: fullPath,
        name: entry.name,
        path: fullPath,
        kind: getAssetKind(fullPath, entry.isDirectory()),
      };
    });
  });
}
```

- [ ] **Step 3: Register asset IPC**

Modify `electron/main.ts` imports:

```ts
import { registerAssetIpc } from './ipc/assetIpc.js';
import { registerProjectIpc } from './ipc/projectIpc.js';
```

Modify `app.whenReady().then` body:

```ts
app.whenReady().then(() => {
  registerProjectIpc();
  registerAssetIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
```

- [ ] **Step 4: Expose asset scan API**

Modify `electron/preload.ts` exposed API:

```ts
scanAssets: (): Promise<AssetEntry[]> => ipcRenderer.invoke('assets:scan'),
```

Modify `src/vite-env.d.ts`:

```ts
type AssetEntry = {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
};
```

And add to `window.editorApi`:

```ts
scanAssets: () => Promise<AssetEntry[]>;
```

- [ ] **Step 5: Implement Project panel asset scan**

Replace `src/editor/panels/ProjectPanel.tsx`:

```tsx
import { useState } from 'react';
import type { AssetEntry } from '../assets/AssetDatabase';
import { useEditorStore } from '../store/editorStore';

export function ProjectPanel() {
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const pushLog = useEditorStore((state) => state.pushLog);

  async function scanAssets() {
    const result = await window.editorApi.scanAssets();
    setAssets(result);
    pushLog(result.length === 0 ? '未选择 Assets 目录或目录为空。' : `扫描到 ${result.length} 个资产。`);
  }

  return (
    <section className="panel">
      <h2>Project</h2>
      <button onClick={() => void scanAssets()}>扫描 Assets 目录</button>
      <div className="asset-list">
        {assets.map((asset) => (
          <div className="asset-item" key={asset.id} title={asset.path}>
            <span>{asset.kind}</span>
            <strong>{asset.name}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
```

Append to `src/styles/global.css`:

```css
.asset-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.asset-item {
  display: grid;
  gap: 4px;
  padding: 8px;
  border: 1px solid #3c3c3c;
  background: #1e1e1e;
}

.asset-item span {
  color: #8f8f8f;
  font-size: 11px;
}
```

- [ ] **Step 6: Verify asset scan build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands pass. Manual check after launch: Project panel button opens directory picker and lists first-level files/folders.

---

## Task 9: Add README Documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Create `README.md`:

```md
# Babylon Electron Unity-like Editor

这是一个使用 Babylon.js + Electron + React + TypeScript 构建的 Unity-like 3D 编辑器 MVP。

## 当前目标

第一阶段目标是交付一个可启动、可编辑、可保存/加载的桌面 3D 编辑器内核，而不是一次性复刻 Unity3D 的全部功能。

## 当前功能

- Electron 桌面窗口
- Unity-like 五面板布局：Hierarchy、Scene、Inspector、Project、Console
- Babylon.js Scene View
- 创建基础 Mesh：Cube、Sphere、Plane
- Hierarchy 选择实体
- Inspector 编辑 Transform
- Undo/Redo 创建对象与 Transform 修改
- JSON 场景保存与加载
- Assets 目录扫描

## 启动方式

```bash
npm install
npm run dev:electron
```

## 构建检查

```bash
npm run typecheck
npm run build
```

## 架构说明

Electron 主进程负责窗口、文件系统和安全 IPC。React 渲染进程负责编辑器 UI、状态管理和命令分发。Babylon.js runtime 只作为 Scene View 的渲染适配层，不作为场景数据的唯一来源。

核心边界：

- `electron/`：主进程、preload、IPC
- `src/editor/model/`：与 Babylon 解耦的场景数据模型
- `src/editor/commands/`：命令式 Undo/Redo
- `src/editor/store/`：编辑器状态
- `src/runtime/babylon/`：Babylon runtime 同步层
- `src/editor/panels/`：编辑器 UI 面板

## 场景文件

场景保存为 `.scene.json` 文件，内容包含版本号与 `SceneDocument`。后续 Prefab、资产引用和 Play Mode 都应继续基于 `SceneDocument` 扩展。

## 后续路线

1. Transform Gizmo 拖拽同步
2. glTF/GLB 导入
3. Prefab 与资产 GUID
4. 材质与灯光编辑器
5. Play Mode 编辑态/运行态隔离
6. 脚本组件系统
7. 动画、物理、粒子、Terrain
8. 构建导出与插件系统
```

- [ ] **Step 2: Verify docs mention actual scripts**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes; README scripts match `package.json` scripts.

---

## Task 10: End-to-End Manual Verification

**Files:**
- No code files expected unless fixing discovered issues.
- Modify: `README.md` only if verification reveals inaccurate documentation.

- [ ] **Step 1: Clear current-task node/electron residue before launch**

On Windows, inspect processes and only stop processes clearly tied to this project path or command. Use PowerShell, not Bash, for process inspection:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|electron|chrome' -and $_.CommandLine -match '3d-babylon-editor|vite|electron' } | Select-Object ProcessId, Name, CommandLine
```

Expected: either no matching processes or only current project-related processes. Stop only project-related stale processes if needed.

- [ ] **Step 2: Start app**

Run:

```bash
npm run dev:electron
```

Expected: Electron window opens with five editor panels.

- [ ] **Step 3: Verify core workflow manually**

Manual actions and expected results:

1. Click `Cube`; expected Hierarchy shows `Cube`, Console logs creation, Scene shows cube.
2. Click `Sphere`; expected Hierarchy shows `Sphere`, Scene shows sphere.
3. Select `Cube`; expected Inspector shows Cube Transform.
4. Change Cube position X to `2`; expected Scene cube moves and Console logs Transform update.
5. Click `Undo`; expected transform change reverts or latest command is undone.
6. Click `Redo`; expected undone change is restored.
7. Click `保存场景`; expected a `.scene.json` file can be written.
8. Restart app and click `加载场景`; expected saved scene entities reappear.
9. Click `扫描 Assets 目录`; expected first-level files/folders appear in Project panel.

- [ ] **Step 4: Final build verification**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Update README if behavior differs**

If manual behavior differs from README, update `README.md` so it only claims verified behavior.

---

## Self-Review

### Spec coverage

- 工程骨架：Task 1 覆盖。
- Unity-like 五面板布局：Task 2 覆盖。
- 场景实体模型：Task 3 覆盖。
- Hierarchy、Inspector、Console、Toolbar：Task 4 覆盖。
- Babylon Scene View：Task 5 覆盖。
- Undo/Redo：Task 6 覆盖。
- JSON 保存/加载：Task 7 覆盖。
- Project/Assets 基础扫描：Task 8 覆盖。
- README 文档：Task 9 覆盖。
- 端到端验证：Task 10 覆盖。

### Placeholder scan

本计划未使用 `TBD`、`TODO`、`implement later` 等占位表达。后续执行时如果实际库版本 API 有差异，应以 `npm run typecheck` 的报错为准修正具体实现。

### Type consistency

- `SceneDocument`、`Entity`、`TransformComponent`、`MeshKind` 在 Task 3 定义，并在后续 Task 4-7 使用。
- `CommandHistory` 在 Task 6 定义，并在 store 中统一使用 `undoStack` 与 `redoStack`。
- preload API 的 `saveScene`、`loadScene`、`scanAssets` 在 Electron 和 `src/vite-env.d.ts` 中保持同名。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-babylon-electron-unity-editor-mvp.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, faster iteration for this multi-file MVP.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
