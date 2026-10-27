# 通用渲染框架 FPS 优化（2026-10-27）

目标：优化编辑器通用渲染路径导致的 FPS 瓶颈；中鼎智能工厂仅用作复现与实测样本。保持原画质、设备业务、场景及模型文件，未知路径保守回退。

- [x] 核对现场基线、工作区和已有实验，保留已有改动。
- [ ] 针对默认渲染路径的实际热点，确定并实现可保持同帧结果的通用优化。
- [ ] 同条件、原始场景下测量前后实际 FPS、CPU/GPU 和绘制工作量，核对画面及必要的设备行为。
- [ ] 审查变更和实测结果，记录未验证项与可回退方式。

基线：原场景 SHA-256 `4dd76f7c3b387cc23f1b02a11271ef603a0f5be18a06ff8379575e27214df480`；RTX 4060 Ti，WebGL2/D3D11，824×440、scaling 1、静止视角，60 秒 707 帧，11.783 FPS，GPU P50/P95 55.22/58.40 ms，约 6009 Draw Call。详见 `output/live-gpu-diagnostics/2026-10-27T02-02-31-232Z/report.json`。该样本未覆盖真实 MQTT 设备回放。

现有动静合批默认关闭；旧实验在另一配置下开启后严重退化，不将其作为默认路径根因，也不直接启用。历史 shadow-only 实例实验的像素等价未证明，不可将其结果当成可交付优化。

原始工厂追加阴影审计：`output/live-gpu-diagnostics/shadow-audit-2026-10-27T02-50-01-386Z/report.json`。原有 quality/hybrid 方向光 3 级联，每级每帧约 1353 次 shadow draw，合计约 4059；648 次静态缓存命中、0 次静态重绘或失效。为 draw 计数，非独立 GPU 时间。原生阴影绘制路径为 CPU 采样热点，不能直接跳过 `isReady` 或冻结投影；直接修改原设备脚本不属于通用框架优化。

通用阴影载体的独立微场景实验：`output/shadow-carrier-microtest/report.json`。标准材质、单方向灯硬阴影、两方块下，索引和非索引网格均通过双向可见性负控；原生与载体画面及阴影颜色贴图中的深度编码逐分量相同，包含受控移动和材质身份不符时的原路径回退。该证据不覆盖原工厂 CSM/PCF、多灯、插件或真实设备逻辑，不代表产品实现或 FPS 改善。

三级 CSM/PCF 微场景最初负控未通过；复用项目的 SceneShadowRuntime、HybridShadowCache、接收面和灯光设置后受光、投影负控均有效。修复深度数组的诊断读取配置（临时 NEAREST、采样后恢复）后，3×2048 级联的索引/非索引两方块在静止、受控运动和材质身份失配回退下，画面及每层隔两 texel 的深度采样与原生一致；未覆盖所有深度像素、复杂材质、插件及真实设备。证据：`output/shadow-carrier-microtest/csm-report.json`。用户窗口保留，专属微场景进程已退出。

对原始工厂正在运行的 primary CSM 列表只读统计：3610 个 caster 中 2812 个动态；排除已有 native/thin instance 后，2493 个对象按 geometry 和 material 对象身份同时分组，仅 6 组各 3 个，2340 个单件及 135 个缺 geometry/material，尚未通过合批准入检查。此前另一配置的 481 个穿梭车对象 geometryId 和 materialId 均各不重复；内容相似不能证明 GPU 数据、材质插件或动态状态等价。资产加载器对含脚本资源保留独立几何和材质以支持脚本修改，不能无条件改为共享。

当前未改产品代码，未完成用户要求的 FPS 改善。原始构建快照与哈希清单位于 `output/framework-fps-snapshot-20261027-104855-867821/`，对照工具位于 `output/framework-fps-validation/`，尚未运行 A/B/B/A。尚需验证复杂材质及几何状态、逐光源/逐 pass 列表与动态回退并证明原厂覆盖；真实 MQTT 录制仍缺失。

## 续查：几何与材质安全边界

- 旧 A 构建快照缺少 `public/builtin-skyboxes`，首轮隔离启动失败；已在任务快照补齐 42 个 public 文件并逐文件哈希校验，源文件未改。隔离 A1 真实前台、原始场景、RTX 4060 Ti，1960×948、3×2048 阴影：60 秒 672 帧，11.2 FPS，GPU P50/P95 57.90/64.81 ms，6009 DC；337 次 GPU 查询、0 disjoint。`output/framework-fps-validation/A1-2026-10-27T03-10-08-831Z/report.json`。未运行候选/B 或 ABBA，不推断改善。
- Babylon 共享 Geometry 会改变公开的 `geometry.meshes` 及释放、更新语义；独立几何的 CPU 内容哈希无法证明 GPU 内容及后续变化一致。现有上传监听不能覆盖任意原生 WebGL 写入；严格只读合同不是脚本沙箱，原工厂亦无该声明。同步 GPU 读回可作为有界诊断，但只证明读回瞬间并可能阻塞 GPU，绘制前未知回调仍需处理。
- 不同不透明 Standard/PBR 材质可能共享原生阴影语义，但须逐 pass 核对 alpha、裁剪平面、剔除、朝向、渲染组、normalBias 和插件/回调等状态。已准备独立 CSM 材质对照与有界 GPU 几何探针，运行状态与结果以实际报告为准。

- 不同材质的 3×2048 CSM 微场景：首轮 clipPlane 改动后画面出现 1734 个颜色分量差异，保留失败 `output/shadow-material-microtest/2026-10-27T03-13-56-279Z/report.json`。等待 shader 稳定后 Standard/Standard、PBR/PBR、Standard/PBR 三组均通过负控和稳定态 A/B、alpha/clipPlane/cull 回退；该结果不能解释首轮差异或证明变更当帧等价，第二轮见 `output/shadow-material-microtest/2026-10-27T03-14-23-088Z/report.json`。
- 原始工厂独占窗口：布局及 CPU 字节预筛 847 对后取得 64 对候选；实际阴影绘制前逐字节读取其中 12 对不同 Geometry GPU 顶点/索引缓冲，12/12 读取瞬间一致，96 次读回共 88704 字节，单对完整比较 3.8～4.6 ms、平均 4.04 ms，采样集中于同一帧。不能推广至全部模型或证明后续变化一致，按帧同步读回有明显开销。预存 GL error 1281/1282 已分别记录；独占窗口及插桩已关闭，报告为 `output/geometry-gpu-readback/2026-10-27T03-17-29-073Z/report.json`。
- 通用自动分组隔离原型：14 组/64 对象通过源与载体安装时 GPU 校验，原生阴影列表保留，B 实际发生载体调用且无守卫回退。原始工厂 824×440 四个 12 秒窗口 A1/B1/B2/A2 为 11.42/8.83/8.58/11.33 FPS，Draw Call 6009/5859/5859/6009，GPU P50 59.16/77.33/78.37/58.85 ms；B 出现最大 36.4 ms 回调记录。`output/shadow-auto-group-prototype/2026-10-27T03-26-48-582Z/report.json`。回调、draw 包装和资源均已恢复，专属窗口退出；原型导致退化，不采纳。它不追踪全部原生 GPU 写入，且未证明工厂画质与设备等价，不能作为产品实现或正式构建验收。
- 不跳过检查的低分配变体：DataView 32 位块与尾部字节逐项比较，非对齐及共享缓冲有界自检 37475 次通过；在新独占窗口重复同条件研究短窗，A1/B1/B2/A2 为 11.42/9.75/9.75/11.17 FPS，Draw Call 6009/5859/5859/6009。B 的 12 秒字节检查累计约 325～330 ms，材质约 117～144 ms，几何约 107～111 ms；计时包含探针开销且不能简单相加。仍然退化，不采纳；因不同实验轮次不能据此计算对旧原型的严格提升。`output/shadow-auto-group-wordcompare/2026-10-27T03-37-10-598Z/report.json`。

## 续查：逐帧材质差异与低成本追踪

- 独立 WebGL2 试验中，正常 Babylon `engine.updateDynamicVertexBuffer` 会触发现有监听，但用订阅前保存的原生 `gl.bufferSubData` 更新同一 buffer 时，GPU 实际数据变化、监听次数不变且 `isCurrent=true`。该试验不证明工厂脚本实际使用此绕过方式，但证实现有 hook 不是完整 GPU 写入合同；见 `output/shadow-tracking-research/2026-10-27T03-53-10-511Z/report.json`。
- 材质逐帧合成试验：正常及 onBeforeRenderTargetsRender 变更时，原生 A/A 和原生/回退对照的前 12 个受控帧逐像素相同，负控证明 clip 变化可见；原生自身第 1→2 帧变化 3954 个颜色分量，同时 scene 从未就绪变为就绪，未证明具体 shader 因果。见 `output/shadow-material-frame/2026-10-27T03-56-03-666Z/report.json`。
- 按旧 alpha→恢复→重建载体→clip 的自然帧顺序复现了此前 1734 个分量差：回退图为第 5 帧且 scene 未就绪，原生图为第 10 帧且 scene 已就绪；两者均绘制原 caster。另两次第 5 帧已就绪且差异为零。证明旧对照跨越准备状态变化，不单独证明某个 effect 是唯一原因；逐帧读回本身影响时序。`output/shadow-material-frame-natural/2026-10-27T04-03-06-612Z/report.json`。
- 进一步诊断再次复现 1734：第 5 帧 `scene.isReady=false` 的直接原因是缓存中的 `default` effect ID 6 未 ready（含 CLIPPLANE、ALPHABLEND、CSM PCF），第 6 帧该 effect 已 ready；第 1 帧另有 two-material 的 shadowMap CLIPPLANE 变体未 ready，第 2 帧恢复。尚未证明 default effect 参与对应绘制或造成差异，不能将相关性冒充因果。`output/shadow-material-frame/readiness/2026-10-27T04-04-42-013Z/report.json`。
- 原始工厂 824×440 隔离窗口分层 8×12 秒研究：64 组/178 对象，A1/O1/G1/B1/B2/G2/O2/A2 FPS 为 11.17/9.75/9.75/9.00/9.25/9.75/9.92/11.33；A/O/G 为 6009 DC，B 为 5667。复用集合把构造耗时从约 67～71 ms/12s 降至 0.2～0.3 ms，但 FPS 未见改善；合批比只检查更慢。分项探针有开销，不可相加为独占时间。`output/shadow-guard-research-fast/2026-10-27T03-59-39-164Z/report.json`。隔离窗口资源已恢复和释放，未修改产品代码或宣称正式 FPS 改善。
- 进一步分项证实 Babylon 默认列表在每帧后两级复用准备结果；自定义阴影列表每级重置并分派约 1826 submesh，带探针的 A/G/B/B/G/A 为 11.17/9.67/8.92/8.83/9.67/11.25 FPS。各项时间互相包含且探针有扰动，不能归因全部帧率差。`output/shadow-manager-research/2026-10-27T04-10-12-346Z/report.json`。
- 保留默认列表、仅在每个已分派的动态队列中替换连续且同材质组的隔离候选：178 源/64 组无一替换，全部命中材质引用不同及不连续或跨队列，附加检查后 FPS 下降。像素哈希一致是零替换结果，不证明合批等价。`output/shadow-face-queue-research/2026-10-27T04-16-07-586Z/report.json`、`locate-2026-10-27T04-18-29-597Z/report.json`。不放宽门禁，原样恢复窗口和资源。
- 材质 1734 分量差进一步定位至 578 像素 x=407–430、y=283–320；自然帧及手动帧记录到 `two` 的实际 color draw 从不含 CLIPPLANE 的 default effect 切到含 CLIPPLANE 的 effect，手动两张 RGBA 与自然两张逐字节相同。预编译后对应 effect 首帧生效，后续画面变化为零；native/native 和 native/fallback 的同编号 10 帧一致，阴影负控有效。`output/shadow-material-frame/causal/2026-10-27T04-19-35-333Z/report.json` 与 `manual-2026-10-27T04-20-20-672Z/report.json`。这是受控场景中主材质过渡 effect 切换的强证据；预编译改变时序与缓存，不可直接当通用产品修复，未知其他材质/场景同帧安全。
