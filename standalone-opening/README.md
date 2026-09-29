# 中鼎数字孪生开场动画 · 独立网页插件

版本：1.0.0。

这是可直接嵌入普通网页、门户或大屏的原生浏览器组件。它保留现有“旋转地球 → 地球展开 → 全球业务 → 中国全景 → 江苏高亮 → 国内业务 → 江苏 → 无锡 → 惠山”九阶段画面，默认 62 秒。不需要 React、Electron、Babylon、后端接口或在线地图服务。

## 先看效果

解压整个目录后，双击 `demo.html`。普通 script 版本内置十张图片，不需要启动服务。`iframe-demo.html` 展示 iframe 接入及宿主显隐控制。

ES Module 版本应通过 HTTP/HTTPS 或前端构建工具加载；不要用 `file://` 直接导入 ES Module。离线双击演示使用 IIFE 版本。

目录内容：

```text
demo.html                   可双击的离线演示
iframe-demo.html            iframe 接入演示
dist/zending-opening.js     script / IIFE，全局对象 ZendingOpening
dist/zending-opening.mjs    ES Module
dist/zending-opening.css    两种接入共用的样式
dist/index.d.ts             TypeScript 入口声明
dist/types.d.ts             独立公开类型
config.default.json         完整默认参数，可复制修改
source/                     可重新构建的源码及原始 WebP 素材
integrity.json              文件大小与 SHA-256
NOTICE.md                   素材来源与使用边界
```

## 普通网页接入

保留有明确宽高的专用空容器，先加载 CSS，再创建播放器：

```html
<link rel="stylesheet" href="./dist/zending-opening.css">
<div id="opening" style="width:100%;height:100vh"></div>
<main id="business" hidden>这里显示你的业务页面或三维场景</main>
<script src="./dist/zending-opening.js"></script>
<script>
  const openingElement = document.getElementById('opening');
  const businessElement = document.getElementById('business');
  function enterBusiness() {
    openingElement.hidden = true;
    businessElement.hidden = false;
  }
  const opening = ZendingOpening.createOpening(openingElement, {
    settings: {
      allowSkip: true,
      reference: { brandName: '你的品牌', heroTitle: '从全球\n抵达智能现场' }
    },
    onComplete({ reason }) {
      console.info('开场结束：', reason); // completed 或 skipped
      enterBusiness();
    },
    onError(error) {
      console.error('开场失败：', error);
      enterBusiness();
    }
  });
  // 页面或组件卸载时调用：opening.destroy();
</script>
```

完成或跳过会移除插件自己的画面、监听和计时器。业务 DOM、业务相机、数据连接以及是否展示业务页面由宿主控制。插件不会自行寻找或修改业务模型。

容器必须属于当前 document、为空且初始宽高大于零。它可以是普通静态定位 div；插件使用自己的包装层，不改写容器原样式。若初始容器为 `display:none`，请先建立有效布局再创建，或等显示时创建；创建后可使用 `setHostVisible(false)` 保留首播等待。

## ES Module / 前端工程接入

```js
import { createOpening, defaultSettings } from './dist/zending-opening.mjs';
// 构建工具支持 CSS import 时使用此句；普通网页改用 <link>。
import './dist/zending-opening.css';

const settings = defaultSettings();
settings.reference.brandName = '企业品牌';
settings.reference.stageDurations = [3, 2, 3, 2, 1, 3, 2, 2, 3];

const player = createOpening(container, {
  autoplay: false,
  settings,
  onComplete: ({ reason }) => showBusinessScene(reason),
  onError: error => showLoadFailure(error),
});
await player.ready;
await businessSceneReady; // 可替换为业务场景首帧已经可见的 Promise
player.play();
```

在 React/Vue 等组件中，应在挂载之后创建，在卸载钩子中调用 `destroy()`。不要在 render 函数中重复创建。SSR 只导入模块可以，创建播放器需要浏览器 DOM。

## 参数

`createOpening(container, options)` 的配置只作用于本实例，不写入全局默认值。

| 字段 | 默认值 / 说明 |
| --- | --- |
| `autoplay` | `true`；素材准备好后自动开始 |
| `hostVisible` | `true`；宿主初始展示状态 |
| `settings.allowSkip` | `true`；同时约束跳过、进度拖动、章节跳转和 API 的 `skip/seek` |
| `settings.motionPreference` | `normal`；也支持 `reduced`、`system` |
| `settings.breathingEnabled` | `true` |
| `settings.breathingIntensity` | `0.65`，范围 0–1，零值有效 |
| `settings.breathingPeriodSeconds` | `4`，范围 2–10 秒 |
| `settings.reference.brandName` | 顶部品牌名称 |
| `settings.reference.companyName` | 公司文案 |
| `settings.reference.heroTitle/heroSubtitle/finaleTitle` | 开场标题、说明、抵达标题；纯文本，标题支持换行 |
| `settings.reference.stageDurations` | 九段时长，默认 `[9,7,8,6,4,8,6,6,8]`；全球、国内业务段可为零，其他段至少 0.1 秒 |
| `settings.reference.quality` | `high` 或 `low` |
| `settings.reference.showUI` | `true`；参考画面的信息与播放器界面 |
| `settings.reference.worldOrigin/chinaOrigin` | 对应底图的 UV 起点 `{x,y}` |
| `settings.reference.worldDestinations/chinaDestinations` | `[{name,x,y}]`；分别默认 40 / 34 个示意点，显式空列表保留 |
| `onProgress(state)` | 状态与进度回调，适合更新外围 UI；避免在回调内执行重计算 |
| `onComplete({reason})` | 每轮正常完成或跳过后一次；`reason` 为 `completed` / `skipped` |
| `onError(error)` | 素材、超时、绘制等错误通知；失败会清理插件资源 |

UV 是图片坐标：左上角 `(0,0)`，右下角 `(1,1)`。它不是经纬度。修改线路不会改变固定的中国、江苏、无锡、惠山镜头路径。

`reduced` 使用抵达画面与短交接，避免完整地理运动；`system` 读取系统减少动态偏好。图片像素中烘焙的公司名和地图注记不会随文案配置改变。

## 播放控制与生命周期

| API | 作用 |
| --- | --- |
| `ready` | 当前轮素材准备 Promise；加载失败或准备时被终止会拒绝；建议调用方处理 `catch` |
| `play()` / `resume()` | 开始或继续当前轮；终态不会隐式重新播放 |
| `pause()` | 用户主动暂停；浏览器重新可见不会覆盖此选择 |
| `skip()` | 允许跳过时结束并通知 `skipped` |
| `seek(seconds)` | 允许跳过时定位到实际秒数 |
| `restart()` | 从头创建新一轮并自动播放；新一轮有新的 `ready`，会再次产生一次完成回调 |
| `setHostVisible(boolean)` | 宿主显隐通知；隐藏时暂停，再显示时继续原进度 |
| `getState()` | 获取状态快照，不返回可修改的内部对象 |
| `destroy()` | 最终销毁，释放资源；不触发完成回调，销毁后不能重播 |

状态包括 `loading`、`ready`、`playing`、`paused`、`completed`、`skipped`、`failed`、`destroyed`，以及阶段、实际秒数、总秒数、进度、暂停和可见状态。完整类型以 `dist/types.d.ts` 为准。

页面切换到后台时自动暂停；宿主主动隐藏或把 iframe 遮住时，请同时调用 `setHostVisible(false)`。跨 iframe 的父容器透明度无法由子页面可靠自行判断；`iframe-demo.html` 展示同源宿主接入。跨域项目应通过校验来源、目标 iframe 和会话的消息通道传递状态，再由 iframe 内调用此 API。

创建后加载超时为 30 秒。WebGL 不可用时复用现有软件绘制回退。每次播放保留单张不超过 3200 万像素、累计不超过 6400 万像素的图片解码预算。

## 修改源码与重新构建

`source/src/standalone-opening/` 是独立 SDK；`source/src/runtime/opening/reference/` 是原画面与十张原始 WebP。其余目录保留配置、时间轴和必要类型依赖；路径中出现 `electron/shared` 仅用于共享纯 TypeScript 定义，运行包不加载 Electron。

进入 `source`，使用 Node.js 22.12 或以上和包内固定版本构建工具：

```sh
npm install
npm run typecheck
npm run build
```

产物写回上一级 `dist/`。这一步仅重新构建 JS/CSS/类型，不自动更新交付时的 `integrity.json`、ZIP 或默认配置快照。修改后再次分发时应重新生成相应校验信息。

本包封装当前内置参考画面，是浏览器 SDK；编辑器 `.dtopening` 声明式素材包属于另一种接入格式。源码和素材的来源说明见 `NOTICE.md` 与 `source/ASSET-SOURCE.md`。
