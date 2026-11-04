import type { CapturedArrival, RawHistoryArrival } from '../storage/index.ts';
import type { StateReadView } from '../../../runtime/history/state/types.ts';
import type { HistoryNormalizedInput, HistoryNormalizer } from './HistoryProjector.ts';
import { MqttHistoryNormalizer, type HistoryMqttNormalizerSource } from './MqttHistoryNormalizer.ts';

/** 实时推进和缺口也先进入同一个持久顺序器；恢复时只使用记录的时间和原因。 */
export function createHistoryControlArrival(options: {
  sourceContractId: string; sourceId: string; at: number; kind: 'advance' | 'gap'; reason?: string;
}): RawHistoryArrival {
  if (!Number.isSafeInteger(options.at) || options.at < 0 || options.at > 8_640_000_000_000_000
    || !options.sourceId || !options.sourceContractId
    || options.kind === 'gap' && (!options.reason || options.reason.length > 512 || /[\u0000-\u001f\u007f]/u.test(options.reason))) {
    throw new Error('历史控制观测的时间、身份或缺口原因无效。');
  }
  return { sourceId: options.sourceId, sourceContractId: options.sourceContractId, receivedAt: options.at,
    transport: { kind: 'control', controlKind: options.kind },
    rawPayload: new TextEncoder().encode(JSON.stringify({ version: 1, reason: options.kind === 'gap' ? options.reason : null })) };
}

export class HistoryInputNormalizer implements HistoryNormalizer {
  readonly #mqtt: MqttHistoryNormalizer;
  constructor(mqttSources: readonly HistoryMqttNormalizerSource[]) { this.#mqtt = new MqttHistoryNormalizer(mqttSources); }
  normalize(arrival: Readonly<CapturedArrival>, state: StateReadView): HistoryNormalizedInput {
    if (arrival.transport.kind === 'mqtt') return this.#mqtt.normalize(arrival, state);
    if (arrival.transport.kind !== 'control') throw new Error('HTTP 到达尚未绑定其有序业务输入合同。');
    if (!['advance', 'gap'].includes(arrival.transport.controlKind) || arrival.rawPayload.byteLength > 2048) {
      throw new Error('控制输入类型不属于当前投影合同。');
    }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(arrival.rawPayload));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'version' && key !== 'reason')) {
      throw new Error('控制输入结构不合法。');
    }
    const record = input as Record<string, unknown>;
    if (record.version !== 1) throw new Error('控制输入版本不兼容。');
    const logicalTime = Math.max(state.metadata.logicalTime, arrival.receivedAt);
    if (arrival.transport.controlKind === 'advance') {
      if (record.reason !== null) throw new Error('时间推进不能携带缺口原因。');
      return { kind: 'advance', logicalTime };
    }
    if (typeof record.reason !== 'string' || !record.reason || record.reason.length > 512 || /[\u0000-\u001f\u007f]/u.test(record.reason)) {
      throw new Error('缺口原因不合法。');
    }
    return { kind: 'gap', logicalTime, reason: record.reason };
  }
}
