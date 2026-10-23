# 统一材质与光照烘焙方案

## 目标、授权与基线

- 用户确认执行上一轮六步计划：以本次材质/间接光烘焙及动静混合阴影为唯一正式方案，移除旧光照控制和旧太阳阴影烘焙，完成后验证并展示实际效果。
- 保留必要的实时直接光、动态阴影、原材质、设备动作、现有分类/继承/例外，以及旧场景读取迁移和保存发布兼容。
- 工作树已包含前两轮未提交实现；基于现状增量修改，不重置、不提交推送、不上传生产。基线和八个动作/材质/引擎保护文件 SHA 存于 `output/lighting-unified/baseline.json`。
- 历史“保持环境原貌”选项在新方案中退出；环境统一接受场景照明。旧场景转换后光照需按新方案对照验收，旧太阳阴影不能充当 GI。

## 配置与责任边界

- `sceneSettings.lighting`：version 2，统一 main、fill、environmentIntensity、disabledLightIds、shadows、bake、policy 和 result。
- `sceneSettings.appearance`：version 1，独立背景、天空盒显示、曝光、对比度、色调映射、光晕与雾。
- 新配置存在时不再混读旧字段；旧 theme/shadows/lightingBake/lightingPolicy/lightingBakeResult 仅由共享迁移器读取。新保存只写统一结构，未知扩展字段保留。
- 主光/补光/HDR 的生命周期独立于阴影开关；混合阴影底层继续复用，旧太阳阴影 PNG 的生成及应用链路移除。
- 旧 v1 GI 缺少足以证明有效输入等价的完整戳，保留资源与原签名供核对，转换后标为过期；不自动重签或在打开时启动烘焙。新 v2 GI 仅在输入和资产严格等价时迁移。

## 顺序与范围

1. 共享纯合同、默认值、不可变幂等迁移及物理输入签名；先取得定向 RED。
2. 统一光照运行时与纯外观运行时，拆开灯光/阴影生命周期；移除主题隐藏灯和旧太阳烘焙执行路径。
3. SceneDocument/Serializer/Store 接入统一配置，管理器原子草稿及规则复制继续有效；首个覆盖旧场景的保存保留原文件备份。
4. 四页签管理器收口场景照明/显示效果与预设，移除旧场景面板和资源库点击/拖入的直接主题写入。
5. 保存/另存为/恢复/工程迁移/SOURCE/DIST/入口与非入口场景准备/Viewer 使用同一合同和独立资产规则，删除旧发布分支。
6. 聚焦回归、完整构建、审查及真实 Electron/Cycles/独立 Viewer；展示实际截图，更新指南和任务记录。

## 验收清单

- [x] 新场景默认统一配置；旧文件读取不可变/幂等、不自动写盘或烘焙；首次覆盖保存有原内容备份。
- [x] 场景属性、资源库点击/拖入和管理器不存在旧光照写路径；新文件不写旧字段。
- [x] 主光明确来自 managed 或场景方向光；关闭阴影仍有直接光；迁移保留原来有效的全局灯状态，不改变业务实体可见性。
- [x] 曝光/对比度/雾等显示参数不使 GI 过期；真实主光/补光/环境照明变化使 GI 过期；无隐含 IBL 上限覆盖。
- [x] 旧太阳阴影任务、生成器、结果应用及发布准备执行链移除；实时基线和错误恢复可用。
- [x] 分类、资源实例继承、批量例外、锁定、草稿/一次撤销、复制、设备动作和原材质保持正常。
- [x] 保存重开、另存为、迁移、SOURCE/DIST 和独立 Viewer 保留配置、扩展字段及资产；入口与非入口场景都使用新准备链。
- [x] 烘焙取消、失败、迟到结果、清除及撤销保留正确旧资源和状态；无伪造有效结果。
- [x] 真实编辑器操作、受控设备 MQTT 运动和独立 Viewer shader/资产检查通过，实际界面截图可复核。
- [x] 受影响测试、类型、构建、lint、独立审查和保护文件检查完成；文档与测试入口同步。

## 完成状态与实际证据

本轮实现与授权范围的本地验收完成。最后入口复核发现的两处天空盒旧强度输入已改为统一值摘要/管理器入口，并用真实 HDR 资源补验对象与场景两个属性入口。共享合同、runtime、管理器、持久化、实际 Editor/Cycles 和独立 Viewer 均有本轮有效证据，前两轮结果没有代替本轮验证。

| 验证范围 | 本轮结果 | 证据 |
| --- | --- | --- |
| 统一配置、迁移、Store 事务、物理输入签名 | 34/34 通过 | `output/lighting-unified/unified-tests.log` |
| 分类规则、管理器、继承、批量例外和规则资产 | 60/60 通过 | `output/lighting-unified/manager-regression.log` |
| 材质/间接光、取消回滚、实例、阴影、保存/SOURCE/DIST | 138/138 通过 | `output/lighting-unified/lighting-regression.log` |
| 外观、环境、天空盒、灯具、昼夜/雾 | 33/33 通过 | `output/lighting-unified/appearance-regression.log` |
| 完整 TypeScript、Editor 与 Viewer 构建 | 最后两处 Skybox UI 修正后退出码 0 | `output/lighting-unified/build-final-skybox.log` |
| 本轮相关文件 ESLint | 79 文件，0 错误、132 警告；包含最后四文件复验 | `output/lighting-unified/eslint-final.json` |
| 实际 Electron 完整闭环 | 15 项检查通过，页面/控制台/renderer 错误为空 | `output/lighting-unified/electron/electron-result.json` |
| 正式导出和独立 Edge Viewer | 6 项检查通过，全部 11 个 GI 资产实际读取 | `output/lighting-unified/electron/viewer-result.json` |
| 实际五态恢复 | 可用→过期→撤销可用→清除→撤销可用；实际 GI 9/0/9/0/9，源文件 SHA 不变 | `output/lighting-unified/state-result.json` |
| 最后 Skybox 入口复验 | 10 项 UI 检查通过；真实内置 HDR 加载，两个属性入口无旧输入、摘要等于实际统一强度并跳转管理器 | `output/lighting-unified/ui/electron-result.json`、`skybox-ui-run.log` |
| 清单、差异和保护文件 | 77 入口、缺失 0；diff 空白检查通过；8/8 SHA 与本轮基线一致 | `test-entries.log`、`diff-check.log`、`delivery-summary.json` |

上述四组主任务回归共 265 项，无失败、取消或跳过，测试文件不重叠。第一次运行统一入口时包含 5 文件、34 项；后来登记的第 6 个文件 `canonicalEnvironmentLighting.test.mjs` 已在 33 项外观/环境回归中执行通过，不重复计数。代理的其他批次有重叠，未额外累计。警告包含既有大文件、hooks 与测试类型用法，不宣称全部为既有。

实机使用 Intel UHD 630/ANGLE 硬件 WebGL2 与本机 Blender 5.2.2 CPU Cycles。实际取消高质量任务后重试，生成 9 个静态表面、108 个三角面、1 张图集、12 个探针、4 MiB 纹理。实际 UI 修改曝光到 1.35，运行时曝光生效，GI 签名、shader 激活及资源继续有效；撤销后恢复原曝光。关闭阴影前后实际灯光 ID/强度一致。

完整流程实际验证当前及复制新增资源实例继承规则，新增实例没有逐模型例外；跨对象暂存/应用/一次撤销、草稿放弃、Delete/Escape 隔离和 1024/1280/1440/1586 视口正常。实际本地 MQTT 提升动作运行，静态 GI 保持有效，静态阴影绘制不增加。Viewer 中两台同资源提升机按规则关闭固定部件接收阴影，实际 `receiveShadows` 和 shader 定义均为 false，其他资源固定部件仍为 true；升降/回落不改变静态 GI。

首次实际 IPC 保存将旧场景转换为新格式并产生 `.before-lighting-v2.<sha12>.bak`，原内容与备份的 SHA-256 完全一致。新文件外层 `version: 6`，新 reader 兼容 1–6；此版本保护避免旧版编辑器默默忽略新配置。旧 `lighting-v1` 结果保留原签名并明确过期，不重新签成有效结果。

实际效果截图：

- `output/lighting-unified/electron/editor-baked.png`：新管理器与实际烘焙结果。
- `output/lighting-unified/electron/manager-display-effects.png`：实际曝光调整后 GI 仍可用。
- `output/lighting-unified/state-1792546665370-d4492f38/06-lighting-controls.png`：统一场景照明控件与恢复后的实际 GI。
- `output/lighting-unified/ui/skybox-{object,scene}-managed-lighting.png`：真实 HDR 下的天空盒属性摘要及统一入口。
- Viewer 三态图片路径记录在 `viewer-result.json`。

## 边界、保留记录与收尾

- 本轮使用受控真实 glTF、临时本地工程和 loopback MQTT。未验证生产中台、现场 Broker、安装包或线上环境，未执行上传、生产部署、Git 提交或推送。
- 未重新运行完整工厂 GI 或 FPS 对照。原有缓存诊断 helper 已适配同一新照明路径下的缓存 off/on，但本轮只做语法/lint，不能据此给出新性能结论。
- 旧太阳阴影生成器、环境插件、接收分片/质量模块和旧主题运行时已删除；旧 Store 任务、主题控制写入口、发布分支及旧 smoke 已退役。对应旧功能测试由迁移、新照明、外观与混合阴影回归替代。原脚本副本保存在 `output/lighting-unified/retired-baseline/`；旧文件只读转换与必要的底层实时阴影仍保留。
- 初次构建的三处 SOURCE 类型收窄错误已修复；第一次状态 smoke 仍断言已删除任务为 null，按新合同改为明确检查旧任务字段不存在后重跑通过，历史失败日志/报告以 `before-request-assertion-fix` 保留，未改写历史状态。
- 最后追加仅涉及 SceneSettingsPanel/InspectorPanel 的 Skybox 强度控件收口及测试脚本，未改光照运行时；因此复用已通过的 Cycles/Viewer/五态行为证据，并对两处实际 UI、类型、构建和 lint 定向复验，未重复无关 GPU 分支。
- 并行清理时误删了已迁为新行为的同名环境测试，已保留为 `canonicalEnvironmentLighting.test.mjs` 并重跑 6/6；未删除新的材质身份、纹理、环境或动作回归。
- 为生成本轮测试清单，仅将既有 `test:manual-roam` 的 manifest 文本对齐现有 package 命令；未改其命令、代码或运行该组测试。inventory 生成及 `--check` 通过。
- 任务 Electron、独立浏览器、Cycles 子进程、动态端口和 bootstrap 均已释放，报告、迁移备份和测试工程保留供复核；用户其他服务和 Blender 会话未接管。
