# 发布 Viewer 缓存

更新编辑器后重新发布一次数字孪生，浏览器首次完整加载会建立缓存。后续刷新仍检查 `runtime-config.json` 和中台项目运行配置，同一发布版本的场景文件和资产优先从 IndexedDB 读取；再次发布产生新的 `cacheRevision`，新版本第一次访问会重新下载。回滚到历史版本时，其浏览器缓存仍存在即可复用。

## 缓存范围

- 缓存当前部署的场景、资源清单及 `project/assets/` 下的静态文件，包括模型包外链资源、普通纹理、模型脚本和天空盒。
- 持久复用 Draco、Meshopt 的 CPU 几何数组、KTX2 的各级 mipmap 转码数据；不保存 Babylon 场景实例、材质实例、动画运行状态或 GPU 句柄。
- 解码键包含发布标识、部署地址、引擎/算法版本、压缩字节 SHA-256 和解码参数。KTX2 还包含显卡压缩格式能力和默认解码选项。读取损坏记录时重新解码；失败和取消不保存为有效结果。
- HDR 与已有支持的 EXR 压缩格式复用原有天空盒解码缓存。普通 PNG/JPEG 解码、glTF 场景解析、脚本执行、GPU 上传、着色器准备和天空盒预过滤仍会发生。刷新后完全没有初始化耗时并不是本功能的承诺。
- HTML/JS/CSS 和解码器程序由原有浏览器 HTTP 缓存管理；实时接口、MQTT、项目启停配置、其他来源与部署目录外资源不进入新的资产缓存。

## 版本与异常处理

入口配置每次以 `no-store` 获取。新包对未缓存文件使用网络读取，并在存储前再次核对发布标识。读取场景后、创建三维运行时前再次复核版本；稳定地址在加载期间切换版本会明确报错，重新加载后读取新版本，避免热缓存中的旧模型与新版场景混用。

新版 Viewer 兼容没有 `cacheRevision`、但 `asset-manifest.json` 中每项都有完整 SHA-256 和大小的旧格式配置：每次启动实时读取场景与清单，以资源路径、大小和哈希构造稳定缓存版本，只缓存清单明确列出的部署资源。首次下载核对实际大小和 SHA-256，匹配后才写入；资源清单改变后使用新缓存分区。仅改变场景而资源字节不变时仍可复用模型与天空盒。缺少完整哈希、路径越界或清单冲突时保持联网加载。

已经部署的旧 Viewer JavaScript 不会因修改源码或更新编辑器而自动变化。需要使用包含此修改的编辑器/Viewer 重新发布数字孪生；正常重新发布会生成新的 `cacheRevision`。

浏览器缓存是可回收的加速数据。资源和几何/纹理解码数据共用 1 GiB / 4096 条上限，单条超过 512 MiB 不缓存，采用 LRU 淘汰，元信息与大数据分表并原子提交。天空盒解码保留原有独立 128 MiB / 8 条限制。清理浏览器数据、无痕模式限制、磁盘压力、超限或缓存损坏都可能导致同版本重新下载/解码；不会因此阻止场景正常加载。

IndexedDB 打开超时为 10 秒，事务以连续 30 秒没有请求进展判定停滞。缓存读取采用只读事务，访问时间在独立 metadata 事务中按批合并，避免大模型读取为更新 LRU 排队争抢写锁。事务已经提交或中止、但 JS 终态事件尚未派发时，不重复中止或误报超时，继续由终态事件结算；异步读写回调异常也会安全结算。存储拒绝或额度不足只报告一次警告并降级，同时释放其余在途缓存操作，本次仍按正常资源链路完成加载。Viewer 销毁时撤销缓存计时器和事务、恢复 Babylon 接口并释放临时 URL，不改变编辑器加载行为。

## 验证

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/digitalTwin/publishedAssetCache.test.ts tests/digitalTwin/publishedCacheStore.test.ts tests/digitalTwin/publishedCacheVersion.test.ts tests/runtime/skyboxTextureLoad.test.ts tests/runtime/skyboxContentHash.test.ts
npm run typecheck
npm run build:viewer
node scripts/smoke-published-cache-storage.mjs
node scripts/smoke-published-cache.mjs '<含 Draco 的 GLB 路径>' '<含 KTX2 图片的 GLB 路径>'
node scripts/smoke-published-viewer-cache.mjs '<已有发布 scene.json 路径>' '<含 Draco 的 GLB 路径>'
node scripts/smoke-published-viewer-cache.mjs '<已有发布 scene.json 路径>' '<含 Draco 的 GLB 路径>' --legacy
node scripts/run-digital-twin-publish-integration.mjs
```

浏览器回归使用独立测试服务与浏览器上下文，依次执行首次加载、刷新、新版本和回滚。测试服务对资源设置 `no-store`，通过服务端请求计数确认缓存效果；真实 GLB 进入 Babylon/WebGL，并比较几何哈希和渲染像素，KTX2 实际转码并上传 GPU。报告和截图输出到 `output/playwright/published-cache/`。此验证不能替代真实业务项目的重新发布与线上浏览器验收。

`smoke-published-viewer-cache.mjs` 直接运行生产构建的 Viewer，从已有发布文档构造模型与有效 HDR 天空盒夹具，通过带 `allow-same-origin` 的大屏 iframe 加载，原场景文件不写回；刷新宿主页，校验首帧完成、模型/天空盒实际请求计数、持久解码读写，以及每次刷新仍实时读取项目配置。分别覆盖带发布号的新配置和 `--legacy` 无发布号的完整哈希清单。结果输出到 `output/playwright/published-viewer-cache/` 和 `output/playwright/published-viewer-cache-legacy/`。

事务回归使用真实浏览器 IndexedDB 重放“原生事务完成，但应用完成回调晚于超时回调”的时序，并在 192 MiB 并发读写中模拟 3.5 秒主线程忙碌。完整 Viewer 回归另验证存储故障时只报告一次警告、首帧仍完成、恢复后原有缓存继续可用。存储回归报告输出到 `output/playwright/published-cache-storage/report.json`。
