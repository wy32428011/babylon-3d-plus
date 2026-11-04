/**
 * 关键事件为服务端 canonical 状态的派生索引，不执行脚本或重新请求业务来源。
 *
 * 集成：archive 已打开且绑定真实持久 HistoryFencingPort -> HistoryEventIndex.open() -> sync()。
 * 每次 sync 固定归档已提交上界并按 maxBatches 有界推进，hasMoreCommitted 为 true 时按同一 toCursor 继续。
 * 重启先从持久帧恢复 indexedThrough，再以 cursor-recovery 从真实检查点和连续已提交变化恢复 follower。
 * 同毫秒批次按 revision/ordinal 稳定排序；查询时间严格为 [from,to)，不以最大时间冒充后续同毫秒提交。
 *
 * 查询服务必须先校验自己的项目、版本、cacheRevision、权限和范围，再以其会话 ID 作为 owner：
 * openQuery -> readQuery（带 cursor 续页）-> closeQuery；direction 可正序或倒序，支持前后事件导航。
 * queryId/游标仅本进程有效，TTL 到期须重开。
 * 查询包含固定 indexedThrough；事件包含投影、版本摘要和源记录身份。任何缺口、超预算、断链或腐坏均抛出明确错误。
 * 本索引不删除历史文件：活跃会话不会丢依赖，但达到存储/恢复预算后会背压。生产留存需要另行实现受租约保护的索引段裁剪。
 * 文件哈希不是认证；本地目录需 ACL 保护。file-fsync 的目录项断电保证弱于 file-and-directory-fsync。
 */
export { HistoryEventIndex } from './HistoryEventIndex.ts';
export type { EventIndexStatus, EventQueryPage, EventSyncResult, HistoryEventIndexLimits, HistoryEventIndexOptions, OpenEventQuery } from './HistoryEventIndex.ts';
export { EVENT_PROJECTION_VERSION } from './projection.ts';
export type { HistoryEventType, IndexedHistoryEvent } from './projection.ts';
