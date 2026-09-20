# 发布 Viewer 缓存

更新编辑器后重新发布一次数字孪生，浏览器首次完整加载会建立缓存。后续刷新仍检查 `runtime-config.json` 和中台项目运行配置，同一发布版本的场景文件和资产优先从 IndexedDB 读取；再次发布产生新的 `cacheRevision`，新版本第一次访问会重新下载。回滚到历史版本时，其浏览器缓存仍存在即可复用。

## 缓存范围

- 缓存当前部署的场景、资源清单及 `project/assets/` 下的静态文件，包括模型包外链资源、普通纹理、模型脚本和天空盒。
- 持久复用 Draco、Meshopt 的 CPU 几何数组、KTX2 的各级 mipmap 转码数据；不保存 Babylon 场景实例、材质实例、动画运行状态或 GPU 句柄。
- 解码键包含发布标识、部署地址、引擎/算法版本、压缩字节 SHA-256 和解码参数。KTX2 还包含显卡压缩格式能力和默认解码选项。读取损坏记录时重新解码；失败和取消不保存为有效结果。
- HDR 与已有支持的 EXR 压缩格式复用原有天空盒解码缓存。普通 PNG/JPEG 解码、glTF 场景解析、脚本执行、GPU 上传、着色器准备和天空盒预过滤仍会发生。刷新后完全没有初始化耗时并不是本功能的承诺。
- HTML/JS/CSS 和解码器程序由原有浏览器 HTTP 缓存管理；实时接口、MQTT、项目启停配置、其他来源与部署目录外资源不进入新的资产缓存。

## 版本与异常处理

入口配置每次以 `no-store` 获取。没有 `cacheRevision` 的旧发布包不启用持久缓存，保持原有读取方式。新版本对未缓存文件使用网络读取，并在存储前再次核对发布标识；稳定地址在下载期间切换版本会明确报错，重新加载后读取新版本，不回退混用同名文件。旧发布包的 Viewer 不会因更新编辑器而自动变化。

浏览器缓存是可回收的加速数据。资源和几何/纹理解码数据共用 1 GiB / 4096 条上限，单条超过 512 MiB 不缓存，采用 LRU 淘汰，元信息与大数据分表并原子提交。天空盒解码保留原有独立 128 MiB / 8 条限制。清理浏览器数据、无痕模式限制、磁盘压力、超限或缓存损坏都可能导致同版本重新下载/解码；不会因此阻止场景正常加载。

IndexedDB 打开和事务有超时；存储拒绝或额度不足只报告一次警告并降级，本次仍按正常资源链路完成加载。Viewer 销毁时取消缓存请求、恢复 Babylon 接口并释放临时 URL，不改变编辑器加载行为。

## 验证

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/digitalTwin/publishedAssetCache.test.ts tests/runtime/skyboxTextureLoad.test.ts tests/runtime/skyboxContentHash.test.ts
npm run typecheck
npm run build:viewer
node scripts/smoke-published-cache.mjs '<含 Draco 的 GLB 路径>' '<含 KTX2 图片的 GLB 路径>'
node scripts/smoke-published-viewer-cache.mjs '<已有发布 scene.json 路径>' '<含 Draco 的 GLB 路径>'
node scripts/run-digital-twin-publish-integration.mjs
```

浏览器回归使用独立测试服务与浏览器上下文，依次执行首次加载、刷新、新版本和回滚。测试服务对资源设置 `no-store`，通过服务端请求计数确认缓存效果；真实 GLB 进入 Babylon/WebGL，并比较几何哈希和渲染像素，KTX2 实际转码并上传 GPU。报告和截图输出到 `output/playwright/published-cache/`。此验证不能替代真实业务项目的重新发布与线上浏览器验收。

`smoke-published-viewer-cache.mjs` 直接运行生产构建的 Viewer，从已有发布文档构造一个独立模型夹具，原场景文件不写回；校验首帧完成、场景/清单/模型请求计数、持久解码读写，以及每次刷新仍实时读取项目配置。结果输出到 `output/playwright/published-viewer-cache/`。
