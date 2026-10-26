# Q1 / B7 无损二进制派生几何

日期：2026-10-24。状态：产品与本地功能/受控性能检查已完成，独立 code/Python/security 审查批准，无 open P1/P2；root 统一构建/登记及组合发布闭环尚待完成。没有提交、推送或外部发布。B2 图集合批继续撤回，LD5 不在本项写域。

## 验收清单

- [x] 冻结 B6 `802b5ab70a04d8c0fa4d6d79bf9425ca331cd490e3f903a8fb6c9e7ff3da8f86`，保留全部 v1/v2 JSON 读取、精确焊接、角点/索引/通道顺序、UV/材质/采样/seed 与原子保存。
- [x] 全通道 Float32 往返必须与原 double IEEE 字节完全一致，含 signed zero；任一不精确/overflow/underflow 或容器资格不符时整块按原 JSON writer 保存，不量化。
- [x] 仅 geometry 新增 `encoding?: 'json' | 'binary-v1'`；旧省略仍 JSON 且不补字段。显式 encoding/geometryVersion 进入 snapshotKey；仅改 metadata 仍重新校验，旧缺省 key 保持。
- [x] browser-safe 输出 codec 严格校验 LE 小头、schema、范围/整数溢出、数量、对齐/连续布局、重叠、finite、index、UV 与尾字节；byteLength/SHA 在运行时 decode 前验证。
- [x] backend pending promote、路径授权、Junction/真实路径、保存/重开/SOURCE ZIP/DIST、editor-asset handler 保持完整，格式不一致失败不提交。
- [x] 聚焦 RED/GREEN、真实 CPU 固定 seed/sample PNG 与逐角点对照、硬件 WebGL 像素/CPU bounds/pick 对照。
- [x] 单轮安静窗口受控大资源 ABBA，保留暖机/全部正式样本/GC/原始内存口径与文件 SHA；不把 JS heap 当总内存。
- [x] 独立审查最终 SHA 与修复负例复核完成：`independent-review.json`，批准实现与本地证据，组合验收交 root。
- [x] root最终lighting-unified42/42、bake246/246、build5 Electron/Editor/Viewer、实际Cycles和真实新DIST Viewer通过；source/dist Python同SHA，300个最终Viewer输入重核不漂移。

## 数据精度与格式

源头仍保留输入 Float64 与空间切片的 Python double 插值；`export_geometry` JSON 兼容入口不变，B6 收集只提取成 `collect_export_geometry`，没有修改 tuple、首次出现顺序或几何值。新作业调用 `write_export_geometry`，选择格式后才写同一数据。

`encode_export_geometry_binary` 对 positions/normals/uvs/uvs2/colors/tangents/bakeUvs 的全部存在值生成 array('f')，与原值逐个 `<d` 字节比较；索引必须可保持 Uint32。负零也必须相等。0.1、nextafter、溢出和比最小 Float32 subnormal 更小的值均保留旧 JSON。小头条件（含 key 的 JS UTF-16 长度/NUL）不满足时同样原 JSON；合法近4096输入 key 经 `/tile:` 追加变长仍可正常输出 JSON。

binary-v1 文件：8字节 `BLGOUT01`、uint32LE headerLength、最多65536字节严格 UTF-8 JSON header、0填充至4字节对齐、连续 little-endian payload。头字段固定 `version:1`、`geometryVersion:2`、`key`、`vertexCount`、`indexCount`、`attributes`；每通道 descriptor 固定 type/components/count/byteOffset（文件绝对偏移，count为scalar数）。必需 positions(3)/normals(3)/uvs(2)/bakeUvs(2)/indices(1)，可选 uvs2(2)/colors(4)/tangents(4)。不允许未知字段或尾字节。它与输入侧 BLGEO001/Float64 附件相互独立。

正常对齐输入使用同一 ArrayBuffer 视图；未对齐 Uint8Array/Node Buffer 用 `new Uint8Array(bytes)` 复制当前文件范围并返回 `storage:'aligned-copy'`；大端宿主有显式 DataView 转换路径。没有把 Buffer.slice alias 当复制。生产浏览器 fetch 的完整 ArrayBuffer 对齐，无需这条复制路径。

## 改动范围

9个产品文件：`cycles_bake.py`；shared Data/Contract/Artifacts 与新 `sceneLightingBakeGeometryBinary.ts`；`lightingBakeService.ts`、`sceneLightingBakeResources.ts`；runtime resources 与 SceneLightingRuntime 仅 snapshotKey。格式 dispatch 明确，不猜 magic、不把解码失败降级为 JSON；service 同时检查扩展名、实际容器、版本。错误仍清理本任务 `.pending`，正式旧结果保留。

通用 Electron 协议流、SOURCE/DIST 复制代码无需修改，原受控资源 gate 已扩展为仅 geometry+binary-v1 接受 `.bin`。`docs/hybrid-lighting.md` 更新派生 v2/无损 binary、保存发布及用户明确的新场景 auto/旧缺省 CPU 说明。package/统一入口/root task-log 由 root 登记；不独立刷新旧编译产物作为最终交付。

## 检查与证据

独占证据根：`output/render-optimization-q1-20261024/b7/`。

- `lightingGeometryBinary.test.ts` 首先以缺少 codec 的真实导入 RED，加入 codec 后 typed-array validator/encoding metadata 两项仍 RED，再补产品 GREEN；覆盖全部 malformed 头/数值、旧 JSON、真视图、非对齐 Buffer/sentinel。
- `cycles_geometry_binary_checks.py` 先缺 gate RED，之后5项 GREEN；所有7个float通道 decimal/nextafter/overflow/underflow、最小subnormal、signed zero、UTF-16/astral/NUL与旧 JSON byte oracle。该项是 stdlib 生产函数检查，不能冒充 Blender 执行。
- Node 聚焦16项及两项真实 NullEngine state metadata-only cache 回归已通过，随后增加“同一snapshot并存v1 JSON/v2 JSON/binary”用例并定向重跑resource4项通过（有效合计19项Node检查）。另存为/移动原工程/重开、授权、kind/encoding/extension、目录逃逸与 Junction、取消/坏文件 pending 原子性、四 worker 失败纹理释放、SHA/length 优先均覆盖。Texture stub 仅用于错误生命周期，不代表 GPU。限定8入口 TypeScript noEmit（含node/vite/global声明）通过；ESLint零错误/零警告、py_compile与相关diff-check通过，完整记录 `final-validation.json`。
- `real-cpu-comparison/report.json`：Blender 5.2.2 LTS，实际 CPU，seed20261024，samples16。B6 JSON vs B7 binary 七表面共252角点，所有通道展开 `<d` 字节及原 indices 相等；实际 PNG 4194304 分量最大差0。B6 JSON 12754B→七个完整带头 binary 11304B（以逐文件报告为准）。首次 test 把 indexed B6 当旧 corner reference 使用导致 oracle 失败，已修为先独立展开参考；未降低数值标准。
- `real-service/report.json`：实际 service 启动 source Blender 主程序，7表面中6 binary+1不可精确UV2的旧JSON，save/重开/SOURCE ZIP/DIST准备复制均9资产，encoding/geometryVersion/byteLength/SHA 保持。没有遗留 pending。SOURCE为实际ZIP；DIST只执行 `prepareDeploymentExport` 与 `copyDeploymentFiles`，尚未生成最终发布DIST ZIP或打开实际Viewer，不据此宣称完整发布端到端验收。
- `lightingGeometryBinaryFiles.test.ts` 提取实际 `main.registerEditorAssetProtocol` handler，仅替换 Electron 协议注册器；原授权、专用路径gate、文件流、ETag/304与403实际运行。没有用此项宣称打开了最终安装版 Electron 窗口。
- `hardware-webgl/report.json`：实际 Chrome/Intel UHD630 ANGLE D3D11 WebGL2，6组（3 binary含完整可选通道，3 JSON精度fallback）各262144 RGBA分量，合计1572864分量差0；18次实际pick均命中，faceId/重心/距离/点/法线/CPU bounds完全一致。`grid-v2.png`已打开检查，非空正常着色；不是软件渲染或独显烘焙证明。

独立审查发现并补修：未对齐 Node Buffer.slice 实为 alias；producer未同步长key/UTF16资格会生成自身decoder拒绝的文件。两个负例均在聚焦回归中覆盖，最终审查报告独立留存。最终SHA清单及计时版本清单分开保存，见下。

## 单轮大资源加载/内存 ABBA

`lightingGeometryBinary.load-abba.mjs`：安静窗口内唯一一轮 warm-A/warm-B/A1/B1/B2/A2。受控 synthetic 512×512 dyadic grid，263169顶点、524288三角面，生产 Python gate 生成 binary；运行前逐分量 Object.is 对照全部数据。输入/字节/SHA见 `load-abba/input.json`。这不是工厂/展会业务场景。

每轮新 Chrome 进程、实际硬件 WebGL、imports/建 context在计时前、显式GC；实际走 HTTP读取→byteLength/SHA→production decoder/validator→实际PNG/Texture→VertexData GPU buffer上传。load与upload分段，未把独立语义digest循环算入收益。

| 样本 | JSON或binary | load+upload ms |
| --- | --- | ---: |
| warm-A | JSON | 404.600 |
| warm-B | binary | 251.600 |
| A1 | JSON | 412.700 |
| B1 | binary | 286.300 |
| B2 | binary | 252.200 |
| A2 | JSON | 372.500 |

正式均值392.600→269.250ms，-31.4187468%。输入JSON 29796528B→binary16818744B，-43.5546853%；4204554个scalar逐值Object.is相等。每轮全部owned renderer中最大生命周期峰值工作集，正式均值253624320B→199645184B，-21.2831072%；binary另明确保留16818744B外部backing buffer，未把它从总内存观察中忽略。`load-abba/summary.json`保留分段与复算。

所有原始行、GC、加载/上传阶段、renderer PID、前缀与持有/释放后的 WorkingSet64/PeakWorkingSet64/PrivateMemorySize64、阶段JS heap及外部ArrayBuffer大小保留在 `load-abba/report.json` 和每轮 JSON。JS heap只是阶段观察下界；Windows隔离renderer生命周期峰值工作集含外部buffer/native host内存，包含imports前缀且没有把它称为整个Chrome/系统峰值或VRAM。多个renderer各自峰值不同时，不能简单相加宣称同步总峰值。

计时使用的codec已修Buffer复制，但Python的长key资格补修在计时后。`load-abba/product-sha256.json` 保留计时版本，`product-freeze-sha256.json` 是最终版本；受测固定短key与数值完全相同，资格补修不改变受测路径，但不能把两个源SHA描述成同一文件版本。没有追加第二次计时或选择性删异常样本。

## 登记建议与剩余边界

root可登记快速单元：`lightingGeometryBinary.test.ts`、`lightingGeometryBinaryFiles.test.ts`、`lightingGeometryBinaryPromotion.test.ts`、`lightingGeometryBinaryResource.test.ts`、`lightingGeometryBinaryRuntime.test.mjs` 和 `cycles_geometry_binary_checks.py`；runtime用 `--experimental-transform-types`，不能只strip参数属性。实际 CPU、service、WebGL与load-abba为独立手动/重型入口，不默认运行正式基准。已有 B6 private promote AST测试只补了新decoder依赖，旧断言保留。

未证明业务大场景Float32资格率、真实独显Cycles或安装版/在线发布；普通输入含非精确optional属性或切片插值时安全回JSON，因此格式收益覆盖率须按真实资产报告。没有宣称FPS/MQTT业务回放收益或任意全链路内存上界。

组合必要校验：当前LD7 `deploymentPrecompression.ts`仅匹配mjs/js/css/json/wasm，没有.bin。若仅gzip_static服务器因此返回raw binary，可能大于旧压缩JSON；已报告root，由LD7唯一owner补受控geometry binary侧车及解压SHA/预算/实际DIST ZIP+Viewer闭环。B7未越域修改LD7，不把本地raw HTTP ABBA当作已验证的压缩部署收益。

## build5真实DIST与Viewer组合验收

build5 full exit0后复用原真实capture/CPU烘焙scene，重新调用最新compiled packager，强制noNewBake/noOldZip。新ZIP16636389bytes、750文件、480侧车，SHAa8274eb7620a491e5f581473dda96bf0938bca040295b1a27899ff7664c98a20；111552个原角点分量再次核对。2BIN+1JSON、br/gzip解压字节与原资源SHA、原URLgzip、3GI代理shader active及两格式真实pick/bounds全部通过。

Intel UHD630/WebGL2截图184311变化像素/367色，root实际打开确认；与旧build3合格PNG逐字节相同。新startup operation guard版从document创建起错误DOM观察为空，6个就绪样本均无旧几何错误。300份产品/模板/工具输入前后SHA相同；page/console错误、WebSocket和外部请求均为空。driver exit0、browser/server关闭，原端口ECONNREFUSED。

最终证据output/render-optimization-q1-20261024/b7/build-5-default-off-viewer-2/final-evidence.json；实际ZIP/PNG位于b7/dist-viewer-acceptance/run-1792813643685-76af9ee3。后端runtime-config API仍是localhost协议夹具，静态三实体不代表生产后端/完整业务MQTT/性能。两个候选默认off包含在本版。首wrapper preflight递归错误在任何package/browser/bake前退出，旧失败保留，不称通过。
