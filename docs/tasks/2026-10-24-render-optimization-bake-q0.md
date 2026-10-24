# Q0 烘焙 B1 / B2-探针执行记录

范围：仅 `B1` 的像素合并、RGBM 编码及探针读取向量化，和 `B2` 的 1024² 探针批次。保持光照算法、面法线顺序、瓦片 6×6 布局与中心 2×2 采样点。源脚本同步机制为 `scripts/build-typescript.mjs` 在 Electron 构建后复制 Python 至 `dist-electron/lighting-bake/`。

验收清单：

- [x] B1 独立验证：合并 float32 完全一致，旧/新 RGBM 8 位分量差不超过 1 LSB，并记录分量统计与分段时耗。
- [x] B2 独立验证：1024²、可配置容量常量、4096 探针只需 2 次 bake，保留瓦片采样和 Babylon 六方向顺序；与旧批次逐值比较。
- [x] 组合真实 Blender 对照：固定 seed；RGBM 图集字节差不超过 1 LSB；探针最大绝对误差不超过 0.03 且归一化 RMS 不超过 2%（Cycles 图像布局可改变采样噪声）。
- [x] 源码与实际交付脚本 SHA256 相同，并通过交付脚本真实烘焙对照。
- [x] 根代理最终完整 build 后直接执行既有 cycles.integration.mjs（复用已完成构建前置），实际交付脚本、UV、探针及取消/超时验收通过；相关全局检查见总实施记录。
- [ ] B2 风险段的 GPU 显存自适应及缩小批次重试尚未实现；保留现有服务整任务 CPU 回退，见下方限制。不能据此宣称 B2 风险段完整验收。

基准脚本已在任何修改前保存在 `output/render-optimization-bake-q0/baseline_cycles_bake.py`。纯像素对照使用固定 RNG 20261024，标量参考保持原 double 算术后回写 float32 的顺序。真实烘焙对照采用独立 factory-startup 进程、CPU、固定 seed 与同场景采样设置，避免未固定统计阈值后再调整标准。

实现：

- `merge_irradiance_pixels` 使用 float32 ndarray 原地合并并通过 `fmax` 裁剪 RGB，alpha 固定 1；`foreach_get` / `foreach_set` 直接读写连续 float32 缓冲。`fmax` 保留原 `max(0, value)` 的 NaN 归零语义，正无穷仍保留并在 RGBM 阶段按旧逻辑失败。
- `encode_rgbm_pixels` 使用向量化 max/ceil/divide。输入和输出仍为 float32；乘数中间量使用 float64，保留原 Python double 在 ceil 边界的行为，避免整级跳变。
- `sample_probe_irradiance` 按原 dx→dy 顺序提取每面中心 2×2，float64 求均值，导出时 `.tolist()` 恢复 JSON 原生数值。
- `PROBE_IMAGE_SIZE=1024`、`PROBE_BATCH_SIZE=4816`；有效容量还会限制在当前图像能容纳的完整六面探针数。可仅下调批次；若要恢复完整旧布局，同时改为 128 和 64。
- 两个既有真实 Blender 夹具将 ndarray 样本显式转为 Python float，保持原 JSON 报告、数值与断言。

验证与可复核证据：

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| RED→GREEN | B1 缺少新 helper 时失败；B2 缺少容量常量时失败；实现后通过 | `b2-red.log`；B1 首次终端记录 |
| 独立 B1，系统 Python / NumPy 2.5.2 | 零值、HDR、ceil 边界共 4,176 分量差 0；另 1024² 随机图 4,194,304 float 分量完全一致；128/1024 图中 0/64/4096/4816 探针样本与旧均值完全一致 | `b1-pixel-report.json` |
| 独立 B1，Blender 5.2.2 LTS / NumPy 2.3.4 | 1024² 像素处理合并 2051.611→39.332 ms；RGBM 3566.839→102.530 ms；合计 5618.450→141.862 ms | `blender-pixel-report.json` |
| 独立 B1，真实七表面图集 / CPU | 图集 4,194,304 个 PNG 分量差 0；bake+合并 4520.275→3006.822 ms；RGBM+写盘 2115.232→142.452 ms；65 探针 1170 值差 0 | `b1-real/report.json` |
| B2 独立 / CPU / 4096 探针 | 128→2 次 bake；12324.510→10829.986 ms（12.1%）；第二轮 15583.072→12222.386 ms（21.6%） | `combined-real/report.json`、`delivered-real/report.json` 的 `b2Only` |
| B1+B2 组合 / CPU / 4096 探针 | 首轮 12324.510→8584.948 ms（30.3%）；交付轮 15583.072→8350.202 ms（46.4%） | 同上 `probes` |
| 探针逐值差异（两轮相同） | 73,728 分量，62,664 有差异；maxAbs 0.0200002715；RMS 0.000476506；归一化 RMS 0.119149%，通过预定标准 | 同上 `comparison` |
| 实际交付图集 | 1024²、range=3；PNG 4,194,304 分量逐字节差 0，文件 SHA256 也完全一致；bake+合并 4660.398→4067.506 ms；RGBM+写盘 2211.589→164.490 ms | `delivered-real/report.json`、`sha256.json` |
| 实际 Blender 网格合同 | 4096 探针单批；完整 UV、六方向法线、2×2 样本；配置小批次与旧 128² 布局、0/1 探针；对象/网格/材质无残留 | `delivered-contract/report.json` |
| 已有合同与语法 | `node --test tests/lightingBake/lightingBakePythonContracts.test.mjs` 4/4；修改 Python 的 `py_compile` 通过；`git diff --check` 通过 | 终端记录 |

上述相对证据文件均位于 `output/render-optimization-bake-q0/`。最初相对 PNG 被 Blender 解析至 `C:/output/render-optimization-bake-q0/`，读取对照有效；已将这 4 张原文件复制至任务输出并在报告记录 `artifactRelocatedFrom`。夹具现先解析绝对输出目录；交付轮所有产物实际位于项目输出目录。该问题仅影响测试夹具；正式 `main` 由输入文件绝对路径确定输出。

环境：Windows、`C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`，Blender `5.2.2 LTS`（d13f752e3b9c）、NumPy `2.3.4`；CPU，seed `20261024`，动画 seed 与去噪关闭，max_bounces=8 / diffuse_bounces=4；图集 16 samples，探针 128 samples。两轮按旧→B2单项→组合顺序独立重建场景；耗时为本机连续单次测量，不是 ABBA 性能结论。纯数组计时与真实 bake 时耗的范围不同，不能相加或推广为整工程收益。

复现命令：

```powershell
$engine = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_pixel_processing_checks.py -- --bake-script dist-electron/lighting-bake/cycles_bake.py --benchmark-size 1024 --output output/render-optimization-bake-q0/delivered-pixel-report.json
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_probe_batch_checks.py -- --bake-script dist-electron/lighting-bake/cycles_bake.py --output output/render-optimization-bake-q0/delivered-contract
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_q0_bake_checks.py -- --baseline-script output/render-optimization-bake-q0/baseline_cycles_bake.py --bake-script dist-electron/lighting-bake/cycles_bake.py --stage combined --probe-count 4096 --output output/render-optimization-bake-q0/delivered-real
```

SHA256（完整产物清单在 `sha256.json`）：

- 当前源码/交付：`c88604c0d3290a535cefaa3b971a81c6e4512f86fed03d185c283dd198876c20`。
- 4096 探针对照当时的源码/交付：`9eb00eea91213cf993366058f5e51adba0a30923c728ccebf18004922af7f12d`，相应报告增加 `candidateSha256AtRun` 记录。
- 既有七表面输入：`87946b3eaefe9629898dd9cd23ccc6ae7d95a87470dbf02b84cbc12e894768ff`。
- 修改前旧脚本：`fbfb65096f7fa1d08ca228a60bd29229044e334e8eefb4d9de6f5e77d643911d`。
- 交付轮旧/新 PNG：`1d8036155a0ea7d4a86dd44d42a6aec78c989b62c524d822c32a8c173ba5d4d7`。

独立审查后的 NaN / Inf 回归修复：

- 原向量化 `maximum` 会传播 NaN，而旧 `max(0, nan)` 返回 0；专项测试先复现 RED，再改用 `fmax`。覆盖 NaN、负无穷、正负无穷相消和非有限 alpha，合并及编码与旧标量完全一致；另外三个 RGB 通道分别验证正无穷仍使旧/新编码抛出 `OverflowError`，没有泛化忽略无穷值。
- 最终交付脚本在 Blender 内置 NumPy 2.3.4 下重跑：有限 1024² 随机图 4,194,304 分量完全一致，新增非有限案例 8 分量也完全一致；像素处理标量 5567.778 ms、向量化 108.828 ms。证据为 `nonfinite-delivered-pixel-report.json`。
- 用最终交付脚本与旧脚本重新烘焙七表面小场景，1024² PNG 的 4,194,304 分量差 0；bake+合并 4350.583→3205.619 ms，RGBM+写盘 2133.393→128.140 ms。证据为 `nonfinite-delivered-atlas/report.json`，SHA 与交付副本已重新核对。
- 有限像素路径仅将 `maximum` 换为有限值等价的 `fmax`；未重复 4096 大性能测试，保留此前有限路径的完整逐项证据，并明确其源码版本。最终 Python 语法和限定 diff 检查通过。

限制与未完成项：

- 保留 `cycles_bake.py:bake_diffuse` 的 `LIGHTING_BAKE_GPU_FALLBACK` 标记及 `electron/ipc/lightingBakeService.ts:394-403` 捕获 `LightingBakeGpuFallbackError` 后将输入设为 CPU、重启独立任务的机制。未改变产品默认 CPU；未实测 GPU，未实现显存预算自适应或同任务自动缩批重试。1024² 单张 float 缓冲约16 MiB，两遍输入缓冲约32 MiB，另有图像与 Cycles 内存；调低 batch 不会减小图像缓冲。
- 4096 探针真实对照放在既有场景外，隔离采样布局与调用开销；不是复杂遮挡/工厂探针覆盖和视觉验收。B2 不要求浮点逐位相同，所用预定阈值见清单；不宣称所有场景或少量探针都加速。
- `ruff` 未安装，没有运行；未安装新依赖。已按 python-reviewer / code-reviewer 清单检查修改，未发现 CRITICAL/HIGH 项；修复了旧夹具的 ndarray JSON 兼容问题。
- 根代理需在既有 Cycles 集成入口登记 `cycles_pixel_processing_checks.py` 与 `cycles_probe_batch_checks.py`，并执行统一构建/回归；完整 A/B 夹具依赖修改前基准副本，保留为手工复核入口。
- 本子任务未提交、推送、发布、打包安装器或触碰用户工程资源；没有启动常驻服务。
