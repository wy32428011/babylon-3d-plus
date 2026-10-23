# 任务记录

## 2026-10-23 动态货物模板预取 Git 交付

- 已拉取远端，当前分支无需额外合并；将本地生成器模板预取、就绪接线及相关文档和用例纳入提交。
- 本次按用户要求不运行测试、构建或代码验证；原实现阶段的验证记录及未验证边界保持不变。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 动态货物模板启动预取（本地验收完成）

- 用户授权仅实现启动预取与预解码，复用既有模板缓存，保留画质、参数化脚本和动作逻辑，不提交或推送。
- 新增纯模板预取 lease 与生成器目标协调器；连接默认/规则/组合成员、加载进度、Editor/Viewer 首帧门控及配置/场景释放。组合阵列源继续独占 Geometry，但复用模板解析缓存。
- 专项42/42、设备交接122/122通过；准备/回调组38/39，旧Sandbox加载失败日志receiver断言已在修改前HEAD复现，单列保留。最终typecheck、Editor/Viewer build、定向lint和独立审查通过，观察者异常不会再覆盖模板句柄或阻断准备。
- Intel UHD630硬件WebGL：首次生成读取解码增量1→0，真实输送机交接身份/连续性/点击宿主及脚本动画隔离通过，固定首件与交接末态像素一致；初始夹具失败记录保留。测试资源已回收，脚本/驱动/public无修改，不宣称现场FPS、现场MQTT或导出DIST验收，不提交推送。
- 验收清单和后续结果见 [本轮执行记录](tasks/2026-10-23-generated-cargo-preload.md)。

## 2026-10-23 阵列与动画帧开销 Git 交付

- 已快进合并远端 0.4.0 版本及输送线排队、换层提升机互锁更新，恢复本地阵列负间距与动画帧开销优化，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；历史验收记录不代表合并后版本已重新验证，原有未验证边界保留。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 动画帧开销优化（本地验证完成）

- 已授权优先优化运动节点平方级过滤及阵列刷新后的重复光照几何摘要；画质、脚本、动作和遥测频率保持。
- 保留真实光照失效和异步新增网格事件，避免漏掉未知脚本的跨模型或原位修改；以精确缓存复用摘要。
- 相关回归198项通过，新增缓存覆盖率100%行/93.33%分支；TypeScript、Editor/Viewer构建和定向lint通过。硬件WebGL六姿态零像素差，既有编辑器MQTT/保存重开/取货/断流验证通过。
- 独立审查问题修复并复验；16MiB快照预算、精确原位检查和GC释放通过，19份保护文件SHA不变，无自有进程残留。原阵列测试解析缺口与现场450ms/FPS未验证边界保留，未提交推送/发布。
- 验收与证据见 [执行记录](tasks/2026-10-23-animation-frame-cost.md)。

## 2026-10-23 Git 同步交付

- 已快进合并远端设备交接与换层修复，恢复本地光照、性能治理、模块解耦及预览发布改动，无合并冲突。
- 本次按用户要求不运行测试、构建或代码验证；历史验收与未完成项维持原记录，不代表合并后版本已重新验收。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-22 P2-R0 计量校准与 B0 基线（本地验收完成）

- 修复缺失/未采样 counter 假零和 null 格式化，新增真实 afterRender 固定墙钟窗口；生产仅 6 个诊断文件改变，726 个其他生产源与 public37份逐字节不变，画质/参数脚本/设备算法保持。未进入 R1，旧 OFF 钩子仍在。
- 完整冻结 1797 源+826构建文件，8×60秒硬件WebGL2/DPR1有效 B0；两套原始时间线帧数/FPS精确互核。动作 FPS 为1440p 5.917、2160p 4.500，原 ready/预热门槛保持；不作15%/30%收益结论。
- 定向34/34、typecheck/lint/build、入口91无缺失、P4分类9/9、CI798通过+1外部EXR条件SKIP；inventory零漂移。额外observability首项Sandbox fetch failed已在入场前像复现，单列未通过，未压错。
- Viewer真实UI自然unknown→有效样本、复制与关闭通过；原生节点另实例核对140根/3440节点，静态前后零变化、动作33已有节点变化。原stale后仍有1输送货物根移动/4节点仅缓存世界矩阵变化（2项父链关系未证），按原逻辑保留；缓存稳定不等于全场停止。
- 未来JS同条件110%、新增buffer64MiB、新纹理0及全局4下载/2校验/4包、256MiB pending/1GiB staging/512MiB独占source预算已冻结；JS采样下界、buffer快照、纹理/真显存未知边界保留，真实中台与6设备完整轨迹未验收。
- 旧历史与原始失败保留；完整源/构建/输入/harness指纹及自有进程结算已核对，无提交/推送/外部发布。详情见 [P2-R0执行记录](tasks/2026-10-22-project-optimization-p2-r0.md)。

## 2026-10-22 P2 方案重设计（仅文档完成，代码待授权实施）

- 按用户要求更新 `docs/project-optimization-plan.md`，保留已完成的编译缓存、FIFO 调度、包流水线、矩阵/Gizmo 能力与 P1/P3/P4 状态；原专项二设计和 P2 清单原文折叠保留，旧未通过项目不补勾，历史 P2 执行记录和采样摘要未改。
- 新增待执行 P2-R0～R5：冻结版本/计量、真正无机制 OFF、默认 CPU 热点、完整加载关键路径、受限几何聚合试点、整阶段默认版本验收。纠正总 Mesh/Active 口径，区分旧 OFF、无机制 OFF、同 build ON 及最终默认版本的收益。
- 明确未来目标与统计：持续动作两分辨率帧间隔 P50 各降至少 15%、有效 FPS 同向提高，尾延迟预定 5% 性能噪声带；真实中台冷/暖中位各降至少 30%，至少 5 次原始值与观测最慢保护。画质、脚本生命周期、参数/环境快照、MQTT 顺序和动作频率保持；原数据不作当前性能或收益承诺。
- 本轮仅编辑计划与本记录，做文档内容/链接/命令名称/历史字节与范围检查；未修改代码、测试、配置或运行 benchmark/build/功能测试。修订前副本及文档验证保存在 `output/project-optimization-p2-redesign-20261022/`；所有新阶段未开始实施，真实性能仍待后续验证。

## 2026-10-22 GLB 标准预览与默认环境照明（执行中）

- 用户确认实现预设与默认环境，普通/环境模型均支持，保留已有场景，并用展会 GLB 验证保存重开及本地发布。计划与验收见 `docs/tasks/2026-10-22-glb-standard-preview.md`，工作区基线见 `output/glb-standard-preview/baseline.json`。
- 已先取得合同、预设草稿与异步环境回归 RED；共享配置及 Sandbox 基线 helper 已实现，旧配置缺字段保持原有行为。后续运行时、真实 UI 和保存/发布验收执行中，尚未宣称完成。

## 2026-10-22 P4 类型安全与测试治理（本地验收完成）

- 实际入场18项未使用诊断清零，两个正式tsconfig启用noUnusedLocals；ESLint152→0 warning、0error，四项关键正确性规则error。保留getter/异常求值、Hooks门控、脚本/遥测/设备动作及画质。
- 301候选逐文件分类；160份Node契约接六领域159命令全部通过，87条manifest入口无缺失、inventory777文件/692候选/98入口零漂移；139项环境/人工候选未整体执行，另2项为辅助工具，不以分类代替通过。
- 最终build/typecheck/lint、CI、integration/smoke及六领域全部exit0；P4 9/9（含22项实际DOM）、巡检48/48、P2 179/179、P3 28/28、统一光照42/42。真实Electron Editor35项、loopback MQTT/保存重开、SOURCE/DIST四配置和独立Viewer通过；固定静态ROI318275像素changed/max0。
- SSR改真实模块图构建，原assert/门槛保留；旧夹具先用入场产品/既有文档独立证明后修正，原始失败及所有重试保留。独立审查无阻断，18关键源12同字节/6已审质量改动，116资源225756283bytes及场景/回放保持。
- 入场1667快照保留，范围diff与资源结算完成；用户原5173服务保留，无提交/推送/外部发布。CI既有1个外部EXR条件SKIP不计通过，构建大chunk提示及既有lastSecAverage监控warning保留（源码未改）；没有重测或声称工厂FPS提升，P2总验收未完成且合批缺省false。
- 详细命令、证据及限制见[P4执行记录](tasks/2026-10-22-project-optimization-p4.md)。

## 2026-10-22 P3 核心模块解耦（本地验收完成）

- 完成 Runtime 协调器/领域 Controller、六个 Zustand Slice、面板/薄实例子模块和 Electron 公共资源遍历。核心最大2449行，SceneRuntime由入场10909行降至725行；保留公共签名、234个Store键、命令历史、构造/帧/释放顺序。
- 最终build/typecheck/lint、test:ci、test:integration、test:smoke、test:lighting-unified全部exit0；P3专项28/28、P2回归179/179、统一光照42/42。lint 0error/152warning；79个既有manifest入口无缺失，inventory90入口零漂移。
- 实际生产Editor35项、SOURCE/DIST四配置、独立Viewer WebGL及loopback MQTT通过；静态视口318275像素changed/max均0。最后类型标注/新增文件EOF修正的JS等价及重建466份JS/CSS字节一致，实机证据对应最终运行版本。
- 修正Controller回调receiver、资源身份getter预检顺序、MQTT浏览器default导出兼容及原生TS类型导入；旧夹具按真实保存/渲染契约对齐，303条发布assert和1624条私有探针expected/message保留。发布测试的原生编译在Node隔离，Electron实际退出码仍严格传播，历史失败日志全部保留。
- 入场1556文件快照保留，18份关键源与116份资源225756283bytes、原场景SHA保持。P3范围125文件diff审计通过；入口已有buildTypeScript EOF空行未动。任务进程无残留，保留用户5173服务，没有终止不相关进程。
- P2整体性能目标仍未验收，动静合批缺省false；未进入P4，未重测工厂FPS或真实中台/现场服务，未提交、推送、外部发布。详细状态、证据及限制见[P3执行记录](tasks/2026-10-22-project-optimization-p3.md)。

## 2026-10-21 项目专项优化 P2（部分落地，整阶段未验收）

- 按 docs/project-optimization-plan.md 推进P2；完整清单、源码与失败/最终证据见 docs/tasks/2026-10-21-project-optimization-p2.md。入场1628文件SHA/字节副本保留，P1与其它存量未提交修改保留，未提交、推送或发布。
- 落地实际TS内容/编译器版本的HMAC持久转译缓存、FIFO分帧宿主初始化、按包有界下载/校验流水线、受控矩阵冻结、Gizmo运行时预览和结束一次命令。原授权/签名/版本/原子推广及回滚保留，参数脚本及动作算法未改。
- Profile定位重复几何canonical；缓存保持原算法和精确CPU检查。真实680环境surface因内部Hybrid包装持续cache miss，新增同Geometry/函数双弱键delegate登记；3消费者仅import+4登记，去除后与入场字节一致，回调body/receiver/顺序/异常/释放不变。相关26+17+98共141通过。
- 新动静合批保留业务原件/层级、照明/阴影/选择身份及公开GPU上传同帧归还；实机仍有负收益，motionStaticBatchingEnabled缺省false，实验API保留。新增默认/开启/关闭恢复回归，原6项继续显式开启，不绕功能断言。
- 最终build/typecheck/lint/test:ci通过，P2聚合179/179、0skip/cancel，lint0error/182存量warning。真实Gizmo30项、生产Editor/独立Edge Viewer及16包对照证据保留；16包12PASS/原4FAIL同数值，166PNG配对中142非时间动画逐字节一致；最后环境缓存由canonical等价回归及最终工厂GPU对照覆盖。
- Intel UHD630/D3D11/WebGL2、DPR1、同370实体/322模型实体/17GLB与原录制，两分辨率各OFF/ON/ON/OFF 4×60秒、每段1222消息。1440p默认OFF/实验ON中位FPS5.743/2.900（实验−49.50%）；4K4.324/2.676（实验−38.12%）。本地1440p应用冷/暖83.820/84.901秒，4K冷83.276秒，未清OS文件缓存，不替代真实中台30%或完整P1基线。
- 同源姿态/三角形保持，真实VertexBuffer.updateDirectly后source绘制1/旧carrier0，非DynamicTexture区域RGBA完全相同；固定截图原容差通过。计时后分桶910候选/729桶/706单例/728种几何内容，仅23共享桶覆盖204原件，当前镜头净少约5draw，不能删几何条件追指标。
- 跨会话参数几何模板、单同步onStart<50ms、P2.3默认收益、Draw<400/Active<1000、真实中台冷暖30%和所有设备轨迹100%仍未完成/未验收；P2.3及P2总验收不勾选，P3/P4未进入。原始失败与最终日志在 output/project-optimization-p2-20261021/，未改真实中台。

- 最终收口：inventory89入口零漂移、test:entries/diff通过；16关键源码SHA与116资源/225756283bytes、原场景字节保持，任务进程无残留且未终止不相关进程。最终仅去除SceneRuntime一空白行2空格，输出JS逐字节相同，复用已完成的179回归与GPU证据（whitespace-emit-proof.json）。

## 2026-10-21 项目专项优化 P1（本地完成）

- 按 `docs/project-optimization-plan.md` 推进并勾选 P1.1–P1.3；执行及验收记录为 `docs/tasks/2026-10-21-project-optimization.md`，入场工作树 SHA 和副本在 `output/project-optimization-20261021/`，保留此前未提交改动。
- 完成同名 JS 守卫、Babylon 深层/兼容惰性 namespace、原 glTF1 和 glTF2 全扩展、Node 预转译与校验 sidecar、MQTT/重型弹窗/DXF 按需加载及 shader 合并。源码 TS 不改写，SOURCE/DIST 原字节与资源签名边界保留。
- 当前 Editor/Viewer initial JS 5,280,709 / 4,295,252 bytes，相对文档基线下降 50.1% / 55.9%；入口 3.77 / 3.70 MB，DXF 和两个 shader chunk 均 deferred。全量 JS 14.66 / 13.69 MB，首屏收益不代表安装包同比缩小。
- 最终完整构建、类型检查、`test:ci`、`analyze` 通过；P1 专项 84/84；lint 0 error、182 warning；inventory 零漂移、78 个登记入口零缺失。修复旧 SOURCE/阴影 fixture 及真实打开授权竞态，保留 19/27/16 项相关断言；普通本地自动远端同步误报另有 7 项回归。
- 最终实际 Editor 完整打开、三个 lazy 弹窗及独立 Edge Viewer 联合 PASS；Intel UHD630 / ANGLE D3D11 / WebGL2，Viewer 1440×900/DPR1，同脚本双实体仅一份 sidecar、无 renderer TypeScript/MQTT 请求、无页面错误。较早只等待脚本 marker 和两个 harness 失败记录保留，以最终 `production/result.json` 为准。
- 16 包视觉预转译/原 TS 均 12 PASS、4 FAIL，完整 Babylon 注册对照复现同四项且 22 PNG 字节相同；未改门槛。其余 19 张 LED/YZJ 时间动画差异保留，未宣称全部像素一致。四项当前运行时/阈值问题进入 P2 复核，不能称本轮引入或 Git HEAD 历史缺陷。
- P2–P4 尚待后续实施；未测工厂 FPS/冷暖打开收益或真实中台/现场 MQTT/安装包，未提交、推送或发布。10 个受保护关键文件入场 SHA 不变；旧窗口需重启加载本地主进程更新。原 `tests/buildTypeScript.test.mjs` 的 EOF 空白提示仍保留，未扩大清理。

## 2026-10-21 场景格式 v6 打开与发布兼容（完成）

- 用户反馈打开场景 67% 处报 `data-platform:prepareLocalSceneResources` / `场景模型更新格式无效。`；既有合法夹具仅改为 version 6，在真实 Electron 精确复现。
- 修复五处遗漏版本门禁；编辑器、资源授权/恢复、工程包、SOURCE/DIST 和发布准备共用 `sceneFileVersion`，只接受数字 1–6。光照打开/保存预处理新增未知版本验证，不能将 7 或字符串版本洗成 6。
- 完整类型/Editor/Viewer 构建通过；15 份生产文件 ESLint 0 错误、25 警告，只读代码审查无 P1/P2。31 项版本/本地恢复/光照资产测试、32 项发布测试通过；实际 Electron 本地资源同步 30 项检查、SOURCE 工程包 v1–6/未来版本/原文件保护回归通过。
- 统一光照入口回归 42/42 通过（含与 31 项组重叠的两项版本测试，不重复累计）；清单检查和 diff 检查通过。既有测试只按已确认迁移/来源隔离合同更新旧预期，业务字段仍严格比较。
- 实际配置本地接口后，首页打开 v6 与工具栏打开 v5 分别进入新场景会话、资源准备 100%、真实模型首帧；两次 local-latest 均携带 6、configured=true、models=1，HTTP 详情和 GLB 下载实际执行，原场景字节保持。Intel UHD 630 实际渲染，页面与控制台错误为 0。
- 计划和证据索引见 `docs/tasks/2026-10-21-scene-format-v6-compat.md`、`output/scene-open-v6/`；任务应用/本地服务已退出，保留工程及截图。主进程需用户重启旧窗口后生效，未关闭用户实例，也未对原用户场景/真实中台作验收。保留所有前序未提交修改，没有修改用户场景、上传或 Git 操作。

## 2026-10-21 统一材质与光照烘焙（完成）

- 用户确认以新材质/间接光烘焙与动静混合阴影为主，移除旧控制、主题光照接管和旧太阳阴影烘焙，保留实时照明、动作、材质与旧场景迁移/保存发布兼容。
- 最后入口复核的两处 Skybox 强度控件已改为统一值摘要和管理器入口，真实 HDR 对象/场景属性两分支及原有 UI 共 10 项复验通过，实际强度不受旧资源字段覆盖。
- 计划及十项验收见 `docs/tasks/2026-10-21-unified-lighting.md`；基线、root 主要文件副本及八个保护文件 SHA 已记录在 `output/lighting-unified/`，不覆盖前两轮未提交改动。
- 已完成唯一 `lighting v2` 与独立 `appearance v1`；旧五组字段只读迁移，新保存外层格式升 6，新版兼容读取 1–6，避免旧编辑器忽略新光照配置。首次覆盖旧文件产生原字节哈希命名备份，旧 v1 GI 明确过期待重烘焙。
- 旧太阳阴影生成/贴图应用、旧主题光照运行时、旧 Store 写入口和发布分支已删除；管理器统一场景照明与显示效果，光照/显示预设只暂存草稿。主光生命周期独立阴影，曝光等纯显示调整不使 GI 过期；昼夜能力使用显式选项并保留迁移前有效状态。
- 主任务四组回归 34+60+138+33，共 265 项通过、无失败/取消/跳过；最后 Skybox UI 修正后完整 TypeScript/Editor/Viewer 构建通过；79 文件 ESLint 0 错误、132 警告。新登记环境 6 项已包含在 33 项组内，不重复累计；代理重叠检查未另加总。
- 实际 Electron 15 项、正式独立 Edge Viewer 6 项全部通过；Cycles 实际生成 9 表面、1 图集、12 探针、4 MiB，真实本地 MQTT 升降不破坏静态 GI。实际曝光 1.35 生效且 GI 签名/shader 保持；阴影关闭时灯光保持。
- 实际 IPC 保存的迁移备份与原场景 SHA 完全相同；保存重开及全部 11 个导出 GI 资产读取、规则 shader 生效通过。五态清除/撤销恢复通过，GI 数量 9/0/9/0/9，源文件不变；页面、未恢复网络和 GPU/shader 错误为 0。
- 统一证据为 `output/lighting-unified/delivery-summary.json`、四组测试日志、`build-final-skybox.log`、`eslint-final.json`、`electron/{electron-result.json,viewer-result.json}`、`state-result.json`、`ui/electron-result.json`。77 个入口无缺失，8 个保护文件 SHA 与本轮基线一致，diff 检查通过，指南/README/inventory 已更新。
- 首次状态脚本仍检查已删除任务为 null 的历史失败已保留，按新字段不存在合同修正并重跑通过。并行旧名清理时的新环境回归已恢复到 canonical 新文件名并验证，未丢弃新行为覆盖。
- 未执行生产上传/部署、Git 提交推送、安装包、现场 Broker 或真实中台验收；本轮未重新做完整工厂 GI/FPS。测试应用/浏览器/子进程/动态端口已释放，保留测试工程、备份及实际效果截图；十项验收和完整边界见任务记录。

## 2026-10-21 集中式光照与烘焙管理器（完成）

- 用户确认按集中管理方案和三张 UI 图执行；当前场景内统一管理全局参数、复用规则、对象/部件例外和任务资源，保留前一轮全部未提交混合光照改动。
- 计划与验收清单见 `docs/tasks/2026-10-20-lighting-manager.md`；基线及动作/渲染/引擎保护文件摘要已存 `output/lighting-manager/baseline.json`。
- 完成四页签集中管理器及摘要入口，支持场景默认、资源/类型/分组规则、固定/运动/稳定部件策略、影响预览、搜索筛选、批量例外和恢复继承；旧配置保留，同资源现有/新增实例自动继承。临时生成部件只经集中规则配置，避免把例外误写到宿主。
- 草稿统一应用、一次撤销，带场景会话/文档版本及锁定保护；真实视口快照不新建 Scene，关闭释放采样，已有后台任务继续。SOURCE/DIST 按实际资源身份迁移规则，保留扩展字段，不重签已过期 GI。
- 本轮最终回归 56/56 管理器、135/135 混合光照、10/10 构建检查，合计 201 项通过；完整 TypeScript/Editor/Viewer 构建通过，39 文件 ESLint 0 错误、74 警告。修复增量产物残留 TS 导入的启动错误，真实 Node 加载和扩展回归通过。
- 最新实际 Electron 完成规则、复制继承、批量例外/撤销、草稿及键盘保护、1024/1280/1440/1586 视口、取消重试、保存重开及本地 MQTT。Cycles 实际生成 9 表面、1 图集、12 探针、4 MiB；静态阴影绘制 48→48，GI 随运动保持有效。
- 正式导出独立 Edge Viewer PASS：全部 11 个光照资产实际读取；两台无逐模型例外的同资源实例按集中规则关闭固定部件接收阴影，实际 shader 定义一致，其他资源仍开启。页面、未恢复网络、GPU/shader 错误为 0。
- 五态 UI PASS：可用→已过期→撤销可用→清除未烘焙→撤销可用，实际 GI 数量 9/0/9/0/9，源场景 SHA 不变。证据为 `output/lighting-manager/{manager-tests.log,lighting-regression.log,build-tests.log,build-final.log,eslint-final.json,state-result.json}` 与 `electron/{electron-result.json,viewer-result.json}`。
- 3 个入口与 manifest 精确一致，8 个动作/材质/阴影/引擎保护文件 SHA 与本轮基线一致，diff 空白检查通过。参考图布局与实际最终截图已复核；早期验收脚本失败记录保留，最终结果来自重新完整运行。
- 使用说明已更新 `docs/hybrid-lighting.md` 与 README；九项验收及验证边界见计划。本轮没有重新测完整工厂 GI/FPS，也未验证真实中台、现场 Broker、安装包或生产环境；未上传、发布或提交推送。任务应用/浏览器/动态端口与 bootstrap 已释放，保留报告和测试工程。

## 2026-10-20 材质烘焙与动静混合阴影（完成）

- 完成本地实现与授权范围验收；保留现有编辑器外壳及旧 baked/realtime，hybrid 显式启用。使用说明 `docs/hybrid-lighting.md`，原计划八项验收及分层证据见 `docs/tasks/2026-10-20-hybrid-lighting.md`。
- 场景“光照与烘焙”、对象“烘焙与阴影”支持实际驱动分类、稳定子节点覆盖、批量设置、分类轮廓/部件定位、进度取消、运动和前后对比。动态图形正常运动保留静态 GI；静态输入变化使结果过期，撤销及清除恢复已实机验证。
- 本机 Blender 5.2.2 CPU Cycles 实际生成独立 UV、间接光图集与探针；运行时保留直接光、源材质和反射。单大网格按世界尺度分片跨页，实际 128 px/m 夹具得到 23 片、19 图集、76 MiB，64 MiB 预算明确拒绝；不自动降密度凑预算。
- 阴影先合并静态/动态深度再过滤，方向/点/聚光覆盖四种遮挡关系。最新多渲染组 12 构型、84 状态与原生完整实时像素差为 0；正常缓存稳态不重绘静态，定制组间清深度保留正确实时回退。
- 保存/另存为、复制、撤销重做、工程迁移、SOURCE/DIST 与恢复均接入独立资产及摘要校验。取消、迟到完成、资源失配、超时和应用失败保留旧结果，不把过期输入重新签为有效。
- 实际 Electron 完成取消重试、生成应用、本地 MQTT 升降和保存重开；最新正式导出 Viewer 三态 PASS，23 个 GI 表面、43 个资产实际读取、shader/颜色与升降回落稳定。44 次初始化 ERR_ABORTED 全部恢复，未恢复网络失败、页面及 GPU 错误为 0。独立五态 UI 及两次撤销恢复 PASS，原文件未变。
- 正式工厂 A/B/B/A PASS：383 实体、3913 网格、840×567 画布、Intel UHD630 硬件 WebGL2，真实前台固定相机与同受光材质。四段平均 123.7242/117.7079/115.8829/124.3513 ms，P95 139.7/145.2/141.0/143.0 ms；两段混合静态绘制均 18→18，各命中 720 次，798 静态/2812 动态/3 CSM，缓存 192 MiB。原工厂 SHA 不变；本轮平均帧时间下降约 5.8%，P95 无一致改善，整场仍约 8–9 FPS。
- Windows GPU 进程 Shared A/B 为 3,271,839,744/3,224,662,016 bytes，Committed 为 3,586,396,160/3,689,488,384 bytes，包含进程全部资源，不能当作单场景 VRAM。工厂对照关闭 GI、隔离远程业务网络，仅放行固定版本 Draco 技术依赖，不证明完整工厂 GI 或生产服务联调。
- 最终 `npm run test:lighting-bake`：23 文件、135/135、无失败/取消/跳过、退出码 0；96 个相关文件 ESLint 0 错误、91 警告；完整 TypeScript/Editor/Viewer 构建与真实 Cycles 集成通过。新测试入口与 manifest 精确一致；既有 test:manual-roam 命令漂移未扩大修复范围。
- 最新证据为 `output/lighting-bake/{unit-delivery.log,eslint-delivery.json,build-final.log,cycles-final.log}`、`reopen/viewer-result.json`、`state-result.json` 和 `factory-only/factory-performance.json`。原 main/reopen 总报告的历史 FAIL 保留，引用已完成子阶段及独立最终报告，不改写历史。
- 未执行真实中台上传、生产发布、安装包/现场环境验收或 Git 提交推送。测试应用、浏览器、回放和动态端口服务已关闭；保留用于复核的报告和临时工程。以下同主题追加小节是实施阶段历史，最终状态以本节与最终验收记录为准。
- 收尾删除本次生成的 `electron/lighting-bake/__pycache__/cycles_bake.cpython-313.pyc` 被自动审批拒绝，理由仅为 `blocked by policy`；未改用其他删除方式，该未跟踪缓存文件保留。只读核对确认无本次 Electron/浏览器进程及根目录 smoke bootstrap 残留。

## 2026-10-20 提升机运动箭头 Git 交付

- 已快进合并远端货格留存货物开关、直角接驳中心线落点相关更新，恢复本地提升机运动箭头改动，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；原实现阶段记录不代表对合并后版本重新验证。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-20 Git 同步交付

- 已拉取并快进合并远端设备驱动更新，保留本地 Overlay 与巡检辅助标记优化，无合并冲突。
- 本次按用户要求不运行测试、构建或代码验证；下方原实现阶段的验证记录不代表对合并后版本重新验证。
- 使用中文标题和四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-19 按性能指南检测与外围优化

- 需求：按照 `babylon-perf-guide.md` 检测优化，保证参数化脚本和动作逻辑不变。用户选择复用现有大场景。
- 范围：仅优化 `DataPlatformScreenOverlay` 的同帧投影/临时对象/DOM 样式，以及 `EditorAutoPatrolRuntime` 的编辑辅助标记缩放和矩阵失效检查；不改画质、资源、消息顺序或动作频率。
- 计划与完整章节核对：`docs/tasks/2026-10-19-babylon-perf-guide.md`、`docs/babylon-perf-guide-audit.md`。
- 已验证：前后完整构建成功；新增定向测试 7/7；Electron 硬件 WebGL 正反向检查；36 屏生产 WebGL A/B/B/A，三视角截图全部一致，点击/尺寸/隐藏恢复/卸载通过；36 个受保护文件 SHA-256 全部一致。
- 已测收益：120 屏投影 DOMRect 240→2、稳定样式写 720→0；501 个巡检编辑标记静止 300 帧的缩放写入与世界矩阵更新 150300→0。36 屏相机移动时 Overlay 平均耗时 3.917→1.787 ms，两版约 60 FPS。
- 限制：旧 Vite SSR 入口部分导入超时，未完成断言不算通过。工厂首次优化版采样与 ESLint 重叠，已作废该轮性能数据并单独重采；完整加载和 iframe 功能检查成功。
- 最终回归：遮挡与跨域点击 12 项、透明标牌 9 项、巡检编辑真实操作 7 项均通过且无页面错误。巡检覆盖新增/覆盖、不同高度、聚焦和保存重开相机恢复。
- 工厂有效对照：相同场景/资源/视角/回放，1440×900、DPR 1、Intel UHD 630；单轮 15 秒静止 21.27→21.79 FPS，动作 18.42→18.74 FPS，后者均接收 290 条回放消息。P95 分别 57.2→54.2 ms、66.9→67.3 ms；单轮结果不支持稳定整场 FPS 提升或达到30/60 FPS的承诺。
- 当前状态：本轮检测、两项外围优化与针对性验收完成；全部记录见 `docs/babylon-perf-guide-audit.md`，证据保存在 `output/playwright/perf-guide-20261019/`。已释放本任务应用、浏览器和本机回放服务；未安装、发布、提交或推送。

## 2026-10-19 场景模型面数统计

- 目标：按已确认示意图，在场景属性“场景”分组的名称后加入模型总面数与可展开明细。
- 范围：普通/内置/组合模型、完整逻辑实例、环境、实际生成货箱；包含隐藏实体，排除编辑辅助、天空盒与线点；不随相机裁剪变化。
- 实施：运行时按业务登记计算并缓存有效几何，非持久化快照传递到面板；明确 loading/error，避免部分结果冒充总数。
- 验收清单：
  - [x] 12 面立方体、10 个立方体 120 面及阵列/变体计数正确，无宿主重算。
  - [x] 隐藏实体/父组、移动相机/裁剪后总数稳定；参数/环境/货箱/删除撤销自动更新。
  - [x] 三角形拓扑与线点/辅助排除正确；加载/错误/切换场景无误导性旧值。
  - [x] 按示意图实现总数与明细，实际浏览器操作验证、窄面板无溢出。
  - [x] 统计不影响 dirty/undo/序列化；定向测试、类型检查与相关文档完成。
- 当前状态：原实现阶段验收记录见下；2026-10-19 已合并远端更新，进入 Git 提交推送流程。本次交付按用户要求不运行测试、构建或代码验证；推送结果以本次交付回复为准。

### 修改与验证

- 面板：新增 SceneModelStatisticsPanel 与样式，在场景名称后挂载；说明与明细支持键盘，整数支持选择复制，加载/失败不展示部分总数。
- 数据：EditorStore 增加非持久化快照，SceneViewPanel按运行时与场景会话校验写回，同ID重开也主动发布首份结果。
- 计数：新增三角拓扑助手，SceneRuntime按逻辑实例、参数变体、生成物、Fetch实际货物和环境汇总；事件驱动缓存/微任务合并，不注册逐帧计数。环境与Fetch统一口径；特效代理使用源Mesh唯一ID避免重名误配。
- 文档：README说明入口与口径；docs/lessons.md记录全量与裁剪、同ID新会话快照两项经验。
- 新增回归：UI 4、状态 3、几何/环境 7、Fetch 6、核心运行时 11，共31项通过；相关既有加载就绪9、模型特效21、Fetch7项通过。
- 主线程组合命令：node --experimental-strip-types --test --test-concurrency=1 tests/runtime/modelTriangleStatistics.test.ts tests/runtime/locatorFetchTriangleStatistics.test.ts tests/editor/sceneModelStatisticsState.test.ts tests/editor/sceneModelStatisticsPanel.test.mjs tests/runtime/sceneModelReadinessError.test.ts（29/29通过）；核心运行时最终11/11由并行实现代理执行后冻结代码。
- 最终 npm run typecheck 通过；相关生产文件 ESLint 0错误、45条警告，与HEAD基线四个既有大文件警告数一致，新增文件无警告；git diff --check 通过。Impeccable新UI检测返回[]。
- 真实浏览器：Edge硬件WebGL2，Intel UHD630/ANGLE，现有真实SceneViewPanel/SceneSettingsPanel fixture，19项检查，pageErrors=[]。验证48/120立方体、隐藏与相机不变、删除撤销、合法本地场景文件阵列10+环境1=11、同ID/空场景重开、缺失模型失败与删除恢复、异步加载占位与完成更新、100立方体+环境1=1201、精确数字选择、键盘说明与明细、320px外侧面板无横向溢出。
- 证据：output/playwright/scene-model-statistics/result.json、implemented-panel.png、implemented-scene.png、narrow-320.png；模型字节为已知单三角面glTF，通过测试本地资源路由供真实加载器读取。
- 验证边界：本地源码、真实浏览器WebGL与NullEngine回归；未重打安装包，未验证已安装版本或现场远程资源。无本轮必要功能遗留。

## 2026-10-20 提升机与换层提升机运动箭头

- 需求：编辑器运行和发布场景沿用现有运动箭头逻辑。验收清单见 docs/tasks/2026-10-20-lift-motion-arrows.md，六项均完成。
- 配置与交互：lift 三路（升降/前工位/后工位）、hclift 单路升降；十样式及拖放、颜色/动画/挂点/独立编辑预览，统一 telemetryBinding.liftMotionArrows 保存、复制、撤销重做和 SOURCE/DIST 序列化。缺省关闭、显式零值保留、预览仅当前会话。
- 运行：驱动后发布 WeakMap 同帧实际位移；工位沿已有真实输送轴，排除首帧/初层吸附/补齐/约束纠偏。升降固定柱全高度并动态避让载货台，工位跟随台面；共享台面沿安全交段分半，斜向宽度和自动长度留在台面范围内。正常停机120ms淡出，故障/work_state=10/过期/冲突/缺帧/隐藏即时关闭，删除和切换释放。
- 复核修复：摘要不得主动调用有副作用的业务轴解析器，改为仅读已建立缓存并覆盖层模型晚就绪；急停增加独立门控；补斜向台面四角/侧面回归。未改参数化脚本或原有 MQTT/动作规则。
- 定向回归：配置/会话/编辑store 15/15；原及新驱动/摘要先33/33，旁路修复后受影响lift+摘要27/27（hclift7项证据仍有效），最终驱动合计34项；Renderer12/12；System6/6。合计67项有效回归，testGroups机制另5/5。npm run build（含TypeScript、编辑器与Viewer）、npm run build:electron通过；修改源文件ESLint 0错误，既有SceneRuntime29、liftDriver2条警告；git diff --check和新增文件UTF-8检查通过。
- 真实编辑器：Microsoft Edge/Intel UHD630/ANGLE硬件WebGL2，四通道正反预览/动画/停止、保存重开、窄视口、两类MQTT上下行、立柱固定与动态缺口、急停断流通过；MQTT task101/102由真实conveyor依次生成两箱并取入后/前工位，两路箭头direction1且实物ID独立，停预览货物清理通过，errors=[]。
- 发布：实际Electron SOURCE/DIST各4场景（main/legacy/disabled/zero）保留配置、两模型与脚本、重开、源文件不变；最终源码build后重新解包的DIST Viewer验证两类升降、动画、故障/急停/断流、前后工位真实MQTT取货及旧/关/零值场景，errors=[]，硬件WebGL2。
- 证据：output/lift-motion-arrows/{editor-result,packages-result,viewer-result}.json、build.log、eslint.json，mqtt-up-gap-moved.png、mqtt-front-pickup.png、viewer-up.png、viewer-front-pickup.png。使用说明 docs/lift-motion-arrows.md，README已加入入口。
- 既有问题与边界：test:entries因HEAD原有test:manual-roam入口与scripts/test-entry-manifest.json漂移失败，当前命令与HEAD一致，未扩大修复。现场Broker/实际业务模型包/已安装版本/线上部署未验收；未提交推送Git。本轮必要功能无遗留，任务浏览器与动态端口服务均已关闭。

### 2026-10-20 混合光照取消重试回归

- 取消等待渲染就绪或后台结果时立即释放当前调用；后台保留进程清理占用，重试预约等待清理完成，预约也受所有权、取消及窗口生命期约束。
- 聚焦回归 9/9 通过，含错误所有者拒绝、取消后立即重试、取消等待中的重试、窗口关闭与迟到结果。真实 Electron 操作验证仍在执行，完整验收尚未完成。

### 2026-10-20 混合光照实机闭环与追加缺陷验证

- Intel UHD 630 硬件 WebGL 的真实 Electron 中，完成 UI 取消/立即重试、Cycles 生成应用、本地 MQTT 升降、静态阴影缓存保持、保存重开。证据位于 output/lighting-bake/electron-result.json；该轮尚未包含后续签名与材质修正，不作为最终版本全部验收。
- 实际序列化回归证实 undefined 属性会导致保存后 GI 误过期，已按 JSON 语义修正摘要；6 项合同回归通过。两处折叠区和子部件继承/覆盖 UI 已补齐，真实操作验收待最新 smoke。
- 实机发现立柱 GI 采样为零及 Hemi 高光丢失，正在修复；应用最后阶段取消的 GPU 回滚风险也正在加入事务测试。当前不宣称完成。

### 2026-10-20 跨页与实例标记验收修正

- 22文件聚合已完成：123/123通过、无取消/跳过，完整日志output/lighting-bake/unit-final.log。随后新增实例绘制隔离修复仍需按影响复验，不能只引用先前聚合代表最后版本。
- 单大表面切分已保面积和原属性；独立审查进一步发现原面积估算会降低真实texels/m，继续改为按真实UV度量与世界尺度分配，超页继续切分。600m²真实平面最低密度已达到配置16px/m。
- 七表面高密度夹具按实际128px/m需要19页、76MiB，原64MiB明确失败；最终实机夹具预算改128MiB，保留64MiB拒绝用例，不降低纹理密度。此前9页结果不是有效密度证据。
- Viewer预检已通过真实导出、资产摘要、独立硬件WebGL及MQTT升降/回落；初始化过时请求被取消但同URL成功读取，报告保留原取消记录并独立拒绝未恢复失败。最终跨页Viewer验收尚在执行。
- 未烘焙时原生实例/逻辑阵列接收标记被聚合或原生getter忽略，已实机复现；正在按需隔离绘制，保持统一族批处理，并验证首次GI切换与取消恢复。

## 2026-10-22 GLB 标准预览与默认环境照明

- 已确认范围：普通/环境模型共用“GLB 标准预览”，新场景默认增加内置离线 IBL，旧场景配置保留；实际 GLB 保存重开与 SOURCE/DIST 本地发布。清单见 `docs/tasks/2026-10-22-glb-standard-preview.md`。
- 实施：增加可选环境来源/旋转，预设同时暂存照明与外观并统一撤销；离线资源及许可随 Editor/Viewer 打包；签名与捕获区分照明源和天空背景。新建保留基础对象所需的原主光/补光，显式预设才建立纯 IBL 基线。
- 实机修复：离场实例源漏收全场景标脏及旧灯光释放，冻结环境还会跳过 ready 检查；现在按实际源去重，恢复原生检查状态并保留编译资源。小型真实 GPU 的像素、冻结与资源复用验证通过。
- 崩溃修复：共享TypedArray快照避免按Geometry重复分配；堆采样进一步确认约3.48GB由Babylon静态clone保留的Vector3位置数组造成，现逐clone及时释放，源/几何/材质/包围盒及形变模型不变。实际预设草稿阶段主堆约3.67GB→260MB，旧崩溃的应用/撤销/再次应用闭环通过。
- 最终验收：两入口保存重开、正式SOURCE解压重开、正式DIST及独立硬件WebGL2离线Viewer均通过；各2673网格/226材质完整，四阶段画面各自一致。跨入口相对模型中心的相机、材质、像素通过，亮度差0.006503、直方图L1为0.000449。
- 验证：定向105项通过（32预设/运行时、42统一光照、28身份缓存、3原环境缓存）；GPU像素和资源复用通过，最终完整构建成功、相关lint 0错误，2条测试prefer-const警告保留；测试清单0未分类。最终报告 `output/glb-standard-preview/1792655462707-d3cf6608/result.json`、汇总 `final-acceptance.json`，证据来源链及原失败均保留。
- 边界：工作区目录rename出现EPERM后，最终在独立本地目录正式导出，交付副本各279文件逐个SHA核对后离线验收；发布器文件锁处理未修改。首次环境冷应用约111秒、再次约11秒，未优化该摘要计算或承诺FPS；现有性能计数警告未扩大修复。未重打安装包或验证已安装/线上版本。
- 原始 GLB 不改写；不提交、不推送、不上线。本轮必要功能无遗留，任务应用/浏览器及服务已释放，产物与诊断记录保留在 `output/glb-standard-preview/`。

## 2026-10-23 发布场景返回开场动画

- 已确认：右上角低存在感回转图标（12px / 1px线宽 / .28透明度 / 28px透明热区），悬停或聚焦提亮并提示；点击从头重播，结束自动进入持续运行的场景。
- 验收清单：[x] 可反复返回且防快速重复启动；[x] 首次模型入场与重播收尾分开；[x] 已挂载面板仅视觉隐藏；[x] 内嵌每轮重新确认可见；[x] 实际DIST两轮循环与异常/禁用场景；[x] 桌面/窄视口实际样式与键盘；[x] 构建、审查和文档最终核验。
- 实施：PlayerApp 为每轮创建独立开场协调器并隔离迟到回调，保留三维运行时和订阅；GeographicOpeningBridge 清除上轮可见状态；新增独立 OpeningReplayButton。
- 自动回归：新增宿主重复播放测试先失败（旧可见缓存被误用）后通过；桥接/协调器/可见性25项、包配置/环境快照等13项共38项通过。typecheck、build:viewer、build:electron通过；功能源码和新smoke脚本ESLint通过，diff检查通过；测试分类和清单补登记后检查通过，0未分类。
- 发布与实机：实际Electron SOURCE/DIST普通两包及棱光环境包通过；Chrome155/Intel UHD630硬件WebGL2验证三类开场各三轮（两轮跳过、一次completed，campus从零完整自然播放，其他寻帧至末尾），双触发仅一实例，场景/相机实例及帧持续、静止相机不重置、无额外scene/GLB读取；1600×900及390×844入口尺寸/透明度、悬停/键盘提示、Enter播放和还焦通过。内嵌同session两轮隐藏等待/暂停/恢复及completed/skipped通过，真实宿主命令打开的自动巡检面板保留DOM与折叠状态。无开场正常就绪且无入口；既有smoke的素材404退出与业务恢复通过。
- 验收修正：旧发布夹具因新默认烘焙未生成被正确拦截，仅将两处开场夹具明确设为不启用烘焙，未改产品校验。巡检自动在third-person/orbit切换，半径5.4626→15属于既有业务行为，已按控制器独立依据修正测试固定距离假设；参考包窄屏按既有CSS隐藏文字跳过入口，测试沿用Esc。两次原始失败报告/日志保留。
- 证据：output/playwright/opening-replay/result-all-renderers.json（三类型完整矩阵）、result.json（追加业务面板与内嵌）、smoke.log、smoke-panel.log、packages*.log、typecheck.log、build-viewer.log、existing-failure-visibility.log及常态/悬停/键盘/窄屏PNG。源码见PlayerApp、OpeningReplayButton与GeographicOpeningBridge，使用说明见docs/opening-packages.md。
- 既有诊断：两份导出夹具原有no-unsafe-finally lint报错与清理逻辑保留；构建有既有大chunk提示，本地夹具出现发布缓存partial控制台提示；正常重播未捕获异常0、console.error0、开场警告0、资源关闭错误0。该边界不等于全部既有lint已通过。
- 边界：仅本地实际发布包和本地宿主/API夹具，未验证线上大屏、现场MQTT或已安装版；需使用新Viewer重新发布后生效。保留工作区其他改动，不提交、不推送、不上线；本任务浏览器、导出进程和临时HTTP服务已关闭，必要功能无遗留。


## 2026-10-23 阵列净间距支持负数

- 需求与验收：右键菜单及 Shift 拖轴的共用弹框允许有限负净间距；普通对象与组合模型的请求、预览和提交保留符号；沿用“跨度 + 净间距”的步长，覆盖正、零和反向步长，保存重开和撤销重做保留坐标。
- 实施：解除输入最小值、共用参数校验、请求净间距清洗、普通/组合预览及矩阵批次的非负限制；保留数量、有限数和提交溢出校验。更新 README 与组合模型说明。
- 回归：修改前已复现界面拒绝、请求改为 0、预览负数钳制三个失败；修复后 model-array 20/20、弹框 1/1、普通/组合请求到保存及历史回归已通过。运行时矩阵、实际浏览器和 typecheck 仍在执行，最终结果补记于本条。
- 边界：保留原工作区的光照与性能改动；不提交、不推送、不发布。

### 阵列负净间距验收补记

- [x] 普通/组合弹框允许负有限数，NaN 与正负 Infinity 仍被共享校验拒绝，副本数量范围仍为 1–1000。
- [x] 正、零、反向步长的请求/提交/序列化/历史链路通过；NullEngine 预览 6/6 通过，含普通克隆与组合 thinInstance。
- [x] 首轮实际 Chrome 浏览器 15 项检查通过、pageErrors=[]：六方向原正间距、正反 X 负间距、普通立方体/导入输送机/组合保存重开、撤销重做、取消清理、真实鼠标 Shift 拖轴后负间距预览与确认。证据 output/playwright/composition-array/result.json、shift-negative-spacing-preview.png。夹具旧 shadows 字段导致的原始启动失败保留在同目录 failure.json。
- [x] 代码审查无阻断项；生产文件及新增断言 UTF-8 检查通过。针对性 ESLint 的夹具就绪断言已改为安全的空值默认写法，最终复验正在执行；原有 any 和 prefer-const 警告不扩大修改。
- [ ] 全量 npm run typecheck：被本任务开始前已有的光照改动阻断，src/runtime/babylon/lightingRuntimeCapture.ts:2 的 VertexBuffer 未使用（TS6133）。该文件不属于本任务，未修改。未运行完整 build，不把构建描述为通过。

- 最终复验：修正夹具就绪检查后，真实 Chrome 浏览器 15 项再次全部通过、errors=[]，截图已人工检查负数 -0.5 与可用确认按钮；针对性 ESLint 退出 0（0 错误、2 条既有警告），git diff --check 通过。本任务源码和验收记录完成；全量类型检查仍以上述无关光照文件 TS6133 为限制，未构建安装包或验证已安装版本。浏览器和临时动态端口服务均由脚本正常关闭。
