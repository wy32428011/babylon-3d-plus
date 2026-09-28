# 参考开场视觉来源与接入

此目录复用用户提供的 `zd_digital_twin_opening.html`。十张 WebP 来自该文件已经抽取的原始素材，没有重新生成或手绘替代原图。

原始 62 秒叙事为：旋转地球 0–9、地球展开 9–16、全球业务 16–24、中国全景 24–30、江苏高亮 30–34、国内业务 34–42、江苏全景 42–48、无锡全景 48–54、抵达惠山 54–62。实际时长由上层时间轴映射到此参考轴。

## 模块

- `referenceShaders.ts`：原球面到平面的 WebGL 顶点/片元 shader 与网格。
- `referenceWebGL.ts`：原生 WebGL 绘制的严格 TypeScript 适配，补充初始化失败和销毁时的资源释放。
- `referenceSoftware.js`：原软件球面采样与纹理三角形展开，旁边的 `.d.ts` 明确输入输出合同。
- `referencePainter.js`：原 Canvas2D 背景、图层、动态飞线及推进过渡，旁边的 `.d.ts` 明确输入输出合同。
- `referenceOpening.css` / `referenceMarkup.ts`：原界面样式和结构。移除 `html/body` 全局规则、参考图调试入口、引擎标签、临时速度/画质选择器。
- `index.ts`：外部时钟控制器。只有素材加载、确定性绘制、resize 和用户操作回调，没有自有 RAF、播放计时器或自然完成回调。

## 接入合同

```ts
createReferenceOpening(container, {
  settings,
  onSkip,
  onSeek, // 实际秒
  onPauseToggle,
  onRestart,
});
```

返回 `ready: Promise<void>`、`element`、`renderAt(referenceSeconds, { elapsedSeconds, totalDurationSeconds, isPaused, opacity?, stageIndex? })`、`resize()`、`getState()`、`dispose()`。宿主拥有唯一时钟、可见性暂停、完成判断及业务场景接管。

品牌、公司、开场和结尾文案通过 `textContent` 或文本节点写入。它们只改变原 HTML 的界面文字层；素材像素中已烘焙的公司名称、地点、图例等仍保持用户原图。

世界和国内线路使用原图 UV 锚点，属于视觉示意，不是经纬度或实时 GIS。配置起点只影响线路；中国、江苏的镜头焦点和区域高亮仍固定为原参考图位置，保证叙事路径不会随线路起点变化。

禁止跳过时，跳过/进入按钮隐藏，章节与进度控件禁用，方向键不触发快进。直接 `renderAt` 保留测试和宿主控制能力。

呼吸配置作用于原星闪、波纹、锁框和末段颗粒的时间与幅度；默认强度 0.65、周期参数 4 保留原参考节奏。关闭或零强度会使这些效果静止，基础飞行线仍按参考时间推进。

## 素材与离线打包

资产使用 `?url` 导入，生产构建可正常生成静态资源。独立离线 HTML 的构建工具应在最终输出阶段内联这些 URL，避免把大段 Base64 放进 TypeScript 源码。

WebGL 不可用或上下文丢失时优先切换原软件 3D；软件绘制也不可用时保留原图片过渡兼容路径。该兼容路径与真实业务场景模型的验收分开记录。
