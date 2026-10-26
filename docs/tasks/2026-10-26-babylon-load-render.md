# Babylon 9.12 加载与渲染专项

## 目标与边界

执行已批准的 Babylon 专项计划：完整打开中位耗时下降≥30%，同条件帧间隔 P50 下降≥15%，保留完整模型、画质、编辑语义与设备动作。实现、功能检查和性能结果分别记录，不以局部夹具或历史结果代替业务收益。

沿用 AssetContainer/参数模板/现有 thinInstance 分片裁剪/本地解码器/阴影缓存；不升级引擎、不启用降画质策略、不覆盖原资产、不提交或对外发布。当前大量未提交改动属于入场状态，包含已交付的天空盒 v7/ENV 与加载遮罩修复；保留它们。

## 唯一执行清单

| 工作包 | 状态与下一步 |
|---|---|
| P0 冻结与基线 | 已冻结源码/构建；383实体静态副本真实GPU/CPU窗口有效，完整中台冷暖与持续动作仍缺输入 |
| P1-A 轻量克隆 | 已实现声明贯穿、实际glTF源/配置/脚本摘要绑定及lease；Node与真实Editor非GI链通过，真实业务资源准入仍逐包评估 |
| P1-B 稀疏矩阵上传 | 已实现稳定布局变化区间及恢复；512实例中改1个实际上传64B，GPU字节/像素/恢复一致；净收益未验收，默认关闭 |
| P1-C 脚本热点 | 已完成电机独立材质初始化修订；BAAB本地打开中位71.54→59.02秒（−17.50%），1215次优化命中；原脚本不改 |
| P1-D 打开与资产 | 真实原包与新包均使用生产完整内容指纹，保留固定pin；已有无损资产工具复用，不盲目增并发；中台五冷五暖未完成 |
| P2-A 分类增量 | 稳态getSources=0；启动期profile仍约14.87s。已实现仅初始准备的候选门，单次组合50.48秒、像素一致，默认关闭；未做跨模型增量缓存 |
| P2-B 冻结与阴影 | 当前3913网格、904已冻结、新增安全候选0，不扩大冻结；场景静态阴影缓存原已启用，未计作本轮收益 |
| P2-C Shader 预热 | 尚无有效首次业务事件基线，默认关闭；不将合成事件当现场验收 |
| P3 组合交付 | 构建/改动文件lint/新增功能定向检查及Editor→保存重开→非GI导出→独立Viewer通过；光照专项保留既有回滚失败，总性能门槛未完成 |

## 入场事实

- Git HEAD：`d96ec04`；原工作区改动不等于本专项修改。
- Babylon 实际安装版本9.12.0。AssetContainer独占克隆会独立 Geometry/材质，缓存源在克隆结束归还；共享几何必须另持有源引用到实例释放。
- thinInstance 已有粗细视锥裁剪和分片；当前提交方法主要为 `thinInstanceBufferUpdated`，不能把它描述为缺乏实例化。
- 已有 `projectOpenTrace` 主进程/renderer接线，先验证现状，不重复建设。
- 运行检查按本次明确执行的批准计划开展，不额外扩展测试范围。当前尚无本轮性能结论。

## 证据与后续

本轮输出目录：`output/babylon-optimization-20261026/`。正式采样与构建/profile串行隔离；源数据、脚本、各轮失败和不可用原因保留。

### 当前证据

- `baseline-source.json` / `baseline-source/` / `baseline-build/` 保存入场指纹、源码和可启动构建；未借助提交、重置或worktree清理。
- `p0-factory-3/report.json`：真实RTX4060Ti/WebGL2、2560×1440，60.114s/702帧；GPU P50/P95/P99=55.686/61.772/64.844ms，功能与计量均有效。仅383实体离线静态副本，不是旧Intel基线或MQTT持续动作。
- `p0-cpu/report.json`：60.092s窗口getSources/refreshSources均0次，tick累计3.6ms；不实施没有当前收益空间的N3。此前GPU探针的空开发URL错误来自工具显式传`VITE_DEV_SERVER_URL=''`，现已取消该变量并支持`--runtime-root`；未修改天空盒安全策略。
- `core-tests-2.log`：53/53定向通过；错误脚本摘要用例中的预期拒绝日志不代表测试失败。
- `sparse-webgl-result.json`：实际512实例，改1个上传64B；相对全量上传的像素与context restore后像素差0、CPU/GPU矩阵一致。仅功能及上传量证据，不是整场FPS收益。
- `editor-contract-qZB1p2/report.json`：真实Editor/RTX4060Ti导入、创建2个脚本模型、独立位移、共享Geometry/独立材质、保存重开及目录导出通过。独立测试场景经真实管理器明确设置为非GI；此前未烘焙时的发布门禁拒绝保留于`editor-contract-SpUe28/report.json`，不把非GI成功当GI通过。
- `build-3.log`：当前Editor/Viewer构建通过，保留原chunk体积提示。

### 设计补充与边界

- 为防止仅靠scene字段误启用共享，声明同时放入GLB的`asset.extras.runtimeCapabilities`；借助Babylon本次加载的`onParsed`读取，不二次下载GLB。配置哈希与脚本完整集合核对后才准入，脚本摘要在执行factory之前再核对。
- `materials: shared-readonly`尚未晋级为材质共享，实际工作材质始终独立；旧包/不合格资源保持原行为。
- 已核对现有LED和电机脚本存在顶点写入，不能自动加只读标记；Box脚本仅改根Transform，可作为后续真实资源候选，但不自动替换原工程。
- 本轮尚未证明完整打开≥30%与运行P50≥15%目标；不能把新协议、一次克隆或少量GPU上传当作整计划完成。

### 收尾结果与交付状态

- 用户追加1小时上限（2026-10-26T02:03Z→03:03Z）；实际超出，已停止新增研究。此交付是有实测收益的阶段成果，不是全计划验收完成。
- `p0-startup-profile/summary.json` 证明脚本内部PBR clone约占onStart采样时间一半，主要为属性复制触发全场SubMesh dirty扫描。显式`zending-3d-runtime`入口复用既有新材质保护，旧脚本/旧命名空间身份不变。
- `material-candidate-project-3/` 是完整独立副本；电机仅替换3处clone。使用生产`createSourceResourcePlan`重新计算新完整包pin，原pin/原脚本/原GLB保留。已拒绝直接取消pin和不完整的位置字段假设，失败日志保留；最终按生产typed资源枚举核对所有场景差异。
- `material-B1/A1/A2/B2/report.json`：观测顺序BAAB；A=71.907/71.169s，B=58.485/59.556s。两次中位71.538→59.020s，−17.50%；每轮功能通过、原场景未变、2560×1440完整RGBA SHA相同。该场景副本不含旧MQTT和失联大屏，不等于真实中台冷暖或持续动作验收。
- `material-C1/report.json`：材质修订+准备门单次50.483s（相对A观测中位−29.43%），延后125帧并在首帧前收敛，RGBA同上。样本不足，准备门和稀疏上传继续默认关闭。
- 独立非GI Viewer真实打开：两个模型就绪、脚本已启动、Geometry相同而材质独立、加载错误/光照错误为空，控制台无error；截图与浏览器读回见会话。使用的是正式目录导出，不是模拟集成。
- `build-5.log`构建通过；`final-lint.log`最终新增源码检查通过；能力/模板53项、后续变更9项、材质/API组及准备门3项定向检查分别保留原日志，不重复合计重叠用例。
- 光照整文件检查仍有`post-activation validation failure...`颜色回滚失败；同一错误已在入场前`output/native-skybox-implementation-20261025/r2-test_lighting-bake.log`与`s-test_lighting-bake.log`重现。本轮不改其断言或扩大修复。新增准备预览夹具按真实`setPreview(debugVisible,beforeBake)`签名修正后3/3通过。
- 未完成：完整中台五冷五暖、持续动作P50/P95/P99、完整GI及所有跨设备动作验收、候选默认晋级。没有提交、推送、部署或覆盖原工程。
