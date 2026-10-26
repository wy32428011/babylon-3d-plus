# Q0 / LD8 GI 资源有界并行加载

日期：2026-10-24。范围：原方案 LD8；不改变场景格式、GI 材质参数、资源 SHA 规则或可见几何切换事务。

## 验收清单

- [x] 默认最多 4 项任务同时执行完整的读取 → 长度 / SHA 校验 → PNG / JSON 校验 → 解码 / 上传链路。
- [x] 全部候选成功后才返回；Map 迭代仍按清单顺序。
- [x] 首个失败中止同批任务并停止派发；等待全部 worker 收束，统一释放后抛错。忽略 AbortSignal 的读取也必须等待。
- [x] 外部取消保留原 reason；失败保留 asset / surface 身份诊断；URL、Texture、Bitmap 在失败 / 取消时释放。
- [x] Bitmap 使用 flipY / premultiplyAlpha:none / colorSpaceConversion:none，Texture 上传关闭二次翻转；真实 WebGL 验证原 RGBM 字节及旧 invertY 等价。
- [x] 成功 Bitmap 保留到 Texture dispose，以支持 Babylon context restore；真实 WebGL 验证恢复后字节等价。
- [x] 内部串行 / image 兼容读取路径和可复现 A/B 命令。
- [ ] 工厂与展会真实业务图集端到端耗时验收：由总任务组合采样负责，本子任务的合成多图集证据不替代业务验收。

## 修改

- src/runtime/babylon/lightingRuntimeResources.ts：4 个 worker 的有界队列；内部 AbortController 统一失败；全部收束后才释放或返回；SHA 完成后再次检查取消。
- createImageBitmap 可用时默认使用 Bitmap；未提供该 API 的环境继续 image / Texture 原路径。第四参数支持 { concurrency: 1, textureDecoder: 'image' }，可完整复现旧串行路径；可分别切换 concurrency 和 textureDecoder。
- Bitmap 显式保留 RGB / alpha 原值，创建时 flipY，上传 invertY=false。已上传 Bitmap 随 Texture dispose 执行 close，不提前破坏 WebGL context restore 的 buffer。
- tests/runtime/lightingTextureFailure.test.ts：在原已登记入口内扩充为 13 项，覆盖读取忽略取消、SHA、同步 / 异步解码、URL 分配失败、外部取消、Bitmap 参数 / 生命周期 / 解码失败及对照开关。
- tests/runtime/lightingResources.webgl.mjs：随机端口 Vite + 独立 Chrome，验证真实 GPU RGBA 字节、上下翻转、context restore、Bitmap 释放，并输出三臂网络延迟对照。服务和浏览器在 finally 关闭。

## 验证与证据

1. 修改前先运行扩充后的定向测试：并发上限 / A/B / 等待并发读取三项失败（实际串行为 1）。实现后 13 / 13 通过。
2. 命令：node --experimental-transform-types --test --test-concurrency=1 tests/runtime/lightingTextureFailure.test.ts。
3. 覆盖率命令增加 --experimental-test-coverage --test-coverage-include=src/runtime/babylon/lightingRuntimeResources.ts；目标源码 line 100%、branch 88.61%、func 100%。
4. npx eslint src/runtime/babylon/lightingRuntimeResources.ts：通过。
5. node tests/runtime/lightingResources.webgl.mjs：通过。Chrome / ANGLE Intel(R) UHD Graphics 630 / D3D11，非软件渲染。源 PNG 四个像素的 alpha 为 17、63、127、239，各 RGB 非对称；旧 image、Bitmap、两路径 context restore 后的每个 RGBA 字节均等于独立源数据按上下行翻转的结果。
6. 最新运行创建 Bitmap 40 个，关闭 40 个，剩余 Scene Texture 0，pageerror 0。
7. 证据：output/playwright/lighting-resources-q0/result.json；截图 output/playwright/lighting-resources-q0/result.png。
8. code-reviewer 检查目标 diff：无 Critical / High 问题；保留资源身份、失败排空、唯一释放、context restore 与旧路径回退均已检查。

## 性能边界和最新三轮对照

同一合成场景：8 个 256×256 RGBA 图集 + geometry / probes，真实 HTTP、SHA、PNG 解码和 GPU 上传；每 HTTP 请求固定延迟 100 ms；两解码路径先预热。每轮按 serial-image → 4-image → 4-bitmap 交替，同版本同浏览器：

| 路径 | 三轮耗时 ms | 中位数 ms |
| --- | --- | --- |
| concurrency=1 / image（旧基线） | 1223.8 / 1227.7 / 1223.5 | 1223.8 |
| concurrency=4 / image（隔离队列收益） | 400.0 / 428.6 / 400.3 | 400.3 |
| concurrency=4 / bitmap（生产默认路径） | 425.7 / 412.8 / 429.2 | 425.7 |

默认组合相对旧基线中位耗时下降约 65.2%，约 2.87 倍。此证据表明受网络延迟约束的多图集链路并行收益；不代表本地缓存、工厂 / 展会真实资源、Viewer 线上发布或 FPS 收益，亦不单独声称 Bitmap 比 image 更快。

最初 HTTP 30 ms、未针对 256 图集预热的一轮抖动明显，未据此宣称收益；保留在工作说明中，采用预热与 100 ms 受控延迟第二轮解释队列效果。定向模拟读取 20 ms / 解码 5 ms 对照仅证明调度，不替代真实 GPU 证据。

## 入口与剩余事项

- lightingTextureFailure.test.ts 已存在于 npm run test:lighting-optimization，无新增单元入口需要登记。
- 新的硬件脚本建议登记 test:lighting-resources:webgl → node tests/runtime/lightingResources.webgl.mjs，并按仓库 test-groups 规则登记；package.json / 全局 manifest 由主代理统一修改，避免并发覆盖。
- 主代理负责组合测试、全量类型检查 / 构建、统一 task-log 与 Q0 阶段验收。未进行 Git 提交 / 推送、发布或安装包操作。
