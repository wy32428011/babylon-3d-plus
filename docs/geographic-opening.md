# 参考版数字孪生开场动画

除本页的内置参考模板外，也支持导入独立开场包并按场景配置。操作和包格式见 [可导入开场动画包](opening-packages.md)。

更新时间：2026-09-28。

当前开场采用用户提供的 `zd_digital_twin_opening.html` 参考版，模板标识为 `reference-huishan`。新配置默认九个阶段、62 秒，全球与国内飞线分别使用参考画面中的 40 和 34 个视觉点位。开场总开关仍默认关闭。

## 配置入口

在场景 Inspector 中展开“开场动画”。面板保留可折叠分组，只展示参考模板实际生效的参数：

- **全球飞线停留、国内飞线停留**：分别控制第三、第六阶段，允许 0 秒。0 秒表示跳过该业务停留阶段，空点位列表则只关闭该组线路。
- **其它分镜时长**：其余七段各自调整，最少 0.1 秒；每段最多 300 秒。总时长由九段相加，不再使用旧的“基础动画 + 中国停留”计算方式。“恢复 62 秒参考节奏”只恢复九段时长。
- **品牌与公司文案**：品牌名称、公司全名、开场主副标题、抵达惠山标题。标题支持换行，按纯文本显示，不接受 HTML 脚本。
- **参考画质**：高清或流畅；**显示开场界面**控制参考版的界面信息。
- **允许跳过、动效偏好、科技呼吸、结束行为**：沿用场景级配置，保存和撤销方式保持一致。
- **全球/国内参考点位**：编辑各自起点与地点列表，可以添加预置地点、自定义地点、删除地点，以及恢复对应组的原始参考点位。

品牌与公司文案配置只影响叠加文字。部分公司名称和地图注记已经烘焙在参考底图里；若要完整更换这些内容，还需要替换对应底图。

调整后点击“预览开场动画”。参考播放器提供暂停、继续、章节和播放进度操作；这些临时播放操作不修改保存配置。编辑器的“结束预览 · Esc”结束演示并恢复预览前的编辑视角。

关闭“允许跳过”时，章节跳转、进度拖动和跳过入口同时禁用，保留暂停与重新播放。独立窗口的全屏包含开场与业务画布；内嵌大屏使用宿主已有全屏入口，避免结束时退出到黑色背景。

## 默认 62 秒流程

| 时间 | 阶段 | 默认时长 |
| --- | --- | --- |
| 0–9 秒 | 旋转地球 | 9 秒 |
| 9–16 秒 | 地球展开 | 7 秒 |
| 16–24 秒 | 全球业务 | 8 秒 |
| 24–30 秒 | 中国全景 | 6 秒 |
| 30–34 秒 | 江苏高亮 | 4 秒 |
| 34–42 秒 | 国内业务 | 8 秒 |
| 42–48 秒 | 江苏全景 | 6 秒 |
| 48–54 秒 | 无锡全景 | 6 秒 |
| 54–62 秒 | 抵达惠山 | 8 秒 |

这些阶段沿用参考画面的内容和顺序。修改一段时长只改变该段持续时间，其后阶段按新时间顺延。默认公司文案为“中鼎智能(无锡)科技股份有限公司”，可在面板修改。

## UV 点位不是经纬度

参考 HTML 的飞线锚点手工对齐到对应底图，采用 **0–1 范围的画面 UV**：左上为 `(0,0)`，X 向右增加，Y 向下增加。

- 全球默认起点为 `(0.709, 0.335)`，40 个目的地使用全球底图的 UV。
- 国内默认起点为 `(0.707, 0.520)`，34 个目的地使用中国底图的 UV。
- 两组点位独立，各最多 128 个；显式空列表会保留，不会重新填入预置地点。
- 地点名可编辑。UV 的零值有效；经纬度如 `120.30, 31.68` 不可直接填入 UV。
- 自定义地点先放在本组起点，请按照参考底图移动到希望显示的位置；没有绘制长度的重合点不会产生有意义的航线。
- “恢复全球参考点位”或“恢复国内参考点位”只恢复对应组的起点和列表，不修改品牌、时长和其它配置。

飞线起点只改变线路出发位置；中国、江苏、无锡和惠山的下钻镜头仍使用参考图固定锚点。

地图、点位和飞线均为视觉示意，不表示真实航班、实时物流链路或实际业务覆盖。业务模型也没有因此获得 GIS 定位。

## 最终进入场景

先在场景“相机”中调整并点击“保存当前视角”。参考动画结束或跳过后衔接已经就绪的业务场景，最终落点仍是这个保存视角，不取当前未保存的编辑镜头。

默认“停留最终视角”；选“继续已配置巡检”时，开场后继续已配置为自动启动的路线，没有路线时保持最终视角。播放期间由开场占用相机，避免巡检、漫游或目标跟随争抢镜头。

## 科技呼吸与减少动态

科技呼吸默认开启，强度 65%，周期 4 秒。强度支持 0–100%，周期支持 2–10 秒。关闭或强度为 0 时保留基本飞线运动，不叠加呼吸与扫光；关闭时原强度和周期继续保存。

动效偏好默认“完整播放”。“减少动态”避免完整的地理运动与附加呼吸、扫光，同时保留进入业务场景的流程；“跟随系统”按系统的减少动态偏好决定。呼吸配置不会改动时长、UV 点位或公司文案。

## 保存、迁移与兼容

实际参考配置保存在 `sceneSettings.openingAnimation.reference`，包含 `version`、九段 `stageDurations`、品牌与公司文案、画质、界面显示、两组 UV 起点和列表。顶层总开关、跳过、动效偏好、呼吸参数和结束行为继续有效。

旧的 `globe-huishan` 配置会归一化到新模板，并保留顶层旧时长和经纬度字段作为历史档案，面板不再把这些历史字段作为参考模板的可编辑入口：

1. 旧基础时长按参考模板除国内业务外的 54 秒比例分配到其它八段，旧中国停留作为第六段时长，保持原合计时长。明确保存的 0 秒继续有效。
2. 旧地点按已知名字或明确别名匹配参考 UV，例如四川对应成都、安徽对应合肥。不会将旧经纬度数值假装成 UV。
3. 无法匹配的旧地点保留在历史档案，并在面板显示迁移提示；用户可手动添加新的参考地点并设置 UV。“清除迁移提示”只清除提示，不删除旧档案。
4. 旧的关闭、零呼吸强度和空列表继续保留。没有开场配置的旧场景仍默认关闭，新建参考配置使用完整 40/34 点位和 62 秒节奏。

配置支持撤销重做、场景保存重开、SOURCE 可编辑工程包和 DIST 发布包。SOURCE 多场景分别保留配置。修改后需要重新发布，旧 DIST 不会自动更新参考版代码和资源。

嵌入数据中台时等待宿主确认三维 iframe 已经实际展示。新版宿主会明确报告“支持开场，但暂时不可见”，此时等待显示事件，不会因为后台打开或容器隐藏超过 2.5 秒而永久跳过。播放期间页面或 iframe 隐藏会暂停；两者都恢复可见后继续同一次播放。每次新打开或刷新 Viewer 播放一次，全屏、尺寸变化及普通组件更新不重播。

旧宿主缺少开场可见确认时仍默认等待 2.5 秒后跳过，避免阻塞既有数字孪生握手，并在控制台输出 `[Viewer opening]` 原因。独立 Viewer 无需宿主确认。新宿主继续发送旧确认消息以兼容旧 Viewer；新旧版本混用无法获得完整的隐藏等待与暂停行为，建议同步更新。

## 发布版本与模板检查

开场配置随场景发布，播放器与参考素材则来自编辑器内置的 Viewer 模板。开发环境使用 `dist-viewer-template`，安装版使用应用资源目录中的 `export-viewer`。发布会复制所选模板，不会在点击发布时重新构建。因此仅修改源码、重建开发模板或刷新旧发布页面，不能更新旧安装版或已经发布的 DIST。

`npm run build:viewer` 会在最终文件落盘后生成 `viewer-capabilities.json`，记录参考开场能力以及入口 HTML、全部构建脚本块、样式和 10 张参考 WebP 的完整性信息。场景启用开场时，发布前检查清单、素材和运行代码是否来自同一批构建；缺失或混用旧文件时明确阻止发布并提示更新编辑器或重新构建。复制阶段继续校验，避免检查后文件变化。未启用开场的旧场景仍可使用旧模板。

交付顺序为：构建 Viewer 与编辑器 → 更新实际使用的编辑器版本 → 重新发布数字孪生。使用内嵌大屏时，还需部署包含新版可见性握手的中台前端。已打开的旧发布版本继续使用其原有代码和资源，不会被本地构建自动替换。

## 开发验证

模型、迁移、Store 与序列化：

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/editor/sceneOpeningAnimation.test.ts tests/editor/sceneOpeningReference.test.ts tests/editor/sceneOpeningAnimation.integration.test.mjs
```

发布模板、开场状态与可见性回归：

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/digitalTwin/viewerTemplateCapabilities.test.ts tests/digitalTwin/geographicOpeningBridge.test.ts tests/runtime/openingPlaybackCoordinator.test.ts tests/runtime/openingPlaybackVisibility.test.mjs tests/digitalTwin/playerAutoPatrolStartup.test.ts
node --experimental-strip-types --test tests/digitalTwin/viewerCapabilitiesBuild.test.mjs
```

实际包回归应先准备本次代码的 Viewer 与 Electron 构建产物：

```powershell
npm run build:viewer
npm run build:electron
npx electron tests/digitalTwin/geographicOpeningPackages.integration.mjs
```

包结果位于 `output/geographic-opening/packages-result.json`，其中包含启用、关闭及允许跳过三份 DIST 解包目录，以及五个 SOURCE 场景的配置回读结果。启动项目开发服务器后，可运行 `node scripts/smoke-geographic-opening-editor.mjs` 检查真实配置操作、保存重开、预览、暂停、跳过和相机恢复；脚本默认使用端口 5198，可通过 `OPENING_EDITOR_BASE_URL` 指定地址。

运行 `node scripts/smoke-published-opening.mjs` 可使用实际 DIST 验收真实中台 Preview/Published React 页面、BabylonRuntimeWidget 与桥接链路，覆盖中间画面、自然结束、跳过、禁止跳过、刷新、隐藏后显示、播放中暂停恢复及 iframe 实例保持。后端 API 使用本地夹具；CSS 隐藏为浏览器实际操作，后台页面状态使用明确标注的 visibility API 夹具，因此不代表已部署业务页面或真实操作系统后台标签页验收。

Node 与 ZIP 检查不替代实际图形验收。最终应检查地球展开、两组飞线、区域推进、参考界面、减少动态、暂停和退出清理，以及最终业务相机衔接。默认 UV 原文数据位于 `src/editor/model/sceneOpeningReferenceData.ts`，来源是本次用户提供的参考 HTML。

离线示意、逐帧对照、呼吸与生命周期验证入口：

```powershell
node scripts/build-geographic-opening-demo.mjs
node scripts/smoke-geographic-opening.mjs
node scripts/smoke-geographic-opening-breathing.mjs
node scripts/smoke-reference-opening-lifecycle.mjs
node scripts/smoke-geographic-opening-host.mjs
```

逐帧对照需要本次参考截图 `output/opening-reference/reference-04s.png` 等九张文件；这些由用户 HTML 在相同浏览器与 1600×900 视口采集。生命周期验证额外覆盖全屏交接、禁止跳过、防止跳过中途暂停卡住、独立开场 WebGL 丢失后的软件回退、自然完成和素材加载失败。浏览器验收使用本地示例项目与宿主 fixture，不等同于已部署业务项目的现场验收。
