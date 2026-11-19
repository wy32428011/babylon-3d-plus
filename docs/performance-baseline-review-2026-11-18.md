# v0.4.17 性能复核与验收记录

依据《babylon-3d-plus 复核与详细优化方案》（复核对象 v0.4.14）。本次从 v0.4.17 的 `389cd1e461b0425c211b653055d5c8a825d6220c` 出发。已经完成的基线修复不重复改；缺少现场数据的优化不调高优先级、不改默认值。

## 阶段 0：工程基线

- **Lint 与原有失败组**：v0.4.17 复跑未复现方案记录的 11 个 lint error。原失败项中，Viewer 总览/状态层、GLB 标准预览、场景切换发布保护和缓存阴影在当前基线的对应回归通过。绑定文件写入补齐 Windows 与 Linux 的 `rename` 差异：收到 `EISDIR` 时走现有目标类型检查，拒绝替换目录，保留原错误为 `cause` 并清理临时文件。Windows 上同时验证实际目录和注入的 `EISDIR`；未声称已在 Linux 跑过。
- **依赖与锁文件**：锁定 `fflate` `0.8.3`、MQTT `5.16.1`、Electron `42.11.18`（只升同主版本补丁），生产树的 `brace-expansion`/`ip-address` 更新至 `5.0.13`/`10.7.6`。锁文件 `resolved` 统一为 npm 官方 registry；未改本机 registry/npm 二进制下载策略，未升级 Babylon。独立干净目录以官方 registry 执行 `npm ci` 成功；`npm audit --omit=dev --audit-level=high` 无 high，仍有 3 个 moderate（`archiver`→`readdir-glob`→`minimatch` 链路）。没有使用 `--force` 降级 `archiver`，也不把同主版本补丁当作进入受支持主版本的迁移。
- **首屏 JS**：[基线](../scripts/build-size-baseline.json)来自上述提交、Node v22.22.0 的生产构建。统计入口及其同步静态导入的最终 JS 文件字节数；不计动态载入、不按 gzip 算。CI 在 Ubuntu 上独立构建 Editor、Viewer；任何一端超过基线的 105%（向下取整）返回非零。体积限制不会改构建输出、分块配置和延迟加载行为。

| 目标 | 基线字节 | 本次字节 | +5% 上限（字节） |
| --- | ---: | ---: | ---: |
| Editor | 6,229,377 | 6,239,602（+0.16%） | 6,540,845 |
| Viewer | 5,206,617 | 5,213,478（+0.13%） | 5,466,947 |

遇到超限，先核对报告的同一 Vite 构建模式、Node、输入及静态闭包，不把异步 chunk、压缩率或本机缓存差异当成首屏字节。先定位同步导入回归；确需提高上限时，须在变更审查中附两端 `summary.json`、`run.json` 和新增体积原因，经审核后更新带来源提交的基线。不要临时抬阈值或移除 CI 步骤。

```powershell
npm run analyze -- --check-budget
```

## 阶段 1：诊断入口和数据口径

- 编辑器展开性能明细或进入「性能运行」时开启 GPU 采样；收起明细、停止运行后如无其它诊断入口需要采样则停用。Viewer 仅在 `?performance=1` 的诊断会话里开启。普通编辑、运行和发布场景不启动 GPU 查询。切场、关闭或释放时清理本会话的查询；WebGL2 扩展不可用、查询超时或上下文丢失均不会造零值。
- `cpuFrameMs` 是最近完成的 Babylon 场景帧 CPU 耗时；`gpuFrameMs`（兼容别名 `gpuFrameTimeMs`）是最近有效的 WebGL2 引擎帧查询，约每 200 ms 最多发起一次，`gpuFrameSamples` 只在有效新结果到达时增长。`gpuTimingStatus` 保留不可用原因；`null` 表示缺测，实际的零仍是零。帧间隔、有效 FPS 和逐帧分位数另见 `frameTiming`/`wallClockFrameTiming`，不能用 CPU 或 GPU 工作耗时替代。旧秒级报告字段保留。
- 打开诊断将同一 renderer 的 `PerformanceObserver('longtask')` 记录按 `openId` 关联，以最长十项列出原始时间、打开窗口重叠和脚本、分类、解码、同步的候选 span。多类证据标 `ambiguous`，没有证据标 `unknown`。重叠不等同于 CPU 调用栈，也不跨 main/renderer 时钟相减。结束时取出已排队条目，不声称覆盖结束后浏览器才投递的尾任务。
- 阴影明细使用实际 Babylon `ObjectRenderer` 绘制区间分灯光和面/级联计数，不把就绪探测当绘制，不在阴影 RTT 上增加导致静态缓存退化的订阅。没有改阴影贴图尺寸、投影对象、刷新默认值或画质。

### 现场 B–A–A–B

先生成对应源码的生产构建。在目标 UHD 630、同一驱动和显示条件下，准备一份离线 SOURCE 工程副本（含 `Assets`，有资产索引时也保留），一份固定相机的场景及与场景匹配、覆盖至少 63 秒的本地 MQTT 录制。使用不会与实际 Broker 联通的测试环境；不要用正在编辑的原工程做测试。不要与构建、烘焙或其它 GPU 采样并行。输出目录须尚不存在、父目录已存在且不在原工程内；不允许通过目录联接改写工程或覆盖旧报告。

```powershell
npm run build
```

```powershell
node scripts/smoke-extreme-scene-performance.mjs --baab --scene "<离线场景.json>" --project-root "<含 Assets 的离线工程副本>" --replay "<recording.json>" --output "<父目录已存在的新报告目录>" --fullscreen --profile
```

- 新报告 `baab-result.json` 固定顺序 B(2)–A(1)–A(1)–B(2)，每轮预热 3 秒、墙钟采样 60 秒。核对 A 的**实际主绘图缓冲区**是否为现场基准的 2560×1440；`--fullscreen` 使用实际显示器，不是模拟 2560×1440。B 仅将 `hardwareScalingLevel` 改为 2；相同相机、资源、驱动、回放、CSS 视口和 DPR 是比较的前提。复制工程、userData、本机回放 Broker 均隔离；报告不写 MQTT 报文、真实地址或凭据。
- 两对 B/A FPS 都至少 2 倍才标记 `gpu-limited`（GPU/填充倾向）；两对都在 0.90–1.10、同档重复稳定且不受刷新率或引擎 FPS 上限掩盖，才标记 `cpu-limited`。它不排除不随分辨率变化的 GPU 成本。回放或运动未就绪、漂移、上限不明、帧覆盖不足等保持 `undetermined`；`passed` 只表示条件齐备，不等于测出优化收益。分辨率单变量实验不是等画质对比，旧比较入口明确拒绝此类报告。
- `--profile` 在四轮之后独立采集 20 秒 A 组 renderer CPU 采样，输出脱敏的自耗时前十，不计入四轮 FPS。自耗时超过 10% 的函数结合业务与 GPU 证据核对后再确定优先级。默认独立 `probe:gpu-timer` 添加 `ignore-gpu-blocklist`，其能力探测不能代替正常产品启动下的 GPU 数据。
- 失败报告使用固定阶段名，例如 `window-1-B:install-capture` 或 `window-1-B:validate-window`。保留已返回的测量窗及输入哈希，异常原文与堆栈留在报告之外。

## 本次验证

本机 Windows 10 x64、Node v22.22.0；下表仅记录实际执行的范围。两端体积门禁本机执行通过，尚未执行远端 Ubuntu / Windows CI。

| 入口 | 结果 |
| --- | --- |
| `npm run typecheck`、`npm run typecheck:quality`、`npm run test:entries` | 通过 |
| `npm run lint`、`npm run format:check`、清单生成与 `--check` | 通过；lint 0 error、126 warning |
| `npm test`（core） | 864 通过、1 跳过、0 失败 |
| `npm run test:optimization-p2-r0` / `npm run test:phase2-open-protocol` | 分别 38/38、103/103 通过 |
| 绑定文件防护、阴影缓存与上下文恢复、BAAB 与报告比较和 MQTT 回放 | 定向测试分别通过 9/9、18/18、18/18 |
| `npm run test:lighting-unified` | 43/43 通过 |
| `npm run test:scene-loading` | 200 通过、10 失败；10 项均在起始提交复现（场景准备 VM 夹具缺少 `getSceneProjectOpenContext`） |
| `npm run test:optimization-phase2` | 250 通过、9 失败、2 跳过；9 项均在起始提交复现（DPR/不透明画布、烘焙传输、缓存图片、旧恢复 SHA 与冻结 codec 模块） |
| `npm run test:contracts:observability` | 首个诊断冒烟即失败：`loadCount` 实际为 0，期望为 1；起始提交同一断言复现。后续入口未由本命令执行；BAAB、报告比较和回放的定向测试已另行跑完 |

基线失败在独立的起始源码目录中用同一套本机依赖复跑。阴影缓存审计另在基线复现 Windows 检出的 CRLF 导致 SHA 假失败；现在以 Git 的 LF 口径验证完整内容，受保护脚本不变。不将扩展套件表述为全绿。未执行整组 `test:integration` / `test:smoke`、NSIS 安装、实际中台或 Blender 验收。

### Electron 实机

- `npm run smoke:gpu` 通过。Intel UHD Graphics 630（驱动 `31.0.101.2115`）、ANGLE D3D11、WebGL2 正常；另用隔离的禁 GPU 夹具验证不会回退到软件 WebGL。
- `electron-builder --win --x64 --dir --publish never` 生成独立 `win-unpacked`，`npm run smoke:packaged:gpu` 对该生产 EXE 退出码 0。硬件 WebGL 绘制立方体，GPU/像素检查通过；这不是 NSIS 安装验证。
- 同一生产构建用 Electron `42.4.0` / `42.11.18` 分别启动；使用隔离 userData、固定 720×420 主绘图缓冲以及相同相机和网格状态。对实际绘制完毕的 RGBA 取 SHA-256：空场景两版均为 `3364f3c7a805be796e0a88dbc874397d1c84a43bfe62a704958c3d0b554326ba`，立方体两版均为 `3cdefb949c367a9d707f94fd3d07e4834223ff05b02f449517f77a76a1651603`。首轮缓冲尺寸不一致被拒绝，未计入结论。
- 两版展开 HUD 后都得到 `gpuTimingStatus: valid` 和 6 个有效 GPU 查询；收起或关闭后恢复 `disabled`。这验证了实际硬件计时启停，不把单次小场景数值表述成版本性能差异。
- `--baab --profile` 在生产构建和同一 UHD 630 上完成双输送线合成夹具测试，退出码 0。1920×1080、60 Hz 显示器的窗口模式下，主缓冲 A 为 820×436，B 为 410×218。四轮各测 60 秒，按 B–A–A–B 得到 32.85、32.82、32.85、32.72 FPS；配对 B/A 分别为 1.0010、0.9959。每轮回放 254 条、332,970 字节、0 失败，运动上下文计数都增长，四轮均有有效 GPU 查询。`baab-result.json` 记录输入复核通过，按本夹具的测量条件返回 `cpu-limited`；独立 A 组 CPU profile 为 20.43 秒、14,890 个样本，报告仅保留自耗时前十。此处既不是等画质收益，也不是原 383 实体工厂、2560×1440 条件下的瓶颈结论。

## 未晋级的优化与验收条件

| 候选 | 当前边界与验收要求 |
| --- | --- |
| 准备期分类门、材质修订 | 默认不变。完整中台五冷五暖同输入对照；打开中位至少下降 30%、像素 SHA 一致后再考虑灰度。 |
| 运动设备动静合批 | 保持默认关闭。需真实运动场景成对测试：Draw Call ≤800、`evaluateActiveMeshes` 下降至少 30%、六姿态像素零差。 |
| 遥测逐帧去重、数组复用、缓存预热 | 先用 `telemetryOuterStages` 核对候选阶段超过 0.5 ms/帧；改变后须保持运动、箭头和状态机逐帧行为。 |
| 打开/同步分片 | 从有明确归属且超过 200 ms 的真实单任务中选择；目标是最长单任务 ≤200 ms，遮罩不中断；总打开耗时另比较。 |
| MQTT 批量 IPC | 只有现场数百条/秒，或该路径占 profile 超过 3%，才考虑合批；顺序和消息量必须不变。 |
| UHD 性能档、环境压缩 | GPU/填充倾向证据齐备后单独验收帧耗时、显存与画面；不降默认分辨率、阴影或环境材质质量。 |
| Babylon 升级、WebGPU 快照、超大模块拆分 | 不混入 Electron 补丁。升级/快照分别在隔离实验验证，拆分按职责逐步保留契约测试；生产仍以 WebGL 为默认。 |

历史工厂数字属于原样本，不是本次实测。没有满足同一现场输入和分辨率的四轮证据之前，不据空场景、两台内置设备、Node/NullEngine 或打包冒烟估计工厂 FPS、打开耗时、Draw Call 改善。真实中台、Blender、正式工厂的五冷五暖与六姿态像素对照分别验证，不能用已通过的单测代替。
