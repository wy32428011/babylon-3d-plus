import type { HistoryMqttSourceConfig, HistorySourceCredential } from '../../../../electron/shared/historySourceConfig.ts';
import type { HistoryProjector } from '../projector/HistoryProjector.ts';
import type { CapturedReceipt, DurableHistoryArchive, HistoryDurability, HistoryWriter } from '../storage/index.ts';

/** 由可信服务端按项目、来源及冻结合同授权；来源配置不能自行扩大主题或目标。 */
export type MqttAllowedTarget = {
  projectId: string;
  captureDomainId: string;
  sourceId: string;
  authorityScope: string;
  sourceContractId: string;
  hostname: string;
  port: number;
  pinnedAddresses: string[];
  topics: { filter: string; qos: 0 | 1 | 2 }[];
};
export type MqttIntegrityCode =
  | 'UNCLEAN_RESTART' | 'SESSION_NOT_PRESENT' | 'SESSION_STATE_UNKNOWN' | 'SESSION_EXPIRY_SHORTENED'
  | 'SUBSCRIPTION_RECOVERY_UNCERTAIN' | 'SUBSCRIPTION_REJECTED' | 'DISCONNECTED' | 'COLLECTOR_STOPPED'
  | 'CAPTURE_FAILURE' | 'STATE_FAILURE' | 'RECOVERY_UNPROVABLE' | 'PACKET_CONFLICT' | 'PACKET_LIMIT';
export type MqttIntegrityEvent = {
  eventId: string;
  sourceId: string;
  sourceContractId: string;
  captureDomainId: string;
  captureEpoch: string;
  at: number;
  code: MqttIntegrityCode;
  /** 缺口边界由协调者持久化和对齐；不表示完整回放已经就绪。 */
  requiresGap: true;
};
export type MqttCollectorStatus = {
  phase: 'starting' | 'connecting' | 'subscribing' | 'collecting' | 'disconnected' | 'blocked' | 'stopped';
  sourceId: string;
  clientId: string;
  code: MqttIntegrityCode | null;
  /** 此状态只说明接收链，不是基线、业务投影或历史查询就绪。 */
  historicalReadiness: 'not-established';
};
export type MqttCollectorOptions = {
  source: HistoryMqttSourceConfig;
  sourceContractId: string;
  protocolVersion: 4 | 5;
  /** MQTT 5 必须指定非零的服务端会话保留秒数。 */
  sessionExpirySeconds: number;
  allowedTargets: readonly MqttAllowedTarget[];
  /** 服务端注入的私有本地目录，必须预先存在；不接受符号链接。 */
  stateRootDirectory: string;
  archive: DurableHistoryArchive;
  /** 在接受第一条输入前核对归档与来源合同，不能先写入错误归档再拒绝 ACK。 */
  projector: Pick<HistoryProjector, 'capture' | 'archiveId' | 'sourceContractId'>;
  /** 必须与 archive 使用同一个持久 fencing gate，不能仅用进程内锁。 */
  fencing: Parameters<typeof DurableHistoryArchive.open>[0]['fencing'];
  /** 崩溃遗留锁只允许在外层持久换代后，明确指定先前 owner。 */
  reclaimAbandonedWriter?: HistoryWriter;
  /** 默认和 archive 一致；较弱 file-fsync 不保证目录项的断电持久性。 */
  durability?: HistoryDurability;
  getCredential: () => Promise<HistorySourceCredential>;
  /** 必须真正持久化缺口或拒绝；失败将阻止确认和连接。不得记录载荷、地址或密钥。 */
  onIntegrityEvent: (event: Readonly<MqttIntegrityEvent>) => Promise<{ durable: true }>;
  onReceipt?: (receipt: Readonly<CapturedReceipt>) => void;
  onStatus?: (status: Readonly<MqttCollectorStatus>) => void;
  limits?: Partial<MqttCollectorLimits>;
};
export type MqttCollectorLimits = {
  maxPacketBytes: number;
  maxStateBytes: number;
  maxStateEntries: number;
  maxOrphanFiles: number;
  maxRecoveryPages: number;
  maxRecoveryBytes: number;
  reconnectDelayMs: number;
  connectTimeoutMs: number;
};
export class MqttCollectorError extends Error {
  constructor(readonly code: MqttIntegrityCode, message: string) { super(message); this.name = 'MqttCollectorError'; }
}
