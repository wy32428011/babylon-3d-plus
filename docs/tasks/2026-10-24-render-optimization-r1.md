# R1 GPU能力诊断与缓存

日期：2026-10-24。根代理已确认诊断only边界，按planner/TDD/code-reviewer执行；未开始正式性能采样，不提交/发布，不自动修改画质、脚本、MQTT或场景数据。

## 验收与写域

- [x] 新gpuCapabilityProfile.ts：prepareGpuCapabilityProfile(engine,signal?)执行一次独立离屏WebGL2固定负载3预热+12测量帧，有限draw/finish/yield与总预算；只清理自有资源/context。
- [x] 同时读取host renderer/getCaps，隐藏context vendor/renderer/version与host匹配且有unmasked provenance才可measured；不匹配/无DOM/失败输出unavailable，不伪造T0实测。取消抛原signal reason并清理。
- [x] Cache schema/算法/driver+caps fingerprint/30天TTL，坏缓存及storage拒绝安全；不信任cache tier/统计，按原samples重新计算验证。
- [x] 未知/集成保守T0；T1须独显且maxTextureSize>=16384（原方案0.4），T2在此基础更严格；T1/T2仅模拟边界，明确阈值未跨设备校准。本机仅Intel T0实机证据。
- [x] ScenePerformanceMonitor诊断JSON读取profile；SceneRuntime只读forward，不启动probe。root独占Readiness准备遮罩await接线，不碰其文件/SharedCache/AssetRuntime/LD6模块。
- [x] Store仅profile诊断态；manager open时只读getter，不新增classification/probe调用。Overview显示建议与可用状态，原画质控件行为不变。
- [x] Unit RED→GREEN覆盖分类边界、缓存版本/TTL/fingerprint/坏JSON/篡改统计、取消/失败/清理/无DOM/并发只一次probe；真实本机冷/热cache与异常语义，真实UI打开及原控件操作。
- [x] 独立审查、聚焦lint、build5与入口登记/106审计通过，最终15项profile回归与实际T0 UI/cache检查通过；专属Chrome/server均已清理。

## 设计

结果明确区分status measured/unavailable、tier|null和保守建议。测量包含CPU提交与finish等待，不是GPU timer或整场景FPS；原始12个样本、median/P95、算法版本、固定负载与renderer provenance进入报告。建议不绑定自动设置。

缓存只保存有明确provenance的measured结果，按完整driver/caps指纹校验，短key碰撞仍比较完整指纹；30天过期/未来时间/格式损坏/统计或tier矛盾均重新探测。读取getter只返回已有WeakMap结果，不创建DOM/context或读取storage。

接口：prepareGpuCapabilityProfile(engine,signal?)；getGpuCapabilityProfile(engine)。内部测试环境可替换时钟/storage/canvas/yield，不替换业务画质和引擎状态。第一prepare拥有探测生命周期，并发等待不创建第二context；非owner等待者取消不取消原探测。

## 当前状态

实现与本地功能已冻结：核心12项、Monitor 1项、UI 2项通过，最终real-4真实功能PASS。独立最终报告、根全构建/旧fixture适配/入口登记待整合。LD5另保持a6ea/65d/a548冻结，功能待l2最后审查，正式性能未验，不与本项混算。

根复核纠正：初版T1阈值错误放到8192，已按原方案0.4恢复16384，并独立测试8192/16383→T0、16384且16units/合格样本→T1；未发布该初版、未用其缓存作实机证据。

## 功能冻结与验收结果（11:25）

- R1核心、Monitor JSON、SceneRuntime纯getter、manager纯诊断state/Overview与原poll同步均已实现。核心12项、Monitor JSON 1项、UI SSR/AST 2项均GREEN；改域eslint 0 errors / 0 warnings。
- 根复核的两处生命周期先有确定RED：同Engine内存结果绕TTL/driver与旧owner取消误伤live waiter。已修显式prepare重读driver/caps/TTL；模块owned context restore epoch立即失效并跳过旧storage，dispose仅移自己observer；旧owner取消后live waiter等其清理完成重开，不继承旧reason。
- 独立reviewer发现manager一次性effect会留下旧profile，real-2-lifecycle-red用真实hook/store保持同engine/session/open复现。修为已有400ms manager-open poll中的纯getter+引用比较，不新增probe/完整分类调用点，关闭管理器不读profile。
- 最终真实Chrome/WebGL2功能：output/render-optimization-q1-20261024/r1/real-4-final-ui-cache/report.json，PASS，前后输入SHA一致。Intel UHD630，真实T0 12测量样本，host/offscreen provenance匹配；同context重载热cache UI且新probe contexts=0。Readiness记录gpuCapabilityProbe独立stage count1。
- 同open/ref/session下context-restored事件模拟→getter null→显式无canvas unavailable→显式recover新T0，UI/store跟随；这是事件和界面契约，不声称物理GPU丢失/恢复实机验收。真实取消原reason、5项资源与独立context清理；旧owner取消live waiter重开成功、10资源/2context清理，host仍可渲染。
- manager readonly复开前后场景settings与hardware scale完全相同；原device保持auto。实际手工quality standard→high应用成功，device仍auto。截图manager-t0/reopened/cached.png及quality-before/after.png均保留；已目视前一通过轮的版式与操作结果，新卡无横向溢出。
- 历史失败保留：real-1为导航load默认30秒超时，0GPU结果；改commit+ready等待后再测。real-2是上述hook P2有效RED；real-3为完整功能PASS。最终只做real-4收束，不为更多图片重复。
- 扩展相关回归24项：23通过，旧lightingClassificationPolling fixture缺新增getGpuCapabilityProfile，打开manager时报TypeError；已给根准确适配建议，由根持有旧fixture，不给生产getter加optional掩盖。原closed/Inspector合同已过，Monitor原6项过。该条待根适配，不称全绿。
- 核心SHA d8b352ef002a3175f72d10367978bac4de5afef951ad80b626708f4979fcf0ce；所有最终R1产品/测试/harness冻结，以real-4 report.inputs为准。自建Chrome/Vite/Node执行均已结束；等待独立最终review、根build/入口登记，未运行fullbuild或任何其它优化性能采样。

## 解释边界

- fingerprint只包含WebGL实际可见renderer/vendor/VERSION、caps与算法，不能检测所有保持相同WebGL字符串的OS驱动补丁。
- draw/finish负载有限；150ms单帧、1500ms总预算在原生调用返回后拒绝结果，无法抢占挂起驱动中的单次finish，不能称硬超时保证。
- 计量为CPU提交+GPU同步等待，不是GPU timer或整场景FPS。T1/T2阈值只作未校准建议；未以模拟数据宣称跨显卡实机合理性。本机只有T0实证，画质/脚本/MQTT均不自动修改。
