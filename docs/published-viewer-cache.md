# 发布 Viewer 缓存

## 加载阶段与模型入场诊断

模型资源就绪后，Editor 运行预览和发布 Viewer 会分批准备入场材质，再验证材质与实际首帧，最后按原顺序播放开场和模型入场。准备期间显示“正在准备入场材质”及已准备/总网格数量；取消预览、切换场景或后续模型加载导致验证重启时，旧任务释放资源，新任务重新准备。现有模型、参数、入场范围和效果配置无需迁移。

首帧完成时，控制台的 `[Viewer loading] 场景首帧诊断` 包含运行时 `loading` 快照：`stages` 分别记录模型队列、容器整体加载、同步容器克隆、脚本整体初始化、入场准备和首帧验证；`resources.stages` 进一步记录发布缓存读取、网络请求/响应体、SHA-256 校验和缓存写入。`slowestAssets` 最多保留 12 项文件名与关联实体，不保留资源 URL 或本地路径。并行阶段的累计时间不能相加作为总加载时间，脚本与容器整体等待也不能直接当作纯 CPU 解码时间。

入场准备采用 8 ms 软批次预算，让出主线程后继续；单个材质克隆不可抢占。新材质的同步复制临时抑制重复的全场景标脏，恢复原状态后才挂载到网格，真实渲染验证仍保留。该路径依赖 Babylon 9.12 的内部开关恢复方法，升级 Babylon 时须运行 `tests/runtime/materialCloneDirtyGuard.test.ts` 及材质、入场、首帧回归。已部署 Viewer 需要重新发布数字孪生才能获得这些改进。

数字孪生 DIST 包按发布版本建立完整静态缓存。中台大屏“跟随当前发布”在每次打开/刷新时查询在线状态，选择本次响应的 release 地址；同版本刷新、关闭后重开、仅重新发布大屏布局均复用缓存。数字孪生重新发布产生新的 release 地址与 `cacheRevision`，首次访问新版本建立新缓存。已经打开的页面继续使用原版本。

## 启用与升级

1. 构建包含本功能的编辑器与 Viewer，并重新发布数字孪生。已部署的旧 Viewer 不会自动获得源码修改。
2. 部署新版中台前端和发布后端；重新生成、校验并重载 Nginx 模板配置。后端约束同一 release 路径内容不可变，同内容重试可复用，不同内容必须创建新版本。
3. 完整启动文件缓存需要 HTTPS 安全上下文，发布路径为 `/digital-twin/releases/{projectId}/{publishNo}/`（支持前置路径），iframe 保留 `allow-same-origin`。Service Worker 只注册该 Viewer 目录，不接管整个中台站点。
4. `http://localhost` / `127.0.0.1` 可用于开发测试；普通 HTTP 局域网 IP 不等同安全上下文。普通模型、环境模型（包括未激活变体）、天空盒及发布包内尚未使用的模型仍会全量写入 IndexedDB，同一发布版本刷新复用；缺少 `navigator.storage.estimate()` 不阻止缓存。启动文件使用普通 HTTP 缓存，Service Worker 不可用的原因仅在控制台记录，不在页面显示缓存警告，也不会误报整个发布包已完整缓存。

固定历史版本与手工 URL 保持原语义。旧接口无 release 地址时回退原 stable 地址，该地址不启用完整 Service Worker 缓存。显式项目归档覆盖可能重建既有路径，不属于正常不可变发布；覆盖后的缓存处理遵循中台归档运维流程，不能用普通同版本缓存承诺代替归档验收。

## 清单与缓存范围

打包完成后生成根 `release-cache-manifest.json`，运行配置通过可选字段 `cacheManifest` 引用。清单包括 `version: 1`、`cacheRevision`、`totalBytes` 与 `files`；每个文件包含 URL 编码相对路径、字节大小、SHA-256、Content-Type 及 `asset | response` 存储归属。旧的 `project/asset-manifest.json` 仍只负责逻辑资源映射，格式不变。

- `asset`：场景、资产清单、`project/assets/` 全部文件，以及内置漫游人物模型，使用按版本独立的 IndexedDB 原始文件库。包括模型及外链 bin/纹理、脚本、环境与天空盒；新版发布中的漫游人物也能在普通 HTTP 下跨刷新复用。
- `response`：Viewer HTML、JS、CSS、懒加载模块、Worker、解码器 JS/WASM、字体、图片及其它包内静态文件，使用 Service Worker + CacheStorage。旧清单将内置漫游人物归入 `response` 时保持兼容，需重新发布才能采用新的模型缓存归属。
- 控制入口 `runtime-config.json`、公开完整清单、Service Worker 脚本、项目运行配置不作为普通静态缓存响应；README 不纳入运行缓存。
- MQTT、业务 API、项目启停、外部来源、包外媒体与直播保持联网。外链静态媒体如需同等保证，应先由发布流程固化到包内；本功能不自动抓取外部 URL。
- 只缓存清单逐项授权的 GET 资源，路径越界、控制文件、非法归属与不一致大小/哈希均拒绝。带 Authorization、POST 等业务请求不进入响应缓存。
- 服务端静态文件缺失必须返回 404，不能回退为 200 HTML；无扩展名 SPA 路由保持兼容。

同一原始资源只由一种持久存储负责。模型读取和后台预热合并在途请求；天空盒带读取上限时，清单大小符合上限的请求也共享下载，已知超限直接拒绝，未知大小保留流式限额。安全上下文下跨页面写同一模型使用资源级 Web Lock 串行提交，避免遗留竞争写入的分块。首次页面在 Service Worker 接管前已经加载的启动文件需要补存，首次访问可以有额外引导请求；完整缓存后的正常刷新不重复传输清单内静态内容。

## 完成状态与容量

首帧完成后，以最多两个文件并行补齐清单。页面显示检查、缓存中的正常进度，成功提示短暂显示后自动收起；部分完成及失败不显示页面警告，由控制台 `[Viewer cache]` 记录原因、文件数和字节数，也可检查 `globalThis.__ZENDING_RELEASE_CACHE__`。只有所有必需文件持久保存、发布版本复核成功且完成记录提交后才标记完成。部分下载、存储失败、关闭页面或取消均不算完成，下次访问补齐缺项。HTTP 下 `partial` 可能仅表示启动文件无法使用 Service Worker；应分别检查原始资源的持久化和刷新下载情况，不能仅凭该状态判断模型没有缓存。

原始文件按 16 MiB 分块落盘，完成头最后提交。读取缺块或校验不符的文件时重新下载；大文件校验分块进行，并按时间预算让出渲染线程。原始文件独立于旧缓存 1 GiB / 4096 条 / 单条 512 MiB 的 LRU，不会被可重算解码数据逐项挤出。

可选完整缓存初始化（清单请求、响应体、存储与控制器接入）共有 15 秒预算；超时只取消缓存初始化并退回普通场景加载。

完整预缓存前尽量使用浏览器存储配额估算，统一核算 IndexedDB 与 CacheStorage，抵扣已有文件并为新增内容留 10% 元数据余量。缺少容量 API、估算字段无效或查询抛错时继续有界并发预取，由实际 IndexedDB 写入结果判断是否成功；查询抛错保留控制台诊断。已知空间不足时先删除旧通用缓存中明确的 `:decoded:` 记录，再重新预检；仍不足或实际写入失败时保留已缓存文件并正常按需加载，不虚报完成。

每个活跃页面持有发布版本的共享 Web Lock。仅对同项目、超过 7 天未访问、可获得排他锁的其它版本清空原始数据表及对应响应缓存；保留空数据库外壳，避免不可取消的 `deleteDatabase` 阻塞请求在稍后误删活跃数据。无 Web Locks 的环境不自动清理跨版本缓存。浏览器自身的站点数据清理、无痕限制与磁盘回收仍可能导致同版本补下载。

## 解码与兼容

Draco、Meshopt 的 CPU 几何数组和 KTX2 mipmap 转码数据继续复用原有缓存；键包含发布标识、部署地址、引擎/算法版本、压缩字节 SHA-256 和参数，KTX2 还包含 GPU 能力。HDR/EXR 沿用天空盒独立缓存。解码结果是可回收加速数据，不承诺永久保留。

普通图片解码、glTF 场景解析、脚本执行、GPU 上传、着色器准备和天空盒预过滤仍会发生。刷新需要重建 Babylon/WebGL 实例，本功能承诺同版复用静态文件，不承诺完全没有初始化耗时或实时网络请求。

没有完整缓存清单的发布包继续使用原有缓存路径。没有 `cacheRevision` 的旧配置在资源清单拥有完整 SHA-256 与大小时使用清单指纹缓存资产；场景与清单继续联网，非法旧清单降级正常加载。

IndexedDB 保留 10 秒打开超时、30 秒无请求进展超时、只读数据事务与批量 LRU 元信息更新。若 30 秒计时器因渲染长任务晚交付超过 1 秒，先给排队的 IndexedDB 事件一次 1 秒宽限；该宽限不会递归续期，仍无进展则中止。真实请求成功后才重新计算停滞周期，页面关闭仍即时取消。已完成事务的晚到事件不会被重复 abort。存储错误不阻断三维首帧，页面销毁会释放事务、计时器、临时 URL、资源等待与版本租约。

## 本地验证

```powershell
npm run typecheck
npm run build:viewer
npm run build:electron
node --test tests/digitalTwin/deploymentReleaseCacheManifest.test.mjs tests/digitalTwin/publishedResponseCache.test.mjs
node --experimental-strip-types --test --test-concurrency=1 tests/digitalTwin/publishedCacheSetup.test.ts tests/digitalTwin/publishedAssetCache.test.ts tests/digitalTwin/publishedCacheStore.test.ts tests/digitalTwin/publishedCacheVersion.test.ts tests/digitalTwin/publishedReleaseManifest.test.ts tests/digitalTwin/publishedReleasePrefetch.test.ts tests/digitalTwin/publishedReleaseStorage.test.ts tests/digitalTwin/publishedRawStore.test.ts tests/digitalTwin/publishedBlobHash.test.ts
node node_modules/electron/cli.js tests/digitalTwin/releaseCacheManifestPackages.integration.mjs
node tests/digitalTwin/publishedReleaseStorage.browser.test.mjs
node --test tests/digitalTwin/publishedReleaseHttp.browser.test.mjs
node tests/digitalTwin/publishedLargeRawStore.browser.test.mjs
node scripts/smoke-published-response-cache.mjs
node scripts/smoke-published-release-cache.mjs
node scripts/smoke-published-cache-storage.mjs
```

完整生产 Viewer 回归使用真实 Chrome、本地独立发布目录、宿主页 iframe 和 WebGL；服务端静态响应统一 no-store，以请求计数区分真实持久缓存与普通 HTTP 缓存。覆盖首次完整缓存、刷新、同 profile 浏览器重启、仅改变宿主参数、延迟资源、单文件缓存损坏、新旧版本并存和回到已缓存版本；另用非安全 HTTP origin 验证普通模型、环境模型、天空盒和未使用模型的冷启动、刷新零重复下载、数字孪生重发重新缓存及页面无缓存警告。报告与截图保存到 `output/playwright/published-release-cache/run-*/`。

响应缓存专项另外覆盖 Range、Worker 冷启动、存活 helper 重建会话、配额故障与跨会话取消。存储专项覆盖页面租约、旧版清理与大于 512 MiB 的合成文件分块保存。这些结果证明本地实现，不代表实际业务场景、线上反向代理、HTTPS 证书或已安装编辑器已经升级。
