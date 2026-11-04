import type { HistoryMqttSourceConfig, HistorySourceCredential } from '../../../../electron/shared/historySourceConfig.ts';
import { StateAdapterRegistry, TwinStateKernel, type DeepReadonly, type TwinBaseline, type VersionManifest } from '../../../runtime/history/state/index.ts';
import { canonicalStringify } from '../../../runtime/history/state/safeJson.ts';
import { MqttHistoryCollector, type MqttAllowedTarget, type MqttCollectorStatus } from '../mqtt/index.ts';
import { DurableHistoryArchive, type ArchiveScope, type DurableCommitProof, type HistoryDurability, type HistoryWriter, type ProjectionDependencies } from '../storage/index.ts';
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
  /** 限制连续投影距最近完整检查点的时间和修订数；不代替容量预检。 */
  checkpointIntervalMs?: number;
  checkpointMaxRevisions?: number;
  onCollectorStatus?: (status: Readonly<MqttCollectorStatus>) => void;
  onProjectorStatus?: (status: Readonly<ProjectorStatus>) => void;
  onFailure?: (code: string) => void;
};
export type HistoryBaselineCandidate = {
  baseline: DeepReadonly<TwinBaseline>;
  dependencies: ProjectionDependencies;
};
export type HistoryRestoreBinding = { projectionId: string; versions: DeepReadonly<VersionManifest> };
export type HistoryRestoreEvidence = {
  archiveId: string; scope: Readonly<ArchiveScope>; writer: Readonly<HistoryWriter>;
  projectionId: string; versions: DeepReadonly<VersionManifest>;
};
export interface HistoryRestoreBindingGuard {
  /** 整个回调期间保持当前绑定、授权策略和代次屏障；不得重跑回调或与归档 fencing 共用非重入锁。 */
  withCurrentBinding<T>(evidence: Readonly<HistoryRestoreEvidence>, operation: () => Promise<T>): Promise<T>;
}

/** 与编辑器进程无关的捕获协调器；完整性和历史可读状态只能由真实基线、持久回执及绑定事务证明。 */
export class HistoryCaptureRuntime {
  readonly #options: HistoryCaptureRuntimeOptions;
  readonly #gate: HistoryCaptureGate;
  readonly #collectors: MqttHistoryCollector[];
  readonly #interval: number;
  readonly #checkpointInterval: number;
  readonly #checkpointMaxRevisions: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  #clockOperation: Promise<void> | null = null;
  #checkpointOperation: Promise<void> | null = null;
  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  private constructor(options: HistoryCaptureRuntimeOptions, gate: HistoryCaptureGate, collectors: MqttHistoryCollector[]) {
    this.#options = options; this.#gate = gate; this.#collectors = collectors;
    this.#interval = options.advanceIntervalMs ?? 250;
    this.#checkpointInterval = options.checkpointIntervalMs ?? 60_000;
    this.#checkpointMaxRevisions = options.checkpointMaxRevisions ?? 20_000;
  }
  /** 只建立私有本地状态；调用 start 前不连接 broker。 */
  static async open(options: HistoryCaptureRuntimeOptions): Promise<HistoryCaptureRuntime> {
    if (!Array.isArray(options.mqttSources) || options.mqttSources.length > 128) throw new Error('捕获来源超过预算。');
    options = { ...options, registry: options.registry.snapshot(), mqttSources: options.mqttSources.map(source => ({ ...source,
      config: structuredClone(source.config), allowedTargets: structuredClone(source.allowedTargets) })) };
    const interval = options.advanceIntervalMs ?? 250;
    const checkpointInterval = options.checkpointIntervalMs ?? 60_000, checkpointRevisions = options.checkpointMaxRevisions ?? 20_000;
    if (!options.sourceContractId || !options.archive.usesFencing(options.fencing)
      || !Number.isSafeInteger(interval) || interval < 50 || interval > 60_000
      || !Number.isSafeInteger(checkpointInterval) || checkpointInterval < 1000 || checkpointInterval > 86_400_000
      || !Number.isSafeInteger(checkpointRevisions) || checkpointRevisions < 1 || checkpointRevisions > 1_000_000
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
      this.#schedule(); this.#scheduleCheckpoint();
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
  #scheduleCheckpoint(): void {
    if (this.#stopping || this.#checkpointTimer || this.#checkpointOperation) return;
    this.#checkpointTimer = setTimeout(() => {
      this.#checkpointTimer = null;
      const operation = this.#maintainCheckpoint(); this.#checkpointOperation = operation;
      void operation.catch(() => {
        try { this.#options.onFailure?.('CHECKPOINT_FAILED'); } catch { /* 观察者不能改变失败事实。 */ }
        void this.stop().catch(() => { try { this.#options.onFailure?.('STOP_FAILED'); } catch { /* 保留原失败状态。 */ } });
      }).finally(() => { this.#checkpointOperation = null; if (!this.#stopping) this.#scheduleCheckpoint(); });
    }, Math.min(1000, this.#checkpointInterval));
  }
  async #maintainCheckpoint(): Promise<void> {
    const projector = this.#gate.phase === 'active' ? this.#gate.projector : null;
    if (!projector || projector.status.phase !== 'running') return;
    const mark = this.#options.archive.getWatermarks().projections.find(item => item.projectionId === projector.status.projectionId);
    if (!mark || mark.closed) throw new Error('活动投影不存在或已经关闭。');
    const difference = BigInt(mark.committedStateCursor.stateRevision) - BigInt(mark.checkpointCursor.stateRevision);
    if (difference < 0n) throw new Error('检查点水位领先已提交投影。');
    if (difference > 0n && (difference >= BigInt(this.#checkpointMaxRevisions)
      || mark.committedThroughTime - mark.checkpointTime >= this.#checkpointInterval)) await projector.checkpoint();
  }

  #normalizer(): HistoryInputNormalizer {
    return new HistoryInputNormalizer(this.#options.mqttSources.map(source => ({ sourceId: source.config.logicalSourceId,
      sourceRevision: source.sourceRevision, config: source.config })));
  }

  /** 已提交绑定恢复必须在可信控制面的当前绑定屏障内完成，不重新创建基线。 */
  async restoreCommittedProjection(binding: HistoryRestoreBinding, guard: HistoryRestoreBindingGuard): Promise<HistoryProjector> {
    if (this.#stopping || this.#gate.phase !== 'recording' || !guard || typeof guard.withCurrentBinding !== 'function') {
      throw new Error('捕获协调器不可恢复或缺少当前绑定屏障。');
    }
    const expected = structuredClone(binding);
    if (!expected.projectionId || expected.versions.sourceContractId !== this.#options.sourceContractId
      || expected.versions.projectId !== this.#options.archive.scope.projectId) {
      throw new Error('恢复绑定与当前项目或冻结来源合同不匹配。');
    }
    Object.freeze(expected.versions);
    const evidence: Readonly<HistoryRestoreEvidence> = Object.freeze({ archiveId: this.#options.archive.archiveId,
      scope: Object.freeze({ ...this.#options.archive.scope }), writer: Object.freeze({ ...this.#options.archive.writer }),
      projectionId: expected.projectionId, versions: expected.versions });
    let calls = 0, guardOpen = true, installed: HistoryProjector | null = null;
    try {
      const result = await guard.withCurrentBinding(evidence, async () => {
        calls += 1;
        if (!guardOpen || calls !== 1) throw new Error('当前绑定屏障不能延迟或重跑恢复操作。');
        const mark = this.#options.archive.getWatermarks().projections.find(item => item.projectionId === expected.projectionId);
        if (!mark || mark.closed || mark.continuity.status !== 'complete'
          || canonicalStringify(mark.versions) !== canonicalStringify(expected.versions)) {
          throw new Error('已提交投影不存在、不连续或版本与当前绑定不一致。');
        }
        installed = await this.#gate.cutover(() => HistoryProjector.recover({ archive: this.#options.archive,
          projectionId: expected.projectionId, versions: expected.versions, registry: this.#options.registry,
          normalizer: this.#normalizer(), onStatus: this.#options.onProjectorStatus }), async () => 'committed');
        return installed;
      });
      guardOpen = false;
      if (calls !== 1 || !installed || result !== installed) throw new Error('当前绑定屏障未完整执行恢复操作。');
      return result;
    } catch (error) {
      guardOpen = false;
      const closingGate = this.#gate.close().catch(() => undefined);
      try { await this.stop(); } catch { /* 保留原错误，外层须对账并重新恢复。 */ }
      await closingGate;
      throw error;
    }
  }

  /**
   * 输入基线必须已含真实全态、来源边界、在途任务、时钟及一致性证明；此处不补空记录。
   * commit 是可信中台的绑定事务：未知结果会冻结捕获，必须由外层先对账。
   */
  async installBaseline(candidate: HistoryBaselineCandidate, commit: (proof: DurableCommitProof) => Promise<HistoryBindingDecision>): Promise<HistoryProjector> {
    if (this.#stopping) throw new Error('捕获协调器正在停止。');
    const { baseline } = candidate, dependencies = structuredClone(candidate.dependencies);
    const kernel = TwinStateKernel.fromBaseline(baseline, this.#options.registry, { mode: 'projector' });
    const versions = kernel.view.logic.versions;
    if (versions.sourceContractId !== this.#options.sourceContractId || versions.projectId !== this.#options.archive.scope.projectId) {
      throw new Error('完整基线与当前项目或冻结来源合同不匹配。');
    }
    const proof = await this.#options.archive.prepareProjection(kernel.checkpoint(), dependencies);
    let durable: DurableCommitProof | null = null;
    try {
      return await this.#gate.cutover(async () => {
        durable = await this.#options.archive.activateProjection(proof);
        return HistoryProjector.recover({ archive: this.#options.archive, projectionId: proof.projectionId, versions,
          registry: this.#options.registry, normalizer: this.#normalizer(), onStatus: this.#options.onProjectorStatus });
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
    if (this.#checkpointTimer) { clearTimeout(this.#checkpointTimer); this.#checkpointTimer = null; }
    this.#stopPromise = (async () => {
      if (this.#clockOperation) await this.#clockOperation.catch(() => undefined);
      if (this.#checkpointOperation) await this.#checkpointOperation.catch(() => undefined);
      let failure: unknown = null;
      for (const collector of this.#collectors) { try { await collector.stop(); } catch (error) { failure ??= error; } }
      await this.#gate.close();
      if (failure) throw failure;
    })();
    return this.#stopPromise;
  }
}
