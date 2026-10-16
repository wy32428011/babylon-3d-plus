# 手动漫游人物与共享动作资产

当前默认使用 v2：`EQ_People_rigged_v2.glb` 与 `locomotion-v2.glb`。原始人物、v1 人物与动作包保留，已有 v1 自定义人物继续匹配 v1 动作，新默认人物和 v2 人物使用 v2 动作。

## 普通蒙皮人物自动适配

选中“手动漫游初始位置”，在“漫游人物模型”上传自包含 GLB。上传后打开“人物动作预览”，可直接查看站立、行走、跑步、跳跃、飞行和右键转身；点击“应用此人物”才修改场景，关闭预览保留原人物。已有项目人物可通过“预览人物动作”检查。预览使用正式漫游控制器，关闭时释放独立场景、动画、骨架和输入监听。

没有专用 profile 的人物，只要包含同一有效骨架、完整的 22 个可识别人形关节和有效蒙皮，就会尝试自动适配 v2 共享动作。支持 Mixamo 前缀、UE 常用骨名和 Blender 常用 `DEF-` / 左右后缀；允许语义关节之间存在静态辅助节点。用户无需改名、填写 reference pose 或自带动画。自动校准支持 Y 向上的 T/A 站姿、可识别的脚前向及均匀骨骼缩放；最多保留 8 个骨骼影响，不删除额外骨骼、裁剪权重或更改原 inverse bind。未知命名、缺关节、重复/歧义映射、不完整蒙皮和多个独立骨架不能自动适配。

导入器只在项目副本根节点的 `extras.manualRoamHumanoid` 保存语义节点索引、适配版本和源文件 SHA-256，原始文件不改写，BIN 与其它 chunk 原字节保留。该数据是识别缓存，不是“动作效果已合格”的标记；运行时仍核对实际骨架和权重，并为目标人物生成动作。场景保存、SOURCE 和 Viewer 包沿用原 GLB 资源收集路径。新能力需要使用新版 Viewer 构建后重新发布；旧 Viewer 不会因此自动获得通用适配能力。

基础动作与脚部贴地分别检查。自动人物按足骨及其后代的真实蒙皮影响提取脚底，不要求独立鞋网格或特定材质名称。足部候选顶点超出有界缓存、足底存在形态变形或无法可靠测量时，保留基础动作并明确提示贴地未启用，不改用默认人物鞋底伪装成功。完全不能自动适配时显示具体原因，继续使用原模型内嵌动画或静态姿态；无骨骼人物不自动绑骨。已有明确 v1/v2 声明仍走原严格校验。

验证入口：

```powershell
npm run test:manual-roam
npm run test:manual-roam:integration
node scripts/smoke-manual-roam-humanoid.mjs
node scripts/smoke-manual-roam-humanoid-terrain.mjs
node scripts/smoke-manual-roam-avatar-upload.mjs
# 构建最新 Viewer 后再检查发布外壳与缓存
npm run build:viewer
node scripts/smoke-manual-roam-humanoid-viewer.mjs
```

## 离线构建与验证

```powershell
node scripts/build-manual-roam-assets.mjs
npm run test:manual-roam
node scripts/smoke-manual-roam-skeletal.mjs
```

构建只读取固定指纹的本地源，无网络请求；只生成 v2 人物、动作清单和换肤夹具，不覆盖原文件或 v1。所有源、输出 SHA256 与动作处理方式记录在 manifest。

## v2 蒙皮与参考姿态

v1 将原有行走姿态的网格先烘焙到 T-Pose，再播放动画，产生两次非逆线性蒙皮，造成上衣膨胀及腿部变形。v2 将真实 bind 和动画 reference 分离：

- 网格只转换为米制并做整体 Y 平移，原法线、切线、材质、贴图及三角形索引保持原样。
- 节点和 inverse bind 保存原人物实际绑定姿态。
- 每个关节的 `extras.manualRoamReferencePose` 保存动画参考的 translation、rotation、scale。
- 加载时只设置骨骼 rest，不修改 inverse bind。动画装配失败会恢复原 rest 与节点变换，保留原静态人物。
- 裤腿按骨盆及对应腿链赋权，排除附近手掌、另一条腿等无解剖关联的影响；12 mm 内跨材质接缝共享权重。
- 上衣按肩宽和肘部位置连续划分衣身、肩腋和同侧袖链；胸背核心不接受前臂/手掌影响，手部仅由同侧前臂和手掌驱动。只改变蒙皮权重，不移动原网格。

原始轮廓最大数值误差约 9.313e-8 m，169 对接缝近邻距离增量为 0。reference T-Pose 本身仍不是经过美术精修的中立模型，不能用它证明服装保形；验收检查实际 Idle/Walk/Run 全帧 CPU 蒙皮及 WebGL 效果。自动化门槛为 Idle 总面积偏差 3%、Walk 5%、Run 10%，另独立检查关节轴、有限值和轮廓。

骨架标识为 `mixamo-humanoid-v2` / version 2；动作清单 version 2。22 个关节和 v1 名称、父子层级相同。单位为米、Y 向上、glTF 前方 +Z；导入 Babylon 后保留加载器的坐标转换。

## 动作来源与制作

前进 Run 保留 [BabylonJS Assets Xbot](https://github.com/BabylonJS/Assets/blob/c81f5d744fe8d41acfebd89eaeb7008c6f9659e3/meshes/Xbot.glb) 来源，固定指纹和 CC BY 4.0 许可全文位于 sources。Idle 为原创对称放松站姿，采用适度脚距、轻微屈膝与呼吸；跑步手腕保留源变化的20%，减少无指骨人物的折腕表现。 前进 Walk 为原创男性上班步态，见“原创上班步态”一节。

侧移与后退使用 [KayKit Character Animations Free 1.1 官方包](https://kaylousberg.itch.io/kaykit-character-animations)。作者 Kay Lousberg，随包许可证 CC0-1.0。原始 GLB、LICENSE.txt、官方入口、包及文件摘要保存于 `scripts/manual-roam-assets/sources/kaykit-character-animations-1.1`。

| 输出 | 实际依据 |
| --- | --- |
| RunLeft/Right | 原生 Running_Strafe_Left/Right 的骨盆、腿链；完整上身来自 Xbot Run 并按支撑相位对齐 |
| WalkLeft/Right | 原生侧跑降低下肢幅度、减少起伏并重定时，明确属于编辑派生，未称为原生侧走动捕 |
| WalkBackward | 原生 Walking_Backwards 调整迈步幅度，保留方向和膝盖屈伸轴 |
| RunBackward | 原生 Walking_Backwards 重定时，属于快速后退派生，并非独立后跑动捕 |
| JumpStart/JumpUp/Fall/Land | 原有原创骨骼关键帧，来源明确记录 |
| FlyIdle/FlyMove | 以放松站姿上身衔接的原创悬停/飞行关键帧，前臂使用Y轴屈肘，避免大幅外展及长轴扭转拉开衣身 |

导出时读取源完整层级的世界姿态差，再转换到目标父链；不会对膝盖和小腿整链做 Y 轴 90 度旋转。测试直接检查左右侧移膝盖横向旋转分量，v1 原动作约 67 度会失败，v2 通过。

所有侧移与后退走跑都使用对应 Walk/Run 的完整上身。按左右脚接触参考对齐周期，并将 Spine 全球旋转换回方向动作的 Hips 父坐标；不再将 Idle 局部手臂直接拼到不同躯干上。质量回归检查站距、腕部角度、双臂交替以及公共支撑相位的上身一致性；蒙皮回归独立弯肘，检查胸背核心不被前臂牵拉。

`node scripts/smoke-manual-roam-skeletal.mjs --posture` 在已有厂区 GLB 内通过正式 Runtime 的键盘输入验证八个方向走跑及斜向混合，记录实际肩腕轨迹、截图与录像，输出位于 `output/playwright/manual-roam-posture`。侧面观察机位仅用于检查姿态，不修改生产相机逻辑。

每个移动片段按最终人物踝部和前掌的完整后移事件识别承重期，用完整承重段净位移/时长的中位数标定 referenceSpeed 和 cycleDistanceMeters，记录循环连续的平滑 contact 曲线和 phaseOffset。不再以最低30%脚踝高度替代接触定义。运行时按碰撞后的实际位移与标定步长推进相位；接触标定和世界锁脚分别验证。

## 播放控制与发布

v2巡检人物根据实际水平速度平滑转向行进方向，并使用原生前向Walk/Run。A/D、后退及斜向的键盘位移、相机和碰撞朝向保持原规则；停止后保持最后身体朝向，站立时鼠标转向以控制yaw增量驱动原地转身。跳跃继承行进朝向。v1自定义人物保留原四向动作兼容，已有方向资源不删除。

此选择对照了[Babylon官方同源Xbot预览](https://sandbox.babylonjs.com/?assetUrl=https://assets.babylonjs.com/meshes/Xbot.glb)、[Babylon Root Motion说明](https://doc.babylonjs.com/features/featuresDeepDive/animation/rootMotion/)和[Unreal Engine官方移动演示](https://www.youtube.com/watch?v=4ag7fSlEeKA)。项目安装版本为Babylon9.12.0，未引入文档中本地不存在的RootMotionClip/RootMotionController API，也未将胶囊体改为动画驱动。

足部IK初始化时从真实鞋网格CPU蒙皮结果测量有界极值点，逐帧仅使用缓存点；无独立鞋网格时回退原soleHeight。移动时保留脚掌pitch/roll，通过当前后跟/前掌最低点及相对平脚的滚动差求踝目标，不再全程压平脚掌；站立和原地转身仍平脚贴地。地面修正上限和骨盆最多8厘米的边界保留。

`node scripts/smoke-manual-roam-skeletal.mjs --locomotion` 使用固定地面网格和固定机位，验证身体朝向、控制yaw不变、各方向输入，并独立采样实际蒙皮鞋底高度、接触和失锁原因。记录位于 `output/playwright/manual-roam-locomotion`，不以踝部目标误差替代鞋底几何误差。

每个活跃片段有独立播放游标，渐出动作不会因新状态 elapsed 归零而回到首帧。完整权重向量按统一 smoothstep 进度过渡，方向更新不会重复重开同一过渡时钟。即时跳跃保留原物理参数，离地后的 JumpStart 最多 0.10 秒，随后依据真实垂直速度进入上升或下落。

动作、人物、清单 profile 必须一致。新旧资源按精确文件名纳入原始缓存；已有 v1 和旧 response 清单保持兼容。SOURCE 延续自定义人物随项目、内置资源随应用版本提供的约定。

`smoke-manual-roam-skeletal.mjs` 支持 `ROAM_ASSET_VERSION=v1/v2` 对照。最终验收同时覆盖实际左右侧移周期、前后走跑、跳跃/落地、飞行、第一/第三人称、顶墙、换肤和反复启停；发布 Viewer 还须完成缓存后断网重进验证。

## 原地转身与足部 IK

第一阶段IK协调保留全部人物/动作资产、输入、相机和碰撞逻辑，仅调整姿态求解。每脚维护Swing/Landing/Support/ToeOff，结合原接触曲线、当前FK鞋底净空、相对地面的竖直速度和有效地面判断；落地位置、坡面姿态与水平锁分别赋权。源姿态已确认触地的短跑步接触可直接支撑，未落地的高接触曲线不能水平锁脚。防穿地独立于外观权重，ToeOff解除旧水平锁。

膝盖先保留当帧FK弯曲平面，退化时使用上一稳定pole，并在前向60度范围内约束反弯/侧折。骨盆以每帧重新采样的FK为基准叠加临界阻尼偏移，世界下降最多8厘米，空中平滑回收，复位立即清除。debug逐脚提供phase、独立weights、pelvisOffset和poleCorrectionRadians。

`node scripts/smoke-manual-roam-skeletal.mjs --ik-phase1` 使用真实厂区GLB，覆盖前/左右走、前跑、停止、IK/FK同路径同机位对照和15厘米台阶；逐帧保存鞋底、FK/IK膝与骨盆、阶段和锁点。漂移必须有连续同锁同顶点样本对才能报告数值，不能将单采样段记为零漂移。输出位于 `output/playwright/manual-roam-ik-phase1`。

第二阶段仅对v2启用步幅和步频协同：步幅随实际速度平滑变化，行走与跑步最多1.30（MANUAL_ROAM_MAX_STRIDE_SCALE）；相位推进使用同帧步幅与已标定的周期距离，FootIK使用相同系数扩展摆动目标，可达性不足时缩步，不伸长骨骼。移动转向不再同时清除双脚锁，保留可达支撑，超限脚独立释放并在下一次落地重新建立锁。真实鞋底残差最多迭代两次，每次最多10毫米、合计20毫米，保留原纠正距离和腿长上限，残差不下降或穿地加重时恢复原姿态。

鞋底低区原有小腿混合权重会使支撑鞋随膝盖形变。第二阶段仅收紧该区域至对应Foot/ToeBase，鞋口平滑恢复原候选及接缝平均；顶点、索引、法线、材质、贴图和bind矩阵不变，资源哈希随权重重建同步更新。

`node scripts/smoke-manual-roam-skeletal.mjs --ik-phase2` 在真实厂区逐帧验证前/左右走、前跑、45/90/180度移动转向及15厘米台阶。连续同锁同顶点支撑段的峰值和最终水平滑移均须不超过10毫米，左右脚都必须有有效连续样本。贴地检查独立探测鞋底轮廓下的实际地面，支持局部高差，不将世界Y=0当作所有厂区地面。输出位于 `output/playwright/manual-roam-ik-phase2`。

局部高差贴地修正以实际蒙皮鞋点为依据。先按4×4分区检查低处鞋点；发现命中点不属于同一地面平面时，再核查全部有界鞋缓存点，同XZ射线复用。残差的水平分量沿用支撑锚点，竖直分量依据各点当地地形计算，避免将鞋侧高地面漏检为已贴地，也避免沿斜面法线抬升产生水平滑移。仍保留两次、合计20毫米、原有腿长和纠正距离上限。停止时旧支撑不可达，会独立释放该脚并在当前帧进行一次贴地回退。

`node scripts/smoke-manual-roam-skeletal.mjs --run-contact` 聚焦真实厂区跑步高差路线，按人物实际位置确认越过高差，覆盖正常待机、起步、跑步和停止，严格断言真实鞋底穿地与Support贴地偏差不超过2毫米，并保留双脚有效连续支撑和10毫米水平滑移门槛。明确复位、传送和离地帧保留在完整遥测中，单独统计排除原因及峰值。轮廓采样误报悬空时，松键后使用已捕获完整鞋点对静态厂区地面独立重放，避免验证射线影响跑步支撑帧采样。每次输出到 `output/playwright/manual-roam-run-contact/run-<timestamp>`。

v2新增原创双步 TurnLeft90/TurnRight90，各0.8秒；180度由两个90度片段连续完成。动作清单记录累计旋转曲线和左右脚接触曲线，视觉朝向、姿态和接触使用同一进度。控制yaw、相机和输入位移保持原逻辑。

运行时在 onBeforeAnimations 提交手动加权姿态，在 onAfterAnimations 执行支撑锁脚、两段腿IK及脚掌法线修正。手动采样组暂停自动时钟，避免零速自动求值覆盖游标。骨盆仅作最多8厘米的视觉下降，不移动碰撞体；空中、飞行、复位、缺地面和不可达时清锁。贴地探测覆盖现有stepHeight并检查抬升头部净空，修复台阶顶面高于原射线起点时错误落回地面的情况。

真实场景验证命令为 `node scripts/smoke-manual-roam-skeletal.mjs --factory`，加载项目已有21MB厂区环境GLB（毫米转换为米），加入15厘米测试台阶。它断言碰撞体登阶、45/60/90/180度右键转身不改变位置，并独立记录满支撑脚修正前后的世界目标误差和固定锁点漂移。报告与录像位于 output/playwright/manual-roam-foot-ik。该结果属于本机工业场景夹具验证，不代表线上客户环境验收。

## 脚底校准（站立不翘脚尖、不弯膝）

原人物是走路姿态，鞋网格按真实绑定姿态蒙皮，而参考骨架为直腿、脚骨水平；直接使用会让鞋底陷入地面约2.3厘米且脚尖上翘约17°，足部IK只能弯膝抬脚。构建脚本现对参考姿态下的鞋做CPU蒙皮：测出鞋底相对脚骨的俯仰，在所有动作的Foot轨道前叠加反向旋转放平，并整体抬高参考骨架使放平后的鞋底落地（少抬6毫米以保证直腿目标可达）。每个Foot关节的 `extras.manualRoamSoleUp` 记录鞋底在脚骨局部的朝上方向，足部IK以它代替脚骨Up轴作为贴地基准；缺省回退脚骨Up轴，v1和自定义人物不受影响。

回归：`tests/roam/manualRoamReferencePose.test.ts` 检查直腿站立的鞋底最低点；`tests/roam/manualRoamFootIK.test.ts` 的夹具叠加同一补偿。

## 原创上班步态（男性）

Xbot 源步行两脚支撑时距中线仅5.4/3.7厘米且左右不对称，骨盆侧倾约11.7°、扭转约14.6°；按默认1.6m/s播放还需约1.3倍步幅拉伸，足部IK因此压低骨盆、屈膝，整体像扭胯的模特步。只缩小骨盆幅度无法消除内收交叉的腿形，因此 WalkForward 改为 `scripts/manual-roam-assets/commuteWalk.mjs` 离线生成的原创步态，不下载、不引用任何动捕。

- 两脚各走一条平行线（踝距中线6厘米），脚尖外展约6°；足部依次脚跟着地（脚尖上翘约17°）、放平、绕前掌抬跟（约29°）蹬离，鞋底支点按实测鞋底尺寸计算，支撑相随地面匀速后移。
- 两段腿解析IK求膝，膝盖朝前；骨盆高度为每周期两次下沉的平滑曲线，取双腿可达上限内的最高位置，起伏约4.5厘米，单支撑中段屈膝约12°。
- 骨盆仅侧倾约1.7°、随步扭转约2.9°；胸部相对骨盆反向扭转约4°、前倾约3°，头颈保持平视。双臂与同侧腿反相、外展约9°贴身前后摆，肘部屈曲约15–24°。
- 该人物腿长仅约身高46%，默认1.6m/s（作者单位约1.67m/s）需较快步频：周期0.87秒（138步/分钟）、周期距离1.455米，运行时步幅系数保持1.0，不依赖足部IK拉伸。速度高于原生步速时仍按原机制有界拉伸（最多1.3）。
- 步速、周期距离、相位与接触曲线直接由作者参数写入清单（`authored-commute-walk-exact-v1`），不用通用踝/前掌后移标定，避免脚跟、前掌滚动带来的踝部位移被误计为步长。
- 侧移、后退的上身改用同一原创步行，并按支撑相位对齐；RunForward 仍为 Xbot run。

回归见 `tests/runtime/manualRoamMotionQuality.test.ts`（步宽、对称、支撑腿伸直、骨盆幅度）与 `tests/roam/manualRoamAnimationState.test.ts`（默认步速步频与不拉伸步幅）。
