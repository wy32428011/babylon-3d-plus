# Q1 / LD7 DIST 预压缩

日期：2026-10-24。主代理确认写域。仅本仓库 DIST ZIP 的私有 staging 增加可选传输侧车；不改 CentralDataPlatform、不重启服务、不外部发布，不接触 B6 的 Data/Contract/Artifacts/Service/Python。

## 验收清单

- [x] 原文件和本次原 release-cache-manifest 的 byte / SHA / size / storage / cacheRevision 不变。
- [x] 所有原文件及完整清单落盘后、ZIP 前生成 .br / .gz；JS/MJS/CSS/JSON/WASM/BIN 有界流式压缩，只保留更小表示，根控制入口不压缩。
- [x] URL 编码只还原一次，中文/#/%/空格可用；重复、逃逸、链接及同名侧车不覆盖。
- [x] 压缩取消/失败停止派发、排空全部在途流，再回收本次临时文件及已提交侧车，原文保留。
- [x] 预算计入原 staging 的全部文件、控制入口、完整清单、子目录和空目录；100000 按接收端 ZIP entry 而非仅 file 计数。原包本身超预算时仅跳过可选侧车并诊断，不新增原业务硬失败。
- [x] 侧车触及既有 ZIP 字节上限时，只撤回本次侧车并重打原包；已有同名 .gz 保留，公共 fileCount 只统计实际文件，内部 finalEntries 与实际 ZIP 条目一致。
- [x] 单元 15 项通过，包含真实多目录 ZIP、原包条目已超只跳过、220/253 字符文件名边界；原始响应体 SHA 与缓存键不变。
- [x] 修后产品 SHA 的 actual DIST / HTTP 回归通过，根代理 build-electron-ld7-reviewed exit0 后执行，下文列最终数据。
- [x] 原scripts/smoke-published-cache.mjs生产模块图组合6通过，实际Babylon/Draco/KTX解码与冷/刷新/新版本/回滚均有记录；最后三处浏览器globalThis等价lint修正经独审，响应专项不替代该GPU集成证据。
- [x] code-reviewer 独立审查两 P2 已修复并定向 2/2 GREEN，最终结论 APPROVE_LOCAL_SCOPE_NO_OPEN_P1_P2，报告 output/render-optimization-q1-20261024/ld7-independent-review.json；产品再次 freeze，根代理统一构建及 package/manifest 入口登记。
- [ ] 跨仓库 Nginx 模板实际配置、nginx -t/重载及线上验证另行授权；本轮仅提供文档片段，不称线上完成。

## 实现与兼容边界

入口 electron/ipc/digitalTwinDistPackage.ts：复制、预编译、生成原文件与 release manifest 完成后才调用 deploymentPrecompression。压缩默认并发 2，上限 4，Brotli quality 6 / gzip level 9；按原清单及 br→gzip 顺序确定性提交，不按并发完成顺序选择预算。提交前使用 wx 独占目标，只替换本次空占位；已存在文件/目录跳过并诊断。

每个原文件在压缩流中核对大小和 SHA-256，并比对前后 stat。固定短 .dtpc-UUID 临时 basename，避免合法长原文件名追加临时后缀而失败；最终侧车组件超本平台长度时可选跳过。临时文件及本次侧车只在任务私有 staging 内清理，不触碰外部文件。

内部 precompress:false 保留原包 A/B；maxPackageBytes 只允许缩小既有 2 GiB ZIP 限额，不暴露 UI。内部 maxFiles 仍使用早期参数名，但语义为接收端 ZIP 条目（包括目录），预算结果分别报告 originalFiles/originalDirectories/originalEntries/finalFiles/finalEntries。

接收端预算来源：只读核对 CentralDataPlatform 的 EditorNginxPublishAppService 与 DigitalTwinDistArchiveValidator。解压总量 2 GiB，最大 ZIP entry 100000。原 manifest 枚举既有 200000 文件安全限制不变；helper 仅做预算盘点，不叠加默认扫描上限，避免清单落盘增加一个文件后出现新硬失败。

## 测试与审查记录

命令：

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/digitalTwin/deploymentPrecompression.test.mjs
node node_modules/electron/cli.js tests/digitalTwin/releaseCacheManifestPackages.integration.mjs
$env:RESPONSE_CACHE_OUTPUT='C:\temp\babylon-3d-plus\output\render-optimization-q1-20261024\dist-precompression-http'
node scripts/smoke-published-response-cache.mjs
npx eslint electron/ipc/deploymentPrecompression.ts electron/ipc/digitalTwinDistPackage.ts scripts/smoke-published-response-cache.mjs tests/digitalTwin/deploymentPrecompression.test.mjs tests/digitalTwin/releaseCacheManifestPackages.integration.mjs
```

TDD：缺少 helper 时 RED；旧 publisher 未生成侧车时 actual integration RED。独立审查另发现两个 P2，新增的真实含目录 ZIP 与长 basename 用例均先 RED，再修复至 GREEN；并非修改期望值掩盖错误。最终 15/15 unit，记录 output/render-optimization-q1-20261024/dist-precompression-unit.log。200001 文件扫描边界使用独立 Node 子进程的可控 scanner，未创建 20 万个真实文件；多目录/空目录 ZIP 和长文件名使用真实文件系统与 Archiver。

修后版本已重新通过 actual ZIP/HTTP。旧版证据先复制到 output/render-optimization-q1-20261024/pre-review/，所有旧 release 夹具仍保留。最终版本证据：dist-precompression-package.json/.log、dist-precompression-http/report.json/run.log、dist-precompression-evidence.json（source/test/compiled/report SHA）。实际包 13 原文件 + 5 目录 = 18 条目，加 9 侧车后 22 文件 / 27 条目，与预算一致；ZIP 含侧车 8567 字节，原包 5600 字节；测试预算 7083 字节触发只撤回侧车，回退包 5603 字节，已有 .gz 保留。不同发布的 cacheRevision 随机且 ZIP 元数据不同，不能把几字节差异解释为原文改变。生成清单、压缩中、ZIP 回退 3 处取消均收回本任务全部 staging/ZIP。

响应专项使用实际 helper 生成的磁盘侧车；原 URL 由隔离 HTTP 服务根据 Accept-Encoding 返回，全部 no-store，Chrome/临时 profile/端口 0 独立。16 个 identity/gzip/br 的协商、MIME、解压后大小/SHA 检查；SW CacheStorage 与真实 PublishedRawStore/PublishedAssetCache 进行冷/热/新版本/回旧版验证，decode 使用 JSON 解析示例，不能替代 Babylon KTX/Draco 或 GPU 结论。合成资源原文共 458775 字节，冷 gzip 传输 1281 字节，冷 Brotli 166 字节；两格式热启动与回旧版传输均 0，原始资源下载 0、decodes 0、decodeHits 1、storageFailures 0。16 项协商及大小/SHA/MIME 均通过。另保留 SW 重启、损坏修复、配额故障、Range、跨 session 取消与超长响应中止回归，均通过。

使用高重复的 JS/CSS/WASM/GI JSON 合成资源，不能将压缩比例外推实际项目；未测现场带宽、真实业务首帧、线上 Nginx 或包装耗时净收益。所有测试拥有的 app/Chrome/server 在 finally 中关闭。

## 运维文档与未完成项

现有 docs/published-viewer-cache.md 增加原始 SHA/侧车语义、预算、gzip_static 模块前提，以及已安装/加载 Brotli static 模块时的条件配置。保留 release immutable、控制入口 no-store、缺文件 404 和原 MIME。模块条件引用 Nginx 与 ngx_brotli 官方资料。未发现 PATH 中的 nginx，本轮未运行或重启任何 Nginx，未修改另一仓库模板和 JAR 同步流程。全局任务入口及 task-log 由根代理统一更新。

产品 freeze：helper 2f6c90fae891fcf1a821b725165fe91c784daa78be344b7f394d9c3f9d3d4be9；publisher 108ee59106b8b3aca1079db0fb32f0f187059269a293d3a741c3d06412761045。

## B7二进制组合补充（2026-10-24）

根代理增加受原清单控制的BIN可选侧车，避免新二进制几何只裸传而旧JSON可压缩的组合回退。真实B7合同fixture先RED（侧车为空），仅扩展扩展名后16/16 unit GREEN；有效binary经br/gzip逐字节还原、原SHA/清单不变、预算不足时只跳过侧车。第一轮测试误用了decoder返回字段resource，已校准为实际geometry，只有随后正确侧车缺失RED作为产品回归依据。

`ld7-bin-http-1/report.json`：20项原URL的identity/gzip/br协商、MIME与解压SHA通过，binary 49740B→gzip376B/br220B，application/octet-stream保持；五类高重复合成资源共508515B→gzip1657B/br386B，暖/换版暖/回旧版传输0。合成比例不外推真实工程。原Babylon/Draco/KTX缓存smoke有效报告另见`published-cache-combined-6/report.json`。

本次helper SHA 2f0fe07e8db3bc67aaf54c7ea967f5a33bbba096b9e8e90ff4a936c987dd9c47；build-electron-b7-ld7-bin exit0，build-3-b7-ld5完整Editor/Viewer构建exit0。独立review和B7最终实际ZIP/Viewer仍在收束，不把早期helper SHA的ZIP证据称为本次组合已完成。

## 最终build5混合GI ZIP复核

最终真实packager产生的新ZIP含750文件/480侧车，16636389bytes，SHAa8274eb7620a491e5f581473dda96bf0938bca040295b1a27899ff7664c98a20。两份BIN均有实际br/gzip且逐字节还原，原release manifest与decoded SHA保留，预算无回退，Viewer原URLgzip实际运行通过。详见b7/build-5-default-off-viewer-2/final-evidence.json，不以旧ZIP冒充build5。没有部署Nginx或外部发布。

最新统一Node入口16/16与入口审计通过；smoke脚本三个浏览器closure window改globalThis以通过no-undef，独立逆向SHA确认仅这三处，第二轮ESLint exit0。原缓存smoke有效生产模块图、Draco/三类KTX分项证据不变。
