# Q1 B6：完整属性精确索引焊接

范围：Q0 本地门槛通过、用户批准新的 L2 耗时口径后，执行 Q1 第一项 B6。仅改变 GI 派生几何的表示，不改变实际三角形、角点顺序、法线、UV/UV2/颜色/tangent/bakeUv、图集、材质、采样、seed、业务脚本或 MQTT。B2 图集批量和 B7 二进制未实施。

修改前 Python 独立冻结于 `output/render-optimization-q1-20261024/b6/q0-baseline-cycles_bake.py`，SHA256 为 `2810faf1ceef84543da3d64dac8ee830e2f7e9a3803bd22c44e0b22213390a51`，未覆盖任何 Q0 证据。

验收清单：

- [x] 只在一个 surface 内按完整属性 IEEE-754 float64 字节及通道存在性合并；首次出现决定稳定索引，不使用容差，不跨 surface/材质焊接。
- [x] 原三角顺序、源 winding 恢复、全部可选属性及 UV 岛边界保持；v2 按 indices 展开后与独立旧 v1 角点结果逐字节相同。
- [x] 几何 v1/v2 校验与运行时兼容；新结果/正式资产 manifest 记录 geometryVersion，旧缺省字段保持省略。
- [x] 后台正式提交、运行时加载和已应用 state 重 sync 三个入口均验证显式版本合同；无效候选、取消不覆盖旧正式资产。
- [x] 实际 CPU Cycles 固定 seed/采样对照，1024² RGBM PNG 差0；真实本地服务完成 v2 生成、保存、SOURCE ZIP 和 DIST 资源 SHA/版本保持。
- [x] Intel UHD630 硬件 WebGL2 下 v1/v2 全属性测试 shader 像素、实际拾取与 bounds 一致。
- [x] 既有 atlas integrity / partition 真 Blender 回归、限定 Node 合同、Python 语法、限定 diff 检查通过。
- [x] 根build5 full、lighting-bake246/246、真实Cycles主入口及最终工程检查通过；Cycles直接运行现有build5以避免重复构建，不宣称外部发布。旧UV展开布局测试已按角点IEEE64合同修正并独审，原FAIL保留。

## 实现

`cycles_bake.py:export_geometry` 继续按原面/loop 顺序遍历，并先恢复各输入面的 winding。每个角点按 positions、normals、uvs、uvs2、colors、tangents（含 w）、bakeUvs 的完整通道顺序构建值；可选通道是否存在进入 mask。key 为 mask 加 `struct.pack('<...d', ...)`，因此 +0/-0、一个 double ULP、UV 岛、硬法线、顶点颜色和 tangent handedness 均不会被误合并。无源 UV 时仍生成原来的 (0,0)。仅首次出现写属性，所有角点仍顺序写 indices。输出 version=2，result.meshes 记录 geometryVersion=2。

`sceneLightingBakeContract.ts` 接受几何 version 1|2；`sceneLightingBakeArtifacts.ts` 对两版沿用同一套完整有限属性、index/UV 范围校验，没有放宽数值或长度要求。`sceneLightingBakeData.ts` 只允许 geometry 资产显式声明 geometryVersion 1|2，并在规范化后保留；旧 asset 缺省字段不被补写。

`lightingBakeService.ts:validateAndPromote` 对 geometry 根据文件内容校验版本，再核对 result.mesh 声明，正式 manifest 记录真实版本；probes 仍严格 v1。原 safe child path、SHA、`.pending-*` staging、单次 rename 提交及失败清理保持。

独立审查补齐了两个消费入口：

- `lightingRuntimeResources.ts` 仍先读字节、验长度/SHA，再解析/校验几何；显式 asset.geometryVersion 与文件不符时失败，并沿用原并发收束和候选释放。
- `SceneLightingRuntime.snapshotKey` 仅对显式 geometryVersion 增加缓存键分量，旧无字段 key 逐字不变。已有 state 仅改版本元数据也会重新走资源校验，不能因 URL/SHA 不变绕过新协议。

以上两个文件由根代理明确扩域后修改。既有 atlas/partition 回归原来依赖无索引展开数组；现改为沿实际 indices 展开后对照原 source 角点，保持原属性和 winding 标准，并未删除断言或降低密度/覆盖阈值。

## 可复核结果

所有相对路径位于 `output/render-optimization-q1-20261024/b6/`。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 初始 RED→GREEN | v2 校验/manifest 两项先失败；旧 exporter 先因 version1 失败；补实现后通过 | `versions-red.log`、`weld-red.log`、`version-and-atomic-green.log` |
| 实际 Blender 独立旧角点 oracle | 4种主例、6种逐属性 signed-zero/nextafter 边界、32格平面共11例通过；按 indices 展开全部属性 IEEE64 字节一致 | `weld-complete/report.json` |
| 网格资源效果 | 平面 6144角点/6144顶点→1089顶点，JSON 339198→78808 bytes（约−76.77%）；三角角点数不变 | 同上 grid |
| 实际 CPU 七表面 | 252角点、252→168顶点；JSON合计18420→12754 bytes（约−30.76%）；全部角点字节相同 | `real-cpu-comparison/report.json` |
| 实际 Cycles 图集 | 固定 seed20261024、16 samples、同场景配置；4,194,304 PNG分量差0，RGBM range相同 | 同上 png |
| 真实服务/保存/SOURCE/DIST | 从源 TypeScript 服务启动真实 Blender；7个v2几何、9个正式资产；无pending残留；保存/ZIP/DIST逐文件SHA与geometryVersion保持 | `real-service/report.json` |
| 版本与原子性 | 5项Node测试通过；v1/v2有效，未知版本/错误属性拒绝；生产promotion入口在真实FS中检查不匹配、错误probe和Abort，旧目录不变、pending清理 | `version-and-atomic-green.log` |
| 加载元数据 RED→GREEN | 正确SHA但版本不匹配先被旧loader错误接收，补修后拒绝；先SHA后版本、候选清理通过。Texture为模拟 | `runtime-version-red.log`、`version-and-atomic-green.log` |
| 已应用state RED→GREEN | 旧key仅改版本时加载次数仍1，补修后第二次加载并报版本错误；旧无字段key完全一致。NullEngine | `runtime-cache-red.log`、`runtime-cache-green.log` |
| 硬件GPU v1/v2 | Chrome / ANGLE Intel UHD630 / D3D11 / WebGL2；5组各262144 RGBA分量差0，共1,310,720分量；画面非空；15次真实pick全部hit，faceId/重心/点/normal及bounds逐值相同 | `hardware-webgl/report.json`、`hardware-webgl/grid-v2.png` |
| 既有实际 Blender | atlas integrity（含正反绕序/变换属性）及partition全部通过；实际最终密度约128.0123px/m≥128，覆盖/预算拒绝保持 | `atlas-regression.log`、`partition-regression.log` |

GPU夹具从实际 Blender 导出的 v1/v2 JSON 经生产资源 loader、VertexData/setVerticesData 上传，用包含所有几何属性的测试 shader 渲染。它不是工厂整体FPS、GPU显存测量或已发布Viewer验收。首次夹具遗漏Ray注册的空拾取和默认背景不能算有效证据，已修为显式注册Ray、黑色背景和每次拾取必须hit后重跑；最终报告只包含有效版本，预览已目视确认彩色面。

服务运输夹具使用真实 Blender 与真实文件系统/ZIP/拷贝；Electron app宿主接口用受控stub提供本地路径，未发布外部应用。promotion单元测试通过TypeScript AST提取实际未导出生产函数，只有环境依赖注入，真实校验/FS/rename运行；不冒充整个子进程取消验收。真实子进程取消仍由根既有Cycles集成入口检查。

源码和交付Python SHA256 相同：`802b5ab70a04d8c0fa4d6d79bf9425ca331cd490e3f903a8fb6c9e7ff3da8f86`。完整冻结18文件SHA在 `final-review-sha256.json`。只同步现有构建机制所复制的Python，尚未刷新所有dist-electron TypeScript产物；根完成统一构建前，不把旧已编译服务作为本次v2交付证据。

## 测试入口建议

- 默认Node光照检查增加 `lightingGeometryVersions.test.ts`、`lightingGeometryResourceVersion.test.ts`、`lightingGeometryPromotionVersion.test.ts`、`lightingGeometryRuntimeVersion.test.mjs`，均使用 `--experimental-transform-types`。
- 既有Cycles专属Python列表增加 `cycles_geometry_weld_checks.py` / marker `CYCLES_GEOMETRY_WELD_CHECKS_PASS`，支持既有 `--bake-script` 与 `--output` 参数。
- `lightingGeometryV2.integration.mjs` 是真实CPU服务到save/SOURCE/DIST的独立入口，需上述Node参数与已安装Blender。
- `cycles_geometry_bake_checks.py` 依赖冻结Q0基准，作为显式手工A/B入口；`lightingGeometryVersions.webgl.mjs` 依赖该A/B与weld输出，作为硬件验证入口。两者不应假定CI中有未跟踪基准/历史输出。

复现核心命令：

```powershell
$engine = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
node --experimental-transform-types --test tests/lightingBake/lightingGeometryVersions.test.ts tests/lightingBake/lightingGeometryResourceVersion.test.ts tests/lightingBake/lightingGeometryPromotionVersion.test.ts tests/lightingBake/lightingGeometryRuntimeVersion.test.mjs
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_geometry_weld_checks.py -- --bake-script dist-electron/lighting-bake/cycles_bake.py --output output/render-optimization-q1-20261024/b6/weld-complete
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_geometry_bake_checks.py -- --baseline-script output/render-optimization-q1-20261024/b6/q0-baseline-cycles_bake.py --bake-script dist-electron/lighting-bake/cycles_bake.py --output output/render-optimization-q1-20261024/b6/real-cpu-comparison
node --experimental-transform-types tests/lightingBake/lightingGeometryV2.integration.mjs
node tests/lightingBake/lightingGeometryVersions.webgl.mjs
```

限制：无可焊接UV seam网格会额外持有精确bytes-key字典，可能增加导出峰值RSS；不能从grid文件缩小推断所有业务烘焙内存下降。未测真实工厂/展会GI加载总耗时、独显、VRAM或FPS。没有更改画质、采样、seed、业务脚本、MQTT或图集批量行为；没有提交、推送、发布或生成安装器。本任务服务、Blender与专属Chrome/Vite均已正常退出。
