# P3 核心模块渐进解耦执行记录

- 日期：2026-10-22；状态：P3.1—P3.4及最终本地验收完成。
- 依据：docs/project-optimization-plan.md 的 P3.1—P3.4；不进入 P4，不将 P2 未完成项改为已完成。
- 约束：画质/几何、参数化脚本、设备驱动、MQTT 消息语义/更新频率、Store selectors/命令历史、资源身份与授权保持兼容。动静合批仍默认 false。
- 入口保护：output/project-optimization-p3-20261022/baseline.json，1556 文件逐字节快照，既有未提交工作保留；没有提交、推送或外部发布。

## 验收清单

- [x] P3.1 六个规定领域 Controller 均落地；内部继续分出参数、阵列、宿主池、CAD、定位线框、变换等高内聚模块。状态由所属 Controller 持有，跨域依赖为明确的 Pick 能力；无 any 巨型上下文、动态混入或继承绕过。
- [x] P3.2 单一 Zustand Store 聚合六个 StateCreator Slice；234个状态/动作键无重复/遗漏，保留24个公开类型与原 selectors、命令历史和订阅语义。
- [x] P3.3 SceneViewPanel、ProjectPanel、EntityArrayThinInstanceBatch 拆出独立职责；参数变体宿主原本属于 SceneRuntime，实际迁入 ParameterVariantHostPool。
- [x] P3.4 统一 Electron 场景资源引用、字段枚举和副本改写；严格发布与宽容恢复分别保留契约，路径授权/身份/固定版本/烘焙/回滚由原调用方负责。
- [x] 全 src/electron TypeScript 核心文件最大2449行，SceneRuntime 725行，满足2500/<2000目标。
- [x] 最终 build/typecheck/lint、四个计划入口、P3专项、P2受影响回归全部通过。
- [x] 最终生产Editor交互与独立Viewer WebGL验证、完整性检查及本任务资源清理。
- [x] 计划勾选、任务记录和测试清单最终结算。

## 模块规模与行为证据

| 原文件 | P3入口行数 | 当前行数 |
| --- | ---: | ---: |
| SceneRuntime.ts | 10909 | 725 |
| editorStore.ts | 6418 | 21 |
| SceneViewPanel.tsx | 3445 | 2449 |
| EntityArrayThinInstanceBatch.ts | 2997 | 1564 |
| ProjectPanel.tsx | 2532 | 2168 |

计数统一按UTF-8源码换行分割，含末尾空行。新模块均小于2500行；主协调器维持公共入口、构造/帧/释放次序。

- Runtime：392个原方法仅进行所有者路径和回调receiver等价迁移；字段初值、公共签名和29个构造步骤一致。独立检查实际JS值导入图无循环，dispose逐语句一致；回调的普通function仍收到公共SceneRuntime，环境通知保持原裸调用，传给子运行时的原函数引用保留。
- 薄实例：63个类成员和86个函数/变量/type与入口一致，仅导出位置变化；矩阵、静态几何与材质、视锥计算独立，拾取与正负缩放/失败原子性有真实类回归。
- Store：六域为文档/历史、选区视口、资源库、中台/发布、光照、运行/遥测；105个helper动作体保留，必要注入仅CAD使用同实例api.subscribe及后台同步显式getState。跨域一次通知、撤销重做、会话失效及异步确认通过。
- 面板：194个Hook顺序、49个effect逻辑及13个搬移函数一致；新增26项依赖为恒定Ref或稳定stopOpening函数。ProjectPanel 170条非return协调语句一致，8种SSR宿主状态字节一致（使用控件替身，仅证明DOM/挂载顺序）。原CompositionLibrary已独立，当前没有OpeningPackage页签，没有新增产品入口。
- 资源：原strict/tolerant各498个变体结果/错误顺序一致，24个关键授权/重写/身份/烘焙/恢复函数原文保留。300条发布integration原断言保留并增加3条规范化/幂等强断言；30个私有探针迁移文件的1624条既有expected及消息保留。

## 验收中修复的明确问题

1. P3回调迁入Controller导致receiver变化：独立审查发现后恢复原公共实例，补真实实例回归，未改变回调参数或通知门控。
2. 天空盒身份预检顺序：入口旧实现实测在光照JSON迁移时执行自有dataPlatformResourceId getter 4次。DIST/SOURCE改为在迁移/克隆/通用扫描前，按descriptor定位并调用既有身份校验；own/inherited getter均0，健康资源进入原查询，拒绝文本/范围保持。
3. 浏览器MQTT条件导出：实际mqtt5.15.1浏览器包只有default，旧loader直接返回namespace导致mqtt.connect undefined。仅在导入边界规范化命名/default API并验证connect；保留原对象、lazy共享Promise与失败重试。MqttTelemetryClient、ConnectionTest和驱动未修改。最小复现先红后绿，真实包namespace身份核对和31项MQTT回归通过。
4. 旧验收夹具：发布v3输入必须先按正式保存链得到v6再检查字节稳定；非光照用例显式关闭烘焙；原false阴影开关接当前lighting路径。SOURCE overlay检查沿同一原子写盘persistedContent；均有入口快照实际旧实现复现，无原断言/阈值放宽。
5. WebGL夹具：旧v2省略sceneSettings，补正式默认设置；EngineStore探针接与产品一致的direct模块，避免P1桶预构建注册表分叉。模型/参数/驱动/helper生成器未改。调度器纯模块smoke禁用无关项目插件和依赖扫描，业务断言及进程关闭通过。
6. 原生TS导入：完整P2回归发现native strip将未标记type的别名当作运行时导出。追踪76项实际TypeAlias声明后在20个P3模块补显式type，独立复核20/20生成JS逐字节相同；原生动静合批98/98及完整P2 179/179通过。4个新增面板仅删除多余EOF空行，实际tsconfig输出4/4字节相同；入口已有buildTypeScript EOF空白未动。

## 验证与最终入口

- 新P3入口：npm run test:optimization-p3，覆盖Store/面板/资源/回调/薄实例及MQTT实际浏览器模块。
- 最终P3专项28/28，含MQTT真实浏览器模块3/3；现有MQTT传输专项31/31。
- 资源专项69/69、发布/光照31/31，getter修复后的公共/天空盒/SOURCE38/38；Store33/33，面板5/5及31/31契约；最终CAD3/3、Readiness9/9、retry5/5等。
- 完整integration分组exit0：发布主integration79项，含71,207,555 bytes/1,000,001 values大场景、绑定恢复及SOURCE/DIST四场景配置，全部通过。
- 实际Editor箭头：WebGL2 / Intel UHD630 / ANGLE D3D11，105次loopback MQTT publications，升降、双工位独立货物、动态避让、急停、断流、保存重开、窄屏通过，errors=[]。对应本轮正式smoke重新生成的成功输出，非旧文件复用。
- 独立DIST Viewer已通过真实MQTT/WebGL动作、故障急停断流与四种配置；生产Electron Editor35项通过，含Gizmo预览/取消/一次命令、实际资源页签/筛选、资源拖入与Ctrl+Z。已人工查看本轮截图。
- 生产静态视口与P2前帧同尺寸区域318,275像素逐像素一致，max/changed均0；仅对应该静态样例，不推导工厂FPS。

| 最终入口 | 结果 |
| --- | --- |
| npm run build / npm run typecheck | exit0；Editor/Viewer构建通过 |
| npm run lint | exit0；0error、152warning，存量规则收紧留P4 |
| npm run test:ci | exit0 |
| npm run test:integration | exit0；含完整发布、绑定及SOURCE/DIST配置 |
| npm run test:smoke | exit0；含容量、持久化、性能契约、Editor/Viewer实际WebGL |
| npm run test:lighting-unified | 42/42，exit0 |
| npm run test:optimization-p3 | 28/28，exit0 |
| npm run test:optimization-p2 | 179/179，0fail/skip/cancel，exit0 |
| npm run test:entries | exit0；79个既有manifest入口全部保留 |
| node scripts/generate-test-inventory.mjs --check | exit0；90入口、770文件，零漂移 |

四组规定入口完成后，最后仅有显式type与EOF空白调整；重新完整P2、typecheck/lint/build及入口检查通过。重建前后466份Editor/Viewer JS/CSS文件SHA逐一相同，生产Editor已验entry SHA仍一致，可复用上述实机验证而不将源码行号变化误认为运行版本变化。

## 证据与限制

- 发布integration的Electron退出原生I/O错误：将同4个真实renderer模块在Node统一预编译，Electron不再加载原生Rolldown；保留全部断言与实际退出码判断。隔离探针nativeAddons=[]、正式runner和完整integration均exit0。未声称定位到某个特定C++race。
- 全部原始成功/失败/中止日志保存在 output/project-optimization-p3-20261022；不得把中止或含失败总计的运行当作整套通过。
- 等价/审查：runtime-body-equivalence.json、runtime-contract-equivalence.json、p3-resource-compatibility.json、resource-getter-callchain-proof.json、integration-fixture-integrity.json、runtime-test-assertion-integrity.json。
- 最终命令：delivery-validation.json（passed=true）及其delivery-*.log；完整性/范围：protected-integrity.json、delivery-diff.json、scoped-diff-entry-check.json；实时MQTT：mqtt-real-browser-export.json。
- 最后修改等价：type-import-emission-proof.json、panel-eof-emission-proof.json、production-bundles-after-type-import-rebuild.json（466份、0变更）。18个关键生产源、116份资源225756283bytes及原场景SHA与入口一致；范围60既有修改+65新增、0删除。P3范围逐文件diff审计通过，全仓HEAD diff仍有入口原已存在的buildTypeScript EOF空白，未越界改写。
- 进程结算：process-cleanup-final.json记录本任务命令/配置目录匹配进程为空；既有::1:5173/PID24148保留，本轮未终止任何不相关进程。
- 本地SOURCE/DIST和loopback MQTT不等于真实中台部署/现场服务验收；P3未重新测量370实体工厂1440p/4K FPS，不宣称P2性能目标达标。
- 已有ScenePerformanceMonitor.lastSecAverage捕获警告保留，不把本轮动作/像素通过当作性能监控字段正确性的证明；其代码未在本阶段修改。
