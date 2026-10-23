# 项目专项优化执行记录

依据：`docs/project-optimization-plan.md`。用户授权继续按步骤实施；保留现有光照、场景版本兼容等全部未提交改动，不提交、不推送、不发布。

## 约束与验收清单

- [x] 核对全局指令、工作树及计划；基线 HEAD、文件 SHA 和相关文件副本保存在 `output/project-optimization-20261021/`。
- [x] P1.1：同名衍生 JS 清理与构建守卫，正反例通过。
- [x] P1.2：业务深层导入及 ESLint 守卫；保留任意合法外置脚本的 Babylon namespace 能力和原 glTF 注册语义；无无效动态导入告警。
- [x] P1.3：模型脚本预转译、MQTT、二级弹窗与 DXF parser 按需加载，校验旧场景、取消、重试及发布资源完整性。
- [x] P1 门禁：typecheck、lint、test:ci、analyze 与实际 Editor/Viewer WebGL 通过。参数模型已完成双模式/注册方式对照，4 项阈值失败保留在 P2 问题清单；不将其表述为 16 包全部通过。
- [ ] P2：内容哈希缓存、资源流水线、动静部件实例化、矩阵/Gizmo 优化；必须用固定工厂场景和 MQTT 回放验收，不改变画质、几何或动作语义。
- [ ] P3：按计划逐域抽离巨型模块，保留门面及现有契约，通过相关集成。
- [ ] P4：严格类型、lint 与测试入口治理，按原计划指标验证。

## 当前发现与顺序

进入本轮时，三份衍生 JS 已被删除、业务深层导入迁移已存在但无完整执行记录；构建守卫尚缺。手工 Babylon namespace 和 glTF 扩展白名单存在兼容回退，先修复再验证 P1.2。MQTT 与低频弹窗按独立文件范围并行处理，主线程负责整合和完整构建；实机性能采样不与构建/静态检查并行。

## 验证与待办

### 已实现

- 编译前检查 `src/` 同名 `.ts/.tsx` 与 `.js`，独立参考 JS 保留。业务根路径运行时导入由 ESLint 拒绝，纯类型导入允许。
- 常见 Babylon 脚本符号深层导入；namespace 或其它既有 API 按需加载完整命名空间。ParticleSystem 使用完整注册，保持 custom shader 能力。普通 `.gltf` 原本接受 1.0，故保留 glTF1 深层注册，不用只适用于环境 GLB 的 2.0 检查收紧普通资产。glTF2 全扩展采用官方异步注册，按实际扩展加载，保留 OpenPBR adapter 选择。
- Node 导入扫描与导出预转译同用原编译选项及纯预处理；Electron 通过已授权实际 TS 的协议响应获取代码。Viewer 使用独立 `.compiled.json`，按实际复制源码原字节 SHA 绑定后写入资产及 release manifest。场景文件不携带、也不执行 inline cache；同脚本多实体只导出一份资源，原 TS 与 SOURCE/DIST 校验不变。
- TypeScript 转为 Node 正式运行依赖；renderer 的 compiler 只为旧包/开发裸 TS/损坏缓存兜底。保留旧包兼容，构建目录仍含可延迟加载的 compiler chunk，不能表述为整个安装包删除 TypeScript。
- MQTT 连接/测试延迟加载，禁用/模拟器/Electron IPC 不导入 mqtt.js；配置切换、销毁、取消、总超时与失败重试受保护。光照、部署、发布、人物预览首次打开才加载，含可关闭加载反馈与失败重试。
- Shader 按语言合并，ShaderStore 留在首屏，两个大 shader chunk 均 deferred；不通过降低 DPR、分辨率、几何、抗锯齿、光照或动作频率减体积。
- CAD 保留同步 facade，原几何/单位/预算/缓存逻辑逐字提取到 Core，精确 Parser 单独延迟加载；大文件 Worker 流式路径保持。模块下载等待后重新核对取消或场景代次。
- 原 telemetry 聚焦入口修复为只编译选择的测试及实际依赖；未选择时仍检查全量。SOURCE 与 27 项阴影测试按独立既有 canonical 光照合同迁移，保留安全与数值断言。
- 实机验收发现并修复打开资源准备期间发布/关闭会话的迟到授权：opening/lighting await 后均先校验提交资格，再授权资源。
- 修复普通本地项目完成恢复后自动发起远端全库同步的误报：自动流程等待真实配置，空地址不发起；显式同步仍保留原配置提示，已配置及会话取消行为由 7 项聚焦测试验证。

### 已有证据

- `npm run test:optimization-p1`：49 项构建/编译/兼容/弹窗/CAD/自动同步与 35 项 MQTT，共 84/84，通过且无 skip/cancel。最终日志 `output/project-optimization-20261021/p1-suite-final.log`。
- 最终完整构建和类型检查通过（`build-final.log`）；CAD/本地自动同步修复后的 CI 再次通过（`test-ci-delivery.log`），最终 lint 0 error、182 warning（`eslint-delivery.json`）。旧 CI 首轮 39 失败保留在 `test-ci.log`，中间修复后为 `test-ci-final.log`，没有删除失败测试。warning 渐进治理仍属于 P4。
- 最终分包分析 `output/bundle-analysis/2026-10-21T04-45-32-931Z/`：Editor initial 5,280,709 bytes（gzip 1,478,674），Viewer 4,295,252（gzip 1,211,941）；与计划基线分别减少约 50.1% / 55.9%。入口分别 3,771,538 / 3,703,463 bytes。DXF parser 77,982 bytes 已 deferred。相对中间无 shader 合并版本，chunk 594/568 降至 241/214；总 JS 14,664,186 / 13,686,692 bytes，未同步下降，不能以首屏收益宣称整个安装包等比例缩小。
- 实际生产 Edge Viewer：Intel UHD 630 / ANGLE D3D11 / WebGL2，1440×900、DPR1，原 TS 和 sidecar 读取成功，未请求 TypeScript/mqtt bundle，无页面或 shader 错误。`production/viewer-result.json`。favicon 控制台 404 不属于场景资产。
- 最终生产 Editor / Viewer 联合 smoke 为 PASS（`production/result.json`、`production-smoke-final.log`）：Editor 先完成加载且无资源问题，再打开三个 lazy 弹窗；首次关闭时没有模块请求、首次打开才请求对应 chunk。Viewer 两台模型共用一份 sidecar，无 TypeScript/MQTT bundle 请求、无页面错误，实际硬件 WebGL2 与 1440×900 / DPR1 已记录。旧 smoke 只等脚本 marker 的未完成验收和后续 harness 错误保留，最终结论以这次完整运行替代。

### 视觉与后续边界

16 包实际 Electron 硬件 WebGL 验证完成：预转译与原 TS 两种模式均 12 通过、4 未通过原阈值；预转译命中 16、compiler 请求 0，原 TS 请求 compiler。4 项分别是 box 前景比例、GD 非均匀缩放亮度、RGV 像素差、Shelf dense 源批次。再对这 4 项改回完整 Babylon 注册，失败数值相同、22 张 PNG 字节完全相同，排除本轮预转译与按需注册差异。没有把它们称为 Git HEAD 历史缺陷，也没有降低门槛。两模式 166 张 PNG 中 147 相同，其余 LED/YZJ 含真实时间动画，最大容差像素差 0.1442%，不能宣称全部像素相同。汇总见 `output/model-array-validation/project-optimization-{script-mode,babylon-registration}-comparison.json`。

CAD 额外验证：新增 lazy 与既有 Worker 6 项、编码/渲染层 10 项、三套 `smoke:cad` 全部通过；Core 与原算法正文逐字相同。SOURCE 19 项、canonical 阴影 27 项及打开互斥 16 项在保留原安全与数值意图后通过，不能和 CI / 专项套件交叉重复累计。

P2–P4 尚未按本计划展开，不把原有 S1–S5 的历史验收等同于本计划完成。未做工厂 FPS、冷暖打开下降、真实中台/现场 MQTT/安装包验收，未提交、推送或发布。所有主进程协议/资源门禁更新仅在本地构建，已运行的旧 Editor 窗口需重启才会加载新主进程。

最终 inventory 检查零漂移，78 个登记入口零缺失；当前 754 个候选/支持文件、373 个静态可达、302 个未确认仍保留。10 个设备驱动/引擎/阴影/材质/实例关键文件与入场 SHA 完全相同（`protected-final.json`）。全工作树 diff 空白检查只剩入场已存在且本轮字节未改的 `tests/buildTypeScript.test.mjs:85` EOF 空行，未为清理该警告覆盖前序文件。汇总 `delivery-summary.json`，本轮资源释放检查在交付前执行，保留报告、场景副本和截图。
