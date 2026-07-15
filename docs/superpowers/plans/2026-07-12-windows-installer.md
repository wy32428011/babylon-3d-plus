# Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 Babylon 3D Editor 生成可安装、可卸载、安装后可启动并保留项目/模型/MQTT/CAD 等桌面功能的 Windows x64 NSIS 安装包。

**Architecture:** 保持现有 React + Vite renderer、Electron main/preload 和 IPC 边界不变；仅补齐生产 `file://` 资源基址、Electron 主进程运行时依赖、electron-builder/NSIS 打包元数据与安装态冒烟脚本。安装包只包含编译后的 `dist`、`dist-electron` 和运行所需元数据，用户项目仍写入用户选择的目录，最近项目状态写入 Electron `userData`。

**Tech Stack:** Electron 42、React 19、Vite 8、TypeScript 6、electron-builder 26、NSIS、Windows x64。

---

### Task 1: 修复生产启动阻塞

**Files:**
- Modify: `vite.config.ts`
- Modify: `electron/ipc/projectAssetStore.ts`

- [x] **Step 1:** 在 Vite 配置中设置 `base: './'`，确保安装态 `file://` 页面以相对路径加载 JS、CSS、Worker 和图片。
- [x] **Step 2:** 显式从 Electron 导入 `app`，确保最近项目与用户状态可写入 `app.getPath('userData')`，避免安装态首次访问 IPC 时出现 `ReferenceError`。
- [x] **Step 3:** 执行 `npm run build`，确认 TypeScript、renderer 和 Electron 主进程均可编译。
- [x] **Step 4:** 检查 `dist/index.html`，确认资源路径均为 `./assets/...`。

### Task 2: 建立 Windows NSIS 打包链

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `build/icon.ico`

- [x] **Step 1:** 安装 `electron-builder@26.15.3` 为开发依赖。
- [x] **Step 2:** 增加 `pack:win`、`dist:win` 脚本，分别生成 unpacked 目录和 NSIS 安装包。
- [x] **Step 3:** 配置 `appId`、`productName`、`files`、`asar`、`win.target=nsis/x64`、安装目录选择、桌面/开始菜单快捷方式和稳定的产物命名。
- [x] **Step 4:** 生成多尺寸 Windows ICO，避免安装程序和快捷方式使用 Electron 默认图标。

### Task 3: 增加安装态冒烟验证

**Files:**
- Create: `scripts/smoke-packaged-windows.mjs`
- Modify: `package.json`

- [x] **Step 1:** 编写仅用于本地交付验证的脚本：启动 `release/win-unpacked/Babylon 3D Editor.exe`，等待窗口进程稳定，确认未提前崩溃后关闭进程树。
- [x] **Step 2:** 增加 `smoke:packaged:win` 脚本，失败时返回非零退出码并输出中文诊断。
- [x] **Step 3:** 执行 unpacked 冒烟验证，并检查主进程/renderer 启动日志。

### Task 4: 生成安装包并验证安装态

**Files:**
- Generated: `release/Babylon-3D-Editor-Setup-0.1.0-x64.exe`
- Generated: `release/win-unpacked/**`

- [x] **Step 1:** 执行 `npm run dist:win`，生成 NSIS 安装包。
- [x] **Step 2:** 校验安装包存在、大小合理、SHA-256 可计算。
- [x] **Step 3:** 将安装包静默安装到受控临时目录，启动已安装 EXE 并执行相同稳定性冒烟验证。
- [x] **Step 4:** 关闭本任务启动的 Electron/Node/安装器进程并删除临时安装目录，不影响用户已有进程。

### Task 5: 更新交付文档

**Files:**
- Modify: `README.md`

- [x] **Step 1:** 记录 Windows 构建环境、命令、产物路径、安装步骤和安装态数据目录。
- [x] **Step 2:** 记录安装包已覆盖的功能边界与未签名安装包的 Windows SmartScreen 提示。
- [x] **Step 3:** 执行 `git diff --check`、最终 `npm run build` 和安装包冒烟验证，确认交付证据完整。
