# Q1 LD1：本地 KTX2 worker 与既有解码缓存

当前状态：本地实现、真实纹理/Worker/缓存/受控计时已通过；原指定发布缓存 smoke 已通过。最终组合 lint/受影响回归仍在收束，不代表全 Q1 完成。Q0 本地验收和用户允许暂缓独显测试继续有效；默认画质、脚本执行与 MQTT 合同不变。

## 结果与检查清单

- [x] 核对本机实际 Babylon/core/ktx2decoder 9.12。包为 ESM，不能把 index.js 当作经典 worker 的 importScripts 模块。
- [x] 修正全局预置模块的主线程配置分支：九个实际转码器静态 URL 显式设置为本地；原生分支会跳过 applyConfig。HTTP/file URL 回归先 RED 后 GREEN，独立审查通过。
- [x] 使用 Vite 生成的同源经典 worker，复用本机官方 workerFunction 协议；队列有界、初始化失败排空、十秒空闲释放、pagehide 释放；原始 buffer 不转移。
- [x] worker 执行器位于发布解码缓存内部；真实 PlayerApp 顺序为先安装缓存、后建 Engine，因此缓存安装入口必须先配置执行器。未知或自定义解码输入仍按原入口执行。
- [x] 原始输入、GPU 能力与私有选项事实在任何异步委托前固定；通过原初始化器提前登记实际实例，热入口没有新增 await。已拥有对象上的访问器、缺少 own data 的 caps、未知静态配置、实例执行器及 manager 覆写走原路径。
- [x] bridge 最终 27 项与 16 个单缺陷 RED 见证已独立核对；URL/pool/bridge 统一入口 36/36 GREEN，代码审查无未解决 P1/P2。
- [x] 按实际生产安装顺序，HTTP run-6 及耐久 parallel-1 真实采样/冷热缓存/启动失败恢复均通过。并发分支三张纹理确实创建三个本地 Worker，18 个 RGBA 对照零差；该分支不用于计时。
- [x] Electron file-3 本地解码/GPU/CSP 通过，webSecurity/sandbox/contextIsolation 均开启；CSP 保留依赖所需 unsafe-eval。完整 Viewer 的现有 runtime-config 校验拒绝 file URL，因此不是完整 file Viewer 验收。
- [x] 实际KTX2静默ABBA2、原Babylon/Draco/KTX发布缓存smoke组合6、build5/受影响lint/入口106项及36个解码回归均通过；ready较慢约2ms和完整file Viewer边界仍保留。

## 实现边界

主线程保留 Babylon `DefaultNumWorkers = 0`，使已有 `KTX2Decoder.prototype.decode` 发布缓存仍处于同一 realm；缓存未命中时，标准执行器才委托本地池。这样避免原生 worker 路线绕过 `publishedBabylonCache` 的解码缓存，也避免本机 9.12 原生 WorkerPool 在初始化 reject 后未收束任务的问题。池大小为 `min(4, max(1, floor(hardwareConcurrency / 2)))`，未知硬件并发使用保守值。

worker 初始化/传输基础设施故障记录原因并回到已配置本地 URL 的主线程执行器。文件解析或转码错误原样拒绝，不能把所有失败都重试成成功。自定义注册器、未知选项和外部 decoder 接收者不应被当成纯数据跨 realm 转移。私有标准对象只用于认证，不能增加未知 getter/Proxy 的观察。

文件：`ktx2DecoderConfiguration.ts`、`localDecoderConfiguration.ts`、`ktx2WorkerDecoder.ts`、`ktx2DecodeWorkerPool.ts`、`ktx2Decode.worker.ts`、`createEngine.ts` 的能力登记及 `publishedBabylonCache.ts` 的安装顺序。

## 已保留的证据和错误边界

证据根目录：`output/render-optimization-q1-20261024`。

- URL 前置：`ld1-local-urls-red.log` / `ld1-local-urls-green.log`；独立审查 `ld1-local-urls-review.json`。测试还原 Draco/Meshopt/Basis/KTX 全局状态的遗漏已修复。
- 队列：`ld1-worker-pool-red.log` 曾证明排队期间后续改源字节会污染提交；改为提交时复制后，`ld1-pool-and-urls-green.log` 为 9 项通过。FakeWorker 不证明真实 GPU。
- 早期 HTTP run-1/run-2：实际三格式 mip 字节对照有效，缓存先 configure 后 install 的顺序只是夹具控制，不能代表真实 PlayerApp；其 PNG 为白面，零差异不得作为纹理画质证据。后续已切换显式 sampler shader，并要求 color_grid 至少 32 种 RGB、8×8 alpha 样本至少 2 种 RGB，再作同格式对照。
- run-3 的采样阈值错误地对简单 8×8 alpha 样本也要求 5 种以上颜色；已按独立已知样本条件分别校正，保留原失败。run-4 发现 HTTP 缓存 wrapper 原来会 JSON.stringify 选项一次、原 decoder 再 spread 一次，早期夹具错误地要求只读一次；真实业务合同应保留原来的两次，file 无缓存才一次。修复仅针对夹具 oracle，不放松产品未知观察合同。
- file-1 失败于现有 Viewer 配置对 file URL 的拒绝，file-2 失败于 Babylon 依赖需要字符串执行而测试 CSP 未允许 unsafe-eval；未修改生产 CSP。后续 file 夹具将与 HTTP 缓存验收分开，明确只检查本地 worker/纹理/GPU 及当前可用 CSP。

纹理输入来自 Khronos KTX-Software，固定 commit `6a719e8c52d41a2fa5ca0fa9bff647ec4daf1c2c`；仅在任务输出中用于测试，不加入产品资产。ETC1S color_grid、UASTC+ZSTD color_grid、ETC1S alpha 的 URL、长度、SHA、supercompression 留在 `ktx2-fixtures/manifest.json`。不使用外部 CDN 解码器。

独立审查发现的静态 getter、继承字段、实例覆写、额外微任务和生产缓存顺序问题均须有回归后再验收；早期失败不删除。B2 图集 CPU 对照计时期间暂停本项一切构建、测试及浏览器，避免污染计时。

## 根代理本地验收补充（2026-10-24）

正式计时只采用 `ld1-abba-2/report.json`，两臂各暖机后 A1/B1/B2/A2，产品执行器未变。纹理请求到 GPU-ready 的墙钟均值 A 193.350ms、B 195.350ms（+1.0344%，约慢2ms）；对应区间与 longtask entries 的交集累计均值 71.900→1.250ms（-98.2615%）。这是受控三纹理的主线程阻塞改善，不是独占转码CPU/GPU时间、整场景首帧或FPS。36张保存PNG逐字节同各自参考，mip/元数据相同。独立逐窗复算在 `ld1-abba-2/independent-review.json`。第一轮因B7 typecheck session2998未确认结束而排除计时，raw完整保留，非算法/夹具失败。

原指定 `scripts/smoke-published-cache.mjs` 的有效报告为 `published-cache-combined-6/report.json`。实际辊筒移载Draco GLB和独立KTX2 GPU上传：4轮同一几何SHA，2670种可见颜色；冷/换版KTX worker各完成1次，暖/回旧版本下载0、解码0、decodeHits5，无CDN/页面错误；原LRU/超大条目检查通过。root已打开实际cold.png。KTX2未绑定该业务GLB材质，真实纹理画质由独立sampler夹具验证，不能混称该PNG证明KTX采样。

smoke支持第四位置参数新输出目录，先把原内联fixture一次构建成同一生产模块图，再用独立HTTP端口提供；这修正了旧dev夹具的广泛文件监听和Draco深入口重复单例。最初诊断中触发调试器异常的轮次、取消重复旧配置轮次、CDN重复单例失败、静态server下原probe动态import404、LRU同毫秒并列失败均保留，未作成功证据。LRU测试只增加5ms区分usedAt毫秒时间，原预期未改变。

耐久入口：`npm run test:local-decoders:webgl -- --fixtures output/render-optimization-q1-20261024/ktx2-fixtures --parallel`。顺序计时用独立新目录加 `--perf`，不允许与parallel合用；必须排空所有peer任务。新夹具记录runner、3原KTX2、9本地decoder与相关代码共24项前后SHA；旧正式计时报告只记录当时11个选定代码/fixture输入，3原纹理另有固定上游commit清单，不能补称旧报告完成全资产前后冻结。
