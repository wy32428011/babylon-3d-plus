# 材质烘焙与动静混合阴影：最终验收记录

更新日期：2026-10-20。修改前基线：`b1f77c1`。

## 当前结论

原计划的八项功能与运行验收均已取得下述证据；正式工厂 A/B/B/A 对照已通过，原场景文件 SHA 保持不变。验收采用已完成的 Editor 子阶段、最新 Viewer 子报告、独立状态报告和独立工厂报告分别证明，原 main/reopen 总报告中的历史 `FAIL` 保留，不改写为整体成功。

**最终验证已完成：最新 23 文件聚合为 135/135 通过，失败、取消、跳过和待办均为 0，耗时 246,157 ms，进程退出码 0，见 [unit-delivery.log](../../output/lighting-bake/unit-delivery.log)。最终 96 文件 ESLint 退出码 0、错误 0、告警 91，见 [eslint-delivery.json](../../output/lighting-bake/eslint-delivery.json)；告警包含新增测试和辅助文件中的非错误告警，并非全部既有。** 最新完整 TypeScript、Editor 和 Viewer 构建已通过，见 [build-final.log](../../output/lighting-bake/build-final.log)。

## 目标与约束

- 按已确认的效果图和 Inspector 布局扩展现有编辑器；场景分组为“光照与烘焙”，对象分组为“烘焙与阴影”，均默认展开。
- 静态间接光和环境漫反射离线烘焙；静态阴影深度缓存，动态阴影、直接光、高光和镜面反射实时计算。
- 自动分类复用实际运动驱动，支持实体与稳定模型节点覆盖；保留设备动作、参数脚本和 MQTT 语义。
- 旧 `baked`、`realtime` 场景保持原模式，新增 `hybrid` 显式启用。未进行 Git 提交、推送或线上部署。

## 按原计划逐项验收

- [x] **1. 静态、动态及混合部件分类可查看、覆盖、批量更新，模型修订失配可见。**

  证据：[Node 聚合日志](../../output/lighting-bake/unit-final.log)覆盖纯分类、实体批量设置、稳定节点身份、失配删除、父级动态约束、锁定和运行预览保护；原 [Electron 报告](../../output/lighting-bake/electron-result.json)的已完成检查确认实际固定立柱/升降部件分类，以及部件定位、覆盖、三项继承和恢复默认。多选及资源修订边界主要由真实 Store 回归证明，不能扩展为所有现场模型和驱动均已验收。

- [x] **2. 方向、点、聚光覆盖四种投射接收关系，动态运动不留下旧影子。**

  证据：[阴影 GPU 报告](../../output/playwright/hybrid-shadows/)包含静态→静态、静态→动态、动态→静态、动态→动态的实际阴影像素，并比较移动前后与原生完整实时路径。最新 12 构型共 84 状态的像素差均为 0，覆盖 Standard/PBR、点光六面、CSM、聚光、预深度和软透明。矩形面光与半球光不纳入同等实时投影承诺。

- [x] **3. 相同投影下静态深度不因动态设备运动重复绘制，相关输入变化正确失效。**

  证据：[多组 Node 日志](../../output/hybrid-multigroup-node.log)13/13 通过；最新 GPU 矩阵中 10 个默认/保留深度构型稳态不重绘静态，2 个显式组间清深度构型正确回退。正式 [工厂对照报告](../../output/lighting-bake/factory-only/factory-performance.json)中 B 两段静态绘制均为 18→18，缓存命中各增加 720。仅在受支持的缓存条件下承诺复用；定制深度清理保留原生完整实时行为。

- [x] **4. 真实 Cycles 输出独立 UV、光照图集与间接光探针，保留材质及反射且避免重复照明。**

  证据：[Cycles 集成日志](../../output/lighting-bake/cycles-final.log)、[图集及绕序报告](../../output/lighting-bake/atlas-density-final/atlas-face-report.json)、[最终区域分片报告](../../output/lighting-bake/partition-density-final/partition-report.json)、[材质 GPU 报告](../../output/playwright/baked-lighting-material/results.json)和[半球光 GPU 报告](../../output/playwright/lighting-hemisphere/results.json)。600 m² 平面最低实际密度为 16.001598 px/m；实际七表面夹具派生 23 片、388 三角形，最低 128.012303 px/m，19 张图集共 76 MiB，64 MiB 明确拒绝而 128 MiB 可容纳。几何、原 UV/UV2、法线、颜色、切线与材质属性保留，二叉分片覆盖完整。实际引擎为 Blender 5.2.2 CPU Cycles；不能据此宣称完整工厂 GI 已烘焙。

- [x] **5. 两处 Inspector、进度/取消/清除、分类显示、部件定位、运动及效果预览可操作。**

  证据：原 Electron 报告已完成两处分组折叠、节点规则、继承恢复、定位、实际取消、烘焙前对比和本地 MQTT 运动；[独立状态报告](../../output/lighting-bake/state-result.json)验证“可用 23 面→UI 改质量后已过期 0 面→Ctrl+Z 恢复 23 面→UI 清除后未烘焙 0 面→Ctrl+Z 恢复 23 面”。可用状态均实际绘制原 GI，运行时错误恢复为 null，原文件 SHA 不变，未启动新烘焙。分类和对比视图不写场景或撤销历史；清除撤销后仍保留上次操作提示文本，当前结果标签、资源和画面已经正确恢复。

- [x] **6. 保存重开、复制、撤销重做、SOURCE/DIST 及资源迁移保留字段与独立资产。**

  证据：Node 聚合实际覆盖复制/粘贴保留 `lighting`、新增静态副本使旧 GI 过期、撤销重做保留资产引用、SOURCE ZIP、DIST 复制与 URL 重写、另存为后移走原工程仍可读、恢复/重定位、摘要不符、Junction 和目标冲突回滚。最新 [Viewer 报告](../../output/lighting-bake/reopen/viewer-result.json)进一步证明正式 preload/IPC 导出、43 个光照资产的摘要及实际读取、独立 Edge 中的正确材质和升降回落。DIST 文件链单测替换 Electron 壳；正式 Web 导出已实测，但未执行真实中台上传或线上发布。

- [x] **7. 场景变更、取消、缺失资产及引擎失败不提交错误结果，不破坏原工程。**

  证据：Node 聚合覆盖迟到完成、过期签名、资源身份失配、原子应用、渲染验证期取消恢复旧状态、材质变更回滚及发布等待；[取消专项日志](../../output/lighting-bake/cancellation-tests.log)10/10 通过；真实 Cycles 集成覆盖进程取消、超时、提交前取消和预算失败；实际 UI 取消已操作。取消后立即重试等待原进程清理，窗口关闭会取消预约。真正任务失败不会被旧运行时诊断或后续 null 覆盖。应用期组合故障主要由 manager 聚焦回归证明，不将其写成所有故障均经过真实 GPU 注入。

- [x] **8. 聚焦测试、类型和构建通过，Editor/Viewer 画面、运动及正式性能证据完整。**

  证据：历史 22 文件聚合为 123/123，后续改动分别取得聚焦通过证据；最终 23 文件全集已重新执行，135/135 通过、退出码 0，96 文件 ESLint 零错误、退出码 0，最新完整构建通过。最新 Viewer idle/up/down 三态显示正常运行和本地 MQTT connected，23 个 GI 表面保持稳定；独立状态检查及正式工厂 A/B/B/A 均通过。最新整组证据独立保留，不用旧聚合代替新运行。

## 正式工厂 A/B/B/A

唯一正式结果为 [factory-only/factory-performance.json](../../output/lighting-bake/factory-only/factory-performance.json)，状态 `PASS`，`sourceUnchanged: true`。`factory-profile/factory-profile.json` 仅为 `DIAGNOSTIC`，不替代正式对照；此前加载不完整、远程大屏未隔离或缓存安全回退的工厂轮次保留为诊断历史，不用于收益结论。

条件：383 个实体、3913 个渲染网格，全部模型及环境就绪；Intel UHD 630 硬件 WebGL2，实际前台窗口，画布 840×567；四段使用相同相机和相同环境受光模式。GI 关闭，只比较实时阴影与混合静态阴影缓存。外部遥测和远程业务大屏/HTTP 被隔离，屏幕保留占位，仅放行固定版本 Draco 解码依赖。

| 顺序 | 模式 | 帧数 | 平均帧时间 | P95 帧时间 |
| --- | --- | ---: | ---: | ---: |
| A1 | realtime | 240 | 123.7242 ms | 139.7 ms |
| B1 | hybrid | 240 | 117.7079 ms | 145.2 ms |
| B2 | hybrid | 240 | 115.8829 ms | 141.0 ms |
| A2 | realtime | 240 | 124.3513 ms | 143.0 ms |

B 两段均含 798 个静态投射体、2812 个动态投射体和 3 个 CSM 级联；静态绘制计数均从 18 保持为 18，缓存命中各增加 720，缓存纹理占用 192 MiB。两段 A 的平均为 124.0377 ms，两段 B 为 116.7954 ms，本轮平均帧时间降低约 5.8%；P95 没有一致改善，整个场景仍约为 8–9 FPS，不据此承诺固定 FPS 或所有场景的性能收益。

| Windows GPU 进程采样 | Shared bytes | Committed bytes |
| --- | ---: | ---: |
| A | 3,271,839,744 | 3,586,396,160 |
| B | 3,224,662,016 | 3,689,488,384 |

这些是 Windows GPU **进程**级计数，包含该进程的全部资源，不是单场景 VRAM；与独立统计的 192 MiB 缓存纹理不能混为同一口径。

## 交付报告与结果口径

| 报告 | 本次可引用的结论 |
| --- | --- |
| `output/lighting-bake/electron-result.json` | 原总报告历史 FAIL 保留；其中真实分类/UI、取消、Cycles 应用、MQTT、保存重开与正式导出子阶段已经完成，失败在后续工厂检查 |
| `output/lighting-bake/reopen/electron-result.json` | 总报告历史 FAIL 保留；Editor 重开与最新 Viewer 子阶段完成，随后附带工厂加载被中止 |
| `output/lighting-bake/reopen/viewer-result.json` | 最新 Viewer PASS：23 面、43 资产、三态正常可见提示与实际 MQTT 升降/回落；44 次 ERR_ABORTED 均恢复，未恢复网络失败为 0，页面/控制台/GPU 错误为 0 |
| `output/lighting-bake/state-result.json` | 独立五态 PASS；两次撤销恢复原结果和真实 GI；源文件 SHA 不变，零新烘焙请求，Electron 退出码 0 |
| `output/lighting-bake/factory-only/factory-performance.json` | 正式工厂对照 PASS；条件、帧时间、缓存复用及进程内存口径见上表 |
| `output/lighting-bake/unit-final.log` | 已完成的历史 22 文件聚合：123 tests / 123 pass / 0 fail，退出码 0，236.36 秒 |
| `output/lighting-bake/unit-delivery.log` | 最新 23 文件全集：135 tests / 135 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo，退出码 0，246,157 ms |
| `output/lighting-bake/build-final.log` | 最新完整 TypeScript、Editor 和 Viewer 构建通过；保留构建器已有分包告警 |
| `output/lighting-bake/eslint-delivery.json` | 最终 96 文件 ESLint：0 errors / 91 warnings，退出码 0；告警包含新增测试和辅助文件中的非错误告警，并非全部既有 |

## 关键修复与可复用经验

- 复制实体最初遗漏 `lighting` 深拷贝，现已补齐，并验证复制使原静态 GI 过期而撤销重做仍保留独立资产。资源迁移只为输入与资产等价的结果迁移签名，不把旧失效结果重新签为有效。
- 应用候选结果后、画面验证完成前必须保留旧 GPU 状态。现已将最终确认纳入可回滚事务，避免取消恢复依赖重新读取旧文件。真正任务失败与运行时诊断分开溯源，后续轮询不能覆盖前者。
- 单网格空间分片先修复了跨页覆盖，又发现仅按面积估算图块会降低实际密度；最终使用世界尺度展开与逐三角 Jacobian 校验，超页继续二叉切分，保持几何及属性，并在预算不足时明确失败。
- Viewer 曾把加载期 GI 历史日志持续显示为当前错误。最终改为首帧就绪后查询当前诊断，错误恢复时移除；普通提示和控制台历史保留。最新 Viewer 验收增加可见提示断言，旧 PASS 报告不作为该项修复证据。
- 工厂检查先后发现 opaque DynamicTexture 被误作 alpha 深度输入、多 rendering group 导致保守回退。现已修复并取得真实 GPU 对照：普通多组复用每个面/级联的静态深度，各组动态继续追加；显式组间清深度仍按原生语义回退。
- 初次性能尝试存在自动远程大屏和解码依赖边界，现已在测试副本隔离业务网络、放行固定版本技术解码依赖，并要求全部模型就绪后才计时。诊断轮不替代正式 A/B/B/A。

## 测试入口与明确限制

当前 `test:lighting-bake` 为 23 个显式串行文件，package 与 manifest 的该项命令精确一致，23 个文件均已确认存在，不加入默认 core。独立 Cycles、阴影 GPU、材质 GPU、主 Electron、`reopen`、`factory-only` 和状态脚本的使用方式见[混合光照指南](../hybrid-lighting.md)。既有 `test:manual-roam` 与冻结清单的命令漂移未扩大修复范围，全库清单检查不能据此记为通过。

本次没有证明真实中台、生产 MQTT/HTTP、安装版 Viewer 或所有现场设备联调；本地 broker 仅证明已操作的消息与运动路径。工厂性能关闭 GI，不代表完整工厂 GI 质量或成本验收。自定义 shader、独立 opacityTexture、HDR 材质纹理及不同 U/V 寻址等边界以指南的实际支持范围为准；不承诺无限灯光、所有面光投影、固定 FPS 或总显存上限。
