# 场景 Web 部署导出

## 功能说明

编辑器顶部 Toolbar 的“导出部署工程”用于把当前内存中的场景快照导出为独立静态 Web 工程。导出结果不包含编辑器、Electron 或 Node.js 运行环境，部署服务器只需要提供普通 HTTP/HTTPS 静态文件访问能力。Viewer 运行端要求浏览器提供硬件加速 WebGL；若只能获得 SwiftShader、WARP、llvmpipe 等软件 renderer，页面会阻断启动并显示排查提示，不再以低帧率软件渲染静默运行。

支持两种输出：

- **部署目录**：直接生成 `<场景名>-web` 目录。
- **ZIP 压缩包**：生成包含同一目录结构的 `.zip` 文件。

导出会捕获点击“开始导出”时的场景状态，包括尚未保存到 `.scene.json` 的修改。相机使用场景中已经保存的视角；如果尚未保存视角，则使用 Viewer 默认相机。

## 导出步骤

1. 停止运行预览，并等待正在执行的 CAD 导入结束。
2. 点击 Toolbar 的 `📦 导出部署工程`。
3. 填写工程名称，选择“部署目录”或“ZIP 压缩包”。
4. 点击“开始导出”，在系统对话框中选择输出位置。
5. 等待资源预检、复制、清单生成和发布完成。
6. 成功后可在对话框中打开结果位置。

导出过程使用当前场景引用自动收集普通模型、模型生成器目标、环境模型、HDR/EXR 天空盒、DXF、模型脚本和贴图。缺失、不可读取、符号链接、Junction 或路径逃逸资源会阻止导出，避免生成无法部署的半成品。

球形天空盒以实体形式保存在 `components.skybox`，导出会保留它的 Hierarchy 状态以及 position / rotation / scale；旧场景级 `sceneSettings.skybox` 仍可兼容收集。Viewer 中球体位置和尺寸与编辑器一致；默认使用基础直径 `10000 m`，球心位于 `Y=0` 网格平面，上、下半球分别处于网格两侧。尺寸倍率统一限制为 `0.1–1.0`，实际直径为 `1000–10000 m`；含天空盒场景的可视距离最低为 `12000 m`，旧场景在加载时自动迁移，同时继续提供 PBR 环境照明。

环境模型以唯一的 `sceneSettings.environment` 场景底座导出，Viewer 会保留源单位换算、`scene-base / legacy-left` 摆放模式、position / XYZ rotation / 统一 scale、显隐、透明度和活动变体。Viewer 启动会等待环境候选容器加载完成后再进入 ready；环境只作为静态不可拾取视觉底座，不启用 GLB 内相机、灯光、动画或模型脚本。透明度小于 100% 时使用与编辑器一致的幽灵显示，加载失败会阻断 Viewer 启动并显示具体错误，避免静默展示缺少底座的场景。

## 输出结构

```text
<场景名>-web/
├─ index.html
├─ README.md
├─ assets/
├─ runtime-config.json
└─ project/
   ├─ scene.json
   ├─ asset-manifest.json
   └─ assets/
      ├─ models/
      ├─ environments/
      ├─ skyboxes/
      └─ cad/
```

- `index.html`、`assets/`：预构建的只读 Web Viewer。
- `runtime-config.json`：部署后可直接修改的页面、资源和 MQTT 配置。
- `project/scene.json`：已移除本机绝对路径的 Viewer 专用场景快照。
- `project/asset-manifest.json`：虚拟资源 URL 到部署文件的映射，并记录字节数和 SHA-256。
- `project/assets/`：场景运行所需模型包、环境、天空盒、DXF、脚本和贴图。

`project/scene.json` 是部署运行产物，不保证能够直接重新导入编辑器。

## runtime-config.json

```json
{
  "version": 1,
  "page": {
    "title": "场景名称",
    "loadingText": "场景加载中...",
    "backgroundColor": "#141414"
  },
  "paths": {
    "scene": "./project/scene.json",
    "assetManifest": "./project/asset-manifest.json",
    "assetBase": "./project/assets/"
  },
  "viewer": {
    "showGrid": false,
    "allowCameraControl": true,
    "showStatusOverlay": true
  },
  "mqtt": {
    "enabled": false,
    "ip": "",
    "address": "",
    "topic": "",
    "subscriptions": [],
    "simulatorEnabled": false,
    "simulatorAssetCode": "",
    "simulatorScenario": "cycle",
    "simulatorIntervalMs": 500
  }
}
```

页面刷新时会重新读取该文件，不需要重新打包。相对路径按 `index.html` 所在地址解析；也可改为允许跨域访问的 HTTP/HTTPS 地址。

普通 Web 部署由 `viewer.showStatusOverlay` 决定运行状态层的初始可见性，并继续按场景内容显示右下角自动巡检面板。数字孪生发布包（`version: 2`）在场景就绪后固定默认隐藏运行状态层和自动巡检面板，同时按下鼠标左键和右键可切换两者显示或隐藏。场景就绪后的运行状态层以 1 秒间隔显示 Babylon 实时 FPS；加载、启动阻断和真实运行异常不受隐藏状态影响。

### MQTT 约束

- 浏览器真实连接仅支持 `ws://` 或 `wss://`。
- 不要在静态 JSON 中保存用户名、密码、长期 Token 或其他秘密。
- 导出时复制当前场景的地址、Topic、订阅和适配器，但默认关闭本地模拟器。
- 地址为空、协议不受支持或 URL 包含用户凭据时，导出结果会禁用 MQTT 并给出警告。
- MQTT 连接失败不会阻止静态场景显示，错误会显示在 Viewer 状态层。

## 部署方式

必须通过 HTTP/HTTPS 访问，不支持直接双击 `index.html`。可将整个目录作为静态站点根目录部署到：

- Nginx；
- IIS；
- Apache；
- 对象存储静态网站；
- 其他支持正确 JavaScript、Worker、JSON、GLB/GLTF 和 DXF 响应的静态文件服务。

示例：

```powershell
npx vite preview --host 127.0.0.1
```

生产环境应由正式 Web 服务器提供 HTTPS。若 MQTT 页面使用 HTTPS，Broker 通常也应提供 `wss://`，否则浏览器会阻止混合内容连接。

## 浏览器 GPU 要求与排查

- Viewer 创建 WebGL 时请求 `high-performance` GPU，并设置 `failIfMajorPerformanceCaveat=true`，避免浏览器在存在重大性能降级时继续返回软件实现。
- Viewer 会读取实际 WebGL renderer，并拒绝 SwiftShader、WARP、llvmpipe、lavapipe、softpipe 和 Microsoft Basic Render Driver；同时显式保持 `desynchronized=false`，继续通过 Babylon `runRenderLoop` 使用浏览器显示帧节拍。
- 如果页面提示“硬件加速 WebGL 创建失败”，请在 Chrome/Edge 的系统设置中启用硬件加速后完全重启浏览器，更新显卡驱动，并确认系统图形策略允许该浏览器使用高性能 GPU。可通过 `chrome://gpu` 或 `edge://gpu` 检查 WebGL 与 GPU compositing 状态。
- 网页无法绕过浏览器 GPU 黑名单、远程桌面限制或企业策略强制启用显卡；这些环境下 Viewer 会明确阻断，而不是回退到容易卡顿的 CPU 软件 renderer。
- 启动成功时浏览器控制台会输出 `[Babylon] 硬件加速 WebGL 已启用`，并附带 WebGL 版本、vendor 和 renderer，便于现场确认实际显卡后端。

## 模型脚本与 CSP

外置 TypeScript 模型脚本（`*.model.ts`、meta 显式引用或数据中台登记的其它可执行 `.ts`，不含 `.d.ts`）使用当前项目的可信脚本运行机制：浏览器加载脚本文本、使用打包进 Viewer 的 TypeScript 编译器转译，并通过 `new Function` 执行。

如果部署服务器设置 Content-Security-Policy，需要允许该链路使用的 `unsafe-eval`。如果安全策略不允许 `unsafe-eval`，带外置脚本的模型无法正常工作；不带外置脚本的普通静态模型不受此限制。

只应部署来自可信项目和可信模型包的导出结果。

## 性能和失败恢复

- 资产采用流式复制和 SHA-256 计算，不会把完整 GLB、DXF 或 ZIP 一次性读入内存。
- 同时复制的文件数量固定受限，避免大模型包导致内存或磁盘请求峰值。
- 导出服务只读取当前项目索引或本次会话中通过文件/目录选择明确授权的资源；场景 JSON 不能借由绝对路径扩大主进程文件读取范围。
- 已登记模型和环境仍按完整 `packagePath` 复制；天空盒只复制场景明确引用的 HDR/EXR 文件。完整模型/环境包若含 `.env`、私钥、证书密钥包或版本控制目录等高置信度敏感内容，导出会阻断并要求先清理。
- 设计源文件、备份、日志、归档或 `node_modules` 等可能非运行时内容不会被静默删除，而是按完整包规则保留并产生聚合警告，部署前应确认公开范围和体积。
- 导出先写入目标父目录中的 staging，全部完成后再发布正式结果。
- 取消或失败只清理当前任务的 staging，不删除已有导出结果。
- 目录输出不会覆盖同名目录，会自动选择新的安全名称。
- ZIP 先写临时文件，完成后才替换用户确认的目标文件。

## 人工验收建议

项目按要求不新增自动化导出测试。发布前建议人工检查：

- 含普通模型、环境、天空盒、DXF、模型生成器、脚本和贴图的综合场景能够加载。
- 修改 `runtime-config.json` 后，刷新页面即可更新标题和 MQTT 配置。
- 在浏览器控制台确认 Viewer 输出真实 GPU renderer；关闭浏览器硬件加速后，页面应显示硬件 WebGL 阻断提示，而不是继续使用软件 renderer。
- 导出目录和 ZIP 解压后的文件结构一致。
- 导出内容中不存在 `C:\`、`F:\`、用户名目录或原始本机资产 URL。
- 缺失资源、取消导出和磁盘写入失败不会留下正式半成品。
