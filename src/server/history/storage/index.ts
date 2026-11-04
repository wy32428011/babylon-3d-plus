/**
 * 服务端专用，不能打入 Viewer/浏览器包。
 *
 * 集成顺序
 * 1. 部署私有本地 rootDirectory；提供与持久授权变更互斥的 HistoryFencingPort。
 *    open() 恢复 identity -> 最新已提交元数据 catalog -> hash-chain journal -> 有界段尾。
 *    未完整提交的末尾帧可回退并通过 recoveryNotices 报告；完整帧校验错误、缺段/跳号直接失败。
 * 2. appendArrival() 保留业务载荷字节，不解析/去重；收到 CapturedReceipt 后才可确认传输接收。
 *    advance/gap 等控制观测也先通过 control envelope 分配同一 capture offset。
 *    认证头、URL、token 等不在 transport 白名单。业务载荷内部敏感信息仍由来源合同负责，
 *    本层不解析/改写原始业务字节，否则会损害证据保真性。
 * 3. 首次启用由已有内核校验权威基线并产生 revision 0 TwinCheckpoint。
 *    prepareProjection(checkpoint, dependencies) -> 外层登记候选准备证明 -> activateProjection(proof)。
 *    dependencies 必须包含真实的 publication/viewer/projector/kernel/scene/models/scripts/logic/source-contract 引用闭包。
 * 4. 每条已捕获输入：kernel.prepareInput(input) -> archive.prepareCommit({input,batch: prepared.batch})
 *    -> archive.commitPrepared(proof) -> prepared.commit()。最后一步才改变内核内存态。
 *    持久成功后内核内存提交失败时必须停止 worker 并 recoverProjection()，不能再次执行业务副作用。
 * 5. 重启先 recoverProjection()；它校验最近检查点和其后连续已提交变化，只使用 canonical-follower。
 *    然后 TwinStateKernel.fromCheckpoint(result.checkpoint, registry, {mode:'projector', ...})。
 *    未投影的原始输入用 openCaptureSession(result.unprocessedAfter) / readCaptured() 有界追赶。
 *    open() 只完成元数据/文件长度恢复，不冒充所有历史内容均已解码；worker 就绪须等 recoverProjection 成功。
 * 6. 周期 putCheckpoint(kernel.checkpoint()) 独立于实时 commit；compact() 封存有界段后在 gate 外 gzip。
 *    已提交热变化不等待两者。checkpointCatalog() 或自动日志阈值建立元数据快照，不逐条重写全量索引。
 *
 * 查询
 * - openReadSession({mode:'as-of', projectionId, targetTime}) 固定版本、检查点和精确原子修订上界。
 *   readCheckpoint() 后依次 readChanges()；actualTime 始终是实际应用的业务时间，不自动冒充 requestedTime。
 * - mode:'changes' 的 afterCursor/toCursor/throughTime 固定；分页不拆原子修订，必要时重封同一 schema 的批次切片。
 * - queryableThrough 仅表示本投影当前连续保留链的时间水位，须同时检查 retainedFrom 和 continuity；
 *   读取时仍逐记录/压缩段校验 SHA-256。不存在“跳过坏文件继续报告完整”的恢复路径。
 * - 页数、实际磁盘读取+解压字节、膨胀比、并发和 TTL 有上限；closeReadSession() 及时释放。
 *   查询 lease 持久化，但分页游标属于当前进程；进程重启返回 SESSION_RESTARTED，旧 lease 到期前仍保护资源。
 *
 * 留存
 * - planRetention({retainFrom}) 是已授权留存决定的持久提交：先裁剪新查询可见范围，返回恢复锚点闭包的保留/释放引用。
 * - applyRetention(planId) 才删除计划中精确路径/尺寸/hash 匹配的自有文件；活跃读取 pin 会使删除延后。
 *   完成的计划也跨重启保留；外层处理依赖引用事务后显式 acknowledgeRetention(planId)，再释放幂等记录。
 * - 保留窗口起点 <=T 的完整检查点、其后全部变化、未完成候选和版本依赖；不会清理目录、外部发布资源或未知文件。
 *   releasedDependencies 只供外层资源保留事务消费，绝不等同于 Java 已提交/已清理。
 *
 * 持久性与平台限制
 * - 默认 file-and-directory-fsync 依赖本地文件系统正确实现 fsync、原子 rename 和排他创建。
 *   Windows 的 Node 目录 fsync 通常不可用，默认会明确失败；只能显式选择较弱的 file-fsync。
 *   file-fsync 只承诺已 flush 的文件内容和进程崩溃恢复，不承诺断电后的目录项持久性。
 * - 任何文件 fsync 失败都拒绝确认，并冻结实例等待重新恢复；失败返回不表示该写入必然未落盘，需按原 proof 查询。
 * - 可选 SqliteHistoryFencing 使用 Node 内置 SQLite 的本地排他事务和持久代次；首次仅允许空域显式初始化。
 *   可信部署必须让同一项目/关联域在所有进程和纪元始终指向唯一物理根，并独立保留权威代次高水位。
 *   运行期间禁止替换、复制恢复或回滚授权库；故障恢复须先停尽所有 writer 并由外部高水位对账，不能用 current() 自证。
 *   不支持 NFS/SMB 多机共享写入；每个实例固定一个 captureEpoch，关联域只有一个拥有者。
 *   旧纪元的跨进程并发查询需由外层拥有者路由，本层不提供绕过所有权的 reader-only 打开方式。
 *   不得用内存 Mutex/租约超时假装实现持久 fencing。
 *   崩溃锁仅在外层持久换代后显式提供 reclaimAbandonedWriter，严格核对原 owner/token；从不杀进程。
 * - 单实例拥有关联域写锁；查询工作可与采集异步并行，但此库不是跨进程共享读锁服务。
 *   哈希保护完整性，不是攻击者认证；目录 ACL、授权端口和承载进程必须可信。
 * - 所有容量都是硬上限，不是已测吞吐承诺。maxStoredBytes 包含 journal/catalog 换代预留；
 *   元数据目录采用有界内存索引及周期 catalog，达到 maxIndexEntries/maxCatalogBytes 时明确背压。
 *   未公布的 catalog/temp 或未知段不猜测删除，会计入容量；需要显式运维处置，不能用通配清目录。
 * - 本地 WAL 不提供磁盘/整机冗余，MQTT QoS/持久会话/ACK 时机与 HTTP 只读采集由上层适配器负责。
 *   未接 broker/HTTP、Java th_runtime_commit、对象存储或外部发布资源删除，不声称端到端零丢失或生产吞吐。
 */
export { DurableHistoryArchive } from './DurableHistoryArchive.ts';
export { SqliteHistoryFencing } from './SqliteHistoryFencing.ts';
export type { SqliteHistoryFencingOptions } from './SqliteHistoryFencing.ts';
export { DEFAULT_ARCHIVE_LIMITS } from './primitives.ts';
export * from './types.ts';
