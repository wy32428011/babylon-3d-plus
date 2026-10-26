# 渲染优化 Q0：S1 混合阴影静态签名

日期：2026-10-24。范围：方案 S1；不改阴影质量、默认值、光照强度或业务动画。代码未提交、未推送、未发布。

## 验收清单

- [x] 默认路径使用结构化数值快照，稳定帧不创建材质/矩阵签名数组或字符串。
- [x] 世界矩阵与 alpha UV 矩阵均以 `Float64Array(16)` 保存，保持 JS number 精度。
- [x] 保留 `computeWorldMatrix(geometryChanged || !mesh.isSynchronized())`，覆盖同一 renderId 的本地/父级变换与几何更新。
- [x] 使用 `updateFlag` 区分稳定快路与更新路径；稳定快路仍核对全部分量，防止直接写 `matrix.m` 漏失效。
- [x] 保留材质 alpha/culling/transparency/alpha-cutoff、有效子材质、subMesh 拓扑、贴图就绪、UV、DynamicTexture 逐帧语义。
- [x] 以旧字段及原 `join` 顺序提供内部 A/B 回退；逐帧核对变化与稳定命中。
- [x] 聚焦单测、覆盖率、交错微基准、真实 Chrome/WebGL2 像素 smoke 通过。
- [x] 按 code-reviewer 检查相关 diff；无 CRITICAL/HIGH 问题。
- [x] 主任务已登记测试入口，最终 build/typecheck 与 test:optimization-p2 通过；详见总实施记录。

## 实施与回退

- `HybridShadowCache.ts` 保留原集合分类、几何回调监听、多灯共用 revision 和帧内刷新逻辑；几何签名改为 id/version 数值缓存。
- `hybridShadowSignatures.ts` 分别保存网格廉价状态、世界矩阵、各 subMesh 的材质/alpha 状态；只在变化时写入快照。`NaN`、`-0`、null/undefined 处理保持旧 `Array.join` 的相等语义。
- 仍仅在 alpha test/blend 实际采样时读取 alpha 贴图。opaque `DynamicTexture` 仅改变表面颜色，不触发静态深度每帧重绘；真实动态 alpha 继续按 frameId 失效。
- 内部诊断调用 `HybridShadowMeshState.setSignatureMode('legacy')` 可恢复旧字符串比较，`setSignatureMode('numeric')` 恢复默认数值路径。切换后首帧重新建立快照；此入口没有新增用户设置或改变场景文件。

## 验证

1. RED：新回归在原实现上失败，原因为 `state.setSignatureMode is not a function`。
2. 原 `tests/runtime/hybridShadows.test.ts`：9/9 通过。新 `hybridShadowSignatures.test.ts`：3 项回归通过；微基准默认显式跳过，设置 `HYBRID_SHADOW_BENCHMARK=1` 后 4/4 通过。
3. 新 helper 覆盖率：行 98.72%、分支 96.40%、函数 100%；命令：`node --experimental-transform-types --test --experimental-test-coverage --test-coverage-include=src/runtime/babylon/hybridShadowSignatures.ts tests/runtime/hybridShadowSignatures.test.ts`。本次覆盖率命令同时设置了微基准环境变量，其计时仅用于执行验证，不作为收益数据。
4. `node scripts/smoke-hybrid-shadows.mjs`：默认 PBR/Standard × 方向光 balanced/quality、点光、聚光共 8 组合通过，56 次缓存/完整实时阴影画面对照全部 `differentPixels=0`；稳定帧静态重绘增量均 0、缓存命中持续增加、无浏览器/WebGL 错误。
5. 同 smoke 补跑 PBR quality 的 `alpha-dynamic` 和 `opaque-dynamic`。alpha 9 次、opaque 7 次画面对照均 0 差异；稳定区间 alpha 静态重绘 +15/命中 +0，opaque 重绘 +0/命中 +15，保留原语义。
6. 真机图形环境：Intel UHD Graphics 630 / ANGLE D3D11 / WebGL2；已打开默认初始 PNG，画面正常受光与阴影可见。脚本结束会关闭所启动浏览器和临时 HTTP 服务。
7. `git diff --check -- src/runtime/babylon/HybridShadowCache.ts` 通过。

像素及指标位于 `output/playwright/hybrid-shadows/`。默认八组结果是 `pbr-{directional-balanced,directional-quality,point-balanced,spot-balanced}.json` 与对应 `standard-*`；补充结果为 `pbr-directional-quality-{alpha-dynamic,opaque-dynamic}.json`。该目录含历史结果，不能把其他文件计为本次验证。

## 微基准结果与限制

命令（PowerShell）：`$env:HYBRID_SHADOW_BENCHMARK='1'; node --experimental-transform-types --test tests/runtime/hybridShadowSignatures.test.ts`。

- 2,000 个静态盒体；同一 `HybridShadowMeshState` 交错切换 legacy/numeric；每样本预热 12 帧、测量 90 帧，共 7 轮。
- 旧字符串模式 refresh 中位数 **11.3400 ms/帧**，数值模式 **7.2107 ms/帧**，减少 **4.1293 ms/帧 / 36.41%**。
- 两种模式所有测量帧均保持 revision 稳定。原始样本保存于 `output/render-optimization/s1-static-signatures-benchmark.json`。
- 此结果仅衡量 NullEngine 下静态状态 refresh 的 CPU 时间；不等于工厂/展会场景 FPS、GPU 帧时间、显存或 GC 时间改善。没有计量总分配字节或真实业务场景性能。
- 数值快照有每网格/子网格的常驻小对象和 16 项矩阵缓存，交换掉原每帧字符串与临时数组；未宣称内存总占用下降。
- 主任务并行验证会影响绝对时间，因此保留交错样本，不用单次耗时作收益判断。
