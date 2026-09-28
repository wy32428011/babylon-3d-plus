# 可导入开场动画包

开场包保存可复用的素材、分镜和默认参数；每个场景保存固定版本与自己的完整参数副本。修改某个场景不会改写包默认值，也不会影响使用同一包的其他场景。

## 使用流程

1. 在场景属性的“开场动画”中导入 `.dtopening` / ZIP 包。导入只进入当前工程资源库，不替换当前场景。
2. 选择包并应用到当前场景。设置“进入场景时播放”，编辑文案、素材、分镜与飞线。
3. 飞线采用底图 UV 坐标，左上角为 `(0,0)`，右下角为 `(1,1)`。通过画面拾点、拖动端点或数值输入调整；换图后需要重新检查点位。
4. 预览开场，检查中间画面和最终场景交接，再保存场景。开场预览不覆盖保存的业务相机。
5. 发布会携带固定包和场景参数。既有发布版不随本地修改更新，需要重新发布。

旧的内置参考开场继续可用。缺失或不兼容的包保留原配置并报告错误，不会静默变成另一个开场。包版本升级需要明确应用；同一 ID/版本但内容不同的包不能直接覆盖已导入版本。

## 格式与边界

`.dtopening` 是 ZIP 容器，以下文件放在根目录：

```text
manifest.json
config.schema.json
ui.schema.json
defaults.json
timeline.json
assets/
```

`manifest.json` 声明 `formatVersion: 1`、`runtimeApiVersion: 1`、`id`、`version`、`name`、`renderer`、`assets` 和可选 `previewAssetId`。版本使用三段格式，例如 `1.0.0`。每个素材声明稳定 `id`、相对 `path`、`type`、字节 `size` 和 `sha256`。封面也通过素材清单引用。

支持的渲染器：

- `reference-huishan`：保留原地球展开和九阶段参考效果，使用包内 `asset-1` 至 `asset-10`。阶段顺序固定；全球和国内业务停留可以为零，其余阶段至少 0.1 秒。参考底图中原有的烘焙文字仍属于图片像素，替换品牌时应提供干净底图。
- `timeline`：按阶段列表组合图片、文字、Logo、UV 飞线、缩放平移和淡入淡出。支持不同阶段数量、顺序和时长；阶段时长为零表示略过该阶段。

包只声明数据，不运行外部 JavaScript、HTML、CSS 或任意自定义 Shader。全新绘制算法需要新增受支持的渲染器和相应播放器版本。不得将支持声明式包描述为可运行任意网页插件。

## 配置定义

`config.schema.json` 是明确受限的 JSON Schema 子集：顶层 `type: "object"`，在 `properties` 中声明 `string`、`number` 或 `boolean`。字段支持 `title`、`description`、`enum`、`minimum`、`maximum`、`maxLength` 和 `format`。字符串控件格式为 `color`、`asset`、`multiline`。不支持 `$ref`、脚本表达式或任意嵌套表单；不支持的校验关键字会被拒绝，不能假装已经校验。

`defaults.json` 必须给每个声明字段提供默认值，场景配置同样保存完整字段；首版不提供省略可选字段的语义。`ui.schema.json` 用 `groups: [{ title, fields }]` 组织参数。默认值只在首次应用或主动恢复时物化，保存的空文字、零值和关闭项不会被默认值覆盖。

`timeline.json` 使用 `{ stages: [...], handoffSeconds }`。每个阶段有稳定 `id`、`label`、`durationSeconds`，可配置：

- `title` / `subtitle` / `description`，或对应的 `titleKey` / `subtitleKey` / `descriptionKey` 绑定文案参数。
- `backgroundAssetId` / `logoAssetId`，或 `backgroundKey` / `logoKey` 绑定素材参数。素材参数的值是包内素材 ID，不是外部网址。
- `textStyle` / `subtitleStyle`：颜色、字号、UV 位置、对齐和包内字体。
- `zoomFrom` / `zoomTo` / `panX` / `panY` / `transitionSeconds`。
- `routeStyle` 作为该组飞线默认样式；`routes` 中每条线路声明 `id`、`name`、`from`、`to`，并可覆盖 `color`、`width`、`speed`、`curvature`、`trail`、`pulse`。

场景的 `openingAnimation.package` 保存包身份、`contentHash`、`manifestUrl`、定义快照和 `config`。`config.values` 保存普通参数，`config.stages` 保存完整分镜，`config.assetOverrides` 保存当前场景独立替换的素材。替换不改写共享包。

桌面面板支持导入图片替换现有图片槽位。字体由包作者放入包内并在文字样式中引用，首版不提供场景级字体导入按钮。参考渲染器保持其固定文字布局；通用渲染器支持位置、字号和镜头变换等完整分镜样式。

## 保存、发布与兼容

工程内包存放在 `Assets/OpeningPackages/`，替换素材存放在 `Assets/OpeningAssets/`。资源身份按版本和内容指纹固定；移动工程时重新定位工程内固定资源，不能隐式改成资源库里的“最新包”。

SOURCE 保留可编辑定义、各场景参数及其资源依赖；DIST 将使用的素材复制到发布目录，改写为包内路径，并纳入发布版本缓存。发布前检查当前 Viewer 支持包协议与渲染器，同时校验代码和素材完整性。旧安装版或旧 Viewer 模板需要更新后重新发布。

运行时沿用场景首帧与宿主可见门槛。开场占用镜头控制，业务场景保持运行；结束、跳过、失败或切场景时释放临时画面、事件监听和对象 URL。素材读取经过统一缓存入口，缓存失败回退普通加载，不应阻断业务场景。

导入与发布会校验路径、重复条目、大小、完整性和支持的素材类型。SVG 仅接受受限静态素材。协议设置素材、阶段和飞线数量预算，避免导入无界资源或构建无界绘制任务。

运行时还限制图片解码预算：单张不超过 3200 万像素，每次播放累计不超过 6400 万像素，图片读取/准备最多 4 路并发。超限会释放本次开场资源并回到业务场景；该限制按实际解码尺寸检查，不以压缩文件大小代替内存预算。

项目内包可以沿用当前中台工程上传、SOURCE/DIST 和归档链路；跨项目在线插件库、权限管理与可执行插件不属于这一版本。

## 验证范围

生成两份可导入示例包（输出到 `output/opening-packages/`）：

```powershell
node --experimental-strip-types scripts/build-opening-packages.mjs
```

- `reference-huishan-1.0.0.opening.zip`：九阶段地球与地理参考开场。
- `campus-network-1.0.0.opening.zip`：三阶段品牌、园区飞线与业务场景交接，使用不含公司文字的矢量底图。

构建及本地真实包、浏览器回归入口：

```powershell
npm run build
npx electron tests/digitalTwin/openingPluginPackages.integration.mjs
node scripts/smoke-opening-package-editor.mjs
node scripts/smoke-opening-package-runtime.mjs
```

运行实际包测试前先生成上述示例包。编辑器浏览器夹具使用真实 Store、SceneViewPanel 与开场播放器；原生文件对话框与中台运行配置接口使用本地夹具。主进程包测试单独验证真实导入、导出、资源复制和完整性校验。

重点覆盖两种包与多场景配置隔离、保存重开和撤销、工程迁移、真实 SOURCE/DIST、版本冲突、损坏素材、编辑器与发布 Viewer 的实际中间画面、暂停/跳过/切场景后的相机与资源清理。

本地夹具、构建和浏览器验证不等同于现场业务工程、中台线上部署或安装版验收。
