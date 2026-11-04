import type { HistoryMqttSourceConfig, HistorySourceCredential } from '../../../../electron/shared/historySourceConfig.ts';
import { StateAdapterRegistry, TwinStateKernel, type DeepReadonly, type TwinBaseline, type VersionManifest } from '../../../runtime/history/state/index.ts';
import { MqttHistoryCollector, type MqttAllowedTarget, type MqttCollectorStatus } from '../mqtt/index.ts';
import { DurableHistoryArchive, type DurableCommitProof, type HistoryDurability, type HistoryWriter, type ProjectionDependencies } from '../storage/index.ts';
import { HistoryCaptureGate, type HistoryBindingDecision } from './HistoryCaptureGate.ts';
import { createHistoryControlArrival, HistoryInputNormalizer } from './HistoryInputNormalizer.ts';
import { HistoryProjector, type ProjectorStatus } from './HistoryProjector.ts';

export type HistoryCaptureMqttSource = {
  sourceRevision: string;
  config: HistoryMqttSourceConfig;
  protocolVersion: 4 | 5;
  sessionExpirySeconds: number;
  allowedTargets: readonly MqttAllowedTarget[];
  getCredential(): Promise<HistorySourceCredential>;
};
export type HistoryCaptureRuntimeOptions = {
  archive: DurableHistoryArchive;
  registry: StateAdapterRegistry;
  sourceContractId: string;
  mqttStateRootDirectory: string;
  mqttSources: readonly HistoryCaptureMqttSource[];
  fencing: Parameters<typeof DurableHistoryArchive.open>[0]['fencing'];
  reclaimAbandonedWriter?: HistoryWriter;
  durability?: HistoryDurability;
  /** 仅驱动在线推进；推进值先入 WAL，回放和恢复不读取墙钟。 */
  advanceIntervalMs?: number;
  onCollectorStatus?: (status: Readonly<MqttCollectorStatus>) => void;
  onProjectorStatus?: (status: Readonly<ProjectorStatus>) => void;
  onFailure?: (code: string) => void;
};
export type HistoryBaselineCandidate = {
  baseline: DeepReadonly<TwinBaseline>;
  dependencies: ProjectionDependencies;
};

/** 与编辑器进程无关的捕获协调器；完整性和历史可读状态只能由真实基线、持久回执及绑定事务证明。 */
export class HistoryCaptureRuntime {
  readonly #options: HistoryCaptureRuntimeOptions;
  readonly #gate: HistoryCaptureGate;
  readonly #collectors: MqttHistoryCollector[];
  readonly #interval: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #clockOperation: Promise<void> | null = null;
  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  private constructor(options: HistoryCaptureRuntimeOptions, gate: HistoryCaptureGate, collectors: MqttHistoryCollector[]) {
    this.#options = options; this.#gate = gate; this.#collectors = collectors;
    this.#interval = options.advanceIntervalMs ?? 250;
  }
  /** 只建立私有本地状态；调用 start 前不连接 broker。 */
  static async open(options: HistoryCaptureRuntimeOptions): Promise<HistoryCaptureRuntime> {
    const interval = options.advanceIntervalMs ?? 250;
    if (!options.sourceContractId || !options.archive.usesFencing(options.fencing)
      || !Number.isSafeInteger(interval) || interval < 50 || interval > 60_000
      || options.mqttSources.length > 128 || new Set(options.mqttSources.map(item => item.config.logicalSourceId)).size !== options.mqttSources.length) {
      throw new Error('捕获来源、持久授权或在线时钟配置无效。');
    }
    const gate = new HistoryCaptureGate({ archive: options.archive, sourceContractId: options.sourceContractId });
    const collectors: MqttHistoryCollector[] = [];
    try {
      for (const source of options.mqttSources) {
        if (!source.sourceRevision) throw new Error('MQTT 来源缺少冻结修订。');
        collectors.push(await MqttHistoryCollector.open({ source: source.config, sourceContractId: options.sourceContractId,
          protocolVersion: source.protocolVersion, sessionExpirySeconds: source.sessionExpirySeconds,
          allowedTargets: source.allowedTargets, stateRootDirectory: options.mqttStateRootDirectory,
          archive: options.archive, projector: gate, fencing: options.fencing,
          reclaimAbandonedWriter: options.reclaimAbandonedWriter, durability: options.durability,
          getCredential: source.getCredential, onIntegrityEvent: event => gate.recordMqttGap(event), onStatus: options.onCollectorStatus }));
      }
      return new HistoryCaptureRuntime(options, gate, collectors);
    } catch (error) {
      for (const collector of collectors.reverse()) { try { await collector.stop(); } catch { /* 不掩盖启动失败；外层仍应保持缺口。 */ } }
      await gate.close(); throw error;
    }
  }
  get gate(): HistoryCaptureGate { return this.#gate; }
  get collectors(): readonly MqttCollectorStatus[] { return this.#collectors.map(collector => collector.status); }

  /** 用户显式激活后的调用；连接成功不等于完整基线或历史查询已经可用。 */
  async start(): Promise<void> {
    if (this.#started || this.#stopping) throw new Error('捕获协调器不能重复启动。');
    this.#started = true;
    try {
      for (const collector of this.#collectors) await collector.start();
      this.#schedule();
    } catch (error) { await this.stop(); throw error; }
  }
  #schedule(): void {
    if (this.#stopping || this.#timer || this.#clockOperation) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const clock = this.#advance(); this.#clockOperation = clock;
      void clock.catch(() => {
        try { this.#options.onFailure?.('ADVANCE_NOT_DURABLE'); } catch { /* 观察者不能改变失败事实。 */ }
        // 不能继续接收并对外声称完整：停止本协调器的来源，由外层恢复和对账。
        void this.stop().catch(() => { try { this.#options.onFailure?.('STOP_FAILED'); } catch { /* 保留原失败状态。 */ } });
      }).finally(() => { this.#clockOperation = null; if (!this.#stopping) this.#schedule(); });
    }, this.#interval);
  }
  async #advance(): Promise<void> {
    const at = Date.now();
    await this.#gate.capture(createHistoryControlArrival({ sourceId: 'history-clock', sourceContractId: this.#options.sourceContractId, at, kind: 'advance' }));
  }

  /**
   * 输入基线必须已含真实全态、来源边界、在途任务、时钟及一致性证明；此处不补空记录。
   * commit 是可信中台的绑定事务：未知结果会冻结捕获，必须由外层先对账。
   */
  async installBaseline(candidate: HistoryBaselineCandidate, commit: (proof: DurableCommitProof) => Promise<HistoryBindingDecision>): Promise<HistoryProjector> {
    if (this.#stopping) throw new Error('捕获协调器正在停止。');
    const { baseline, dependencies } = candidate;
    const versions = baseline.state.versions as DeepReadonly<VersionManifest>;
    if (versions.sourceContractId !== this.#options.sourceContractId || versions.projectId !== this.#options.archive.scope.projectId) {
      throw new Error('完整基线与当前项目或冻结来源合同不匹配。');
    }
    const kernel = TwinStateKernel.fromBaseline(baseline, this.#options.registry, { mode: 'projector', expectedVersions: versions });
    const proof = await this.#options.archive.prepareProjection(kernel.checkpoint(), dependencies);
    let durable: DurableCommitProof | null = null;
    try {
      return await this.#gate.cutover(async () => {
        durable = await this.#options.archive.activateProjection(proof);
        return HistoryProjector.recover({ archive: this.#options.archive, projectionId: proof.projectionId, versions,
          registry: this.#options.registry,
          normalizer: new HistoryInputNormalizer(this.#options.mqttSources.map(source => ({ sourceId: source.config.logicalSourceId,
            sourceRevision: source.sourceRevision, config: source.config }))), onStatus: this.#options.onProjectorStatus });
      }, async () => {
        if (!durable) return 'unknown';
        return commit(durable);
      });
    } catch (error) {
      // 只有明确被拒绝的候选可关闭；结果不确定时须保留证据供中台按操作身份对账。
      if (error && typeof error === 'object' && 'code' in error && error.code === 'BINDING_REJECTED') {
        await this.#options.archive.closeProjection(proof.projectionId);
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#stopPromise = (async () => {
      if (this.#clockOperation) await this.#clockOperation.catch(() => undefined);
      let failure: unknown = null;
      for (const collector of this.#collectors) { try { await collector.stop(); } catch (error) { failure ??= error; } }
      await this.#gate.close();
      if (failure) throw failure;
    })();
    return this.#stopPromise;
  }
}
