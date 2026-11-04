import type { DeepReadonly, DeviceIdentity, InputCursor, StateCursor, StateTransactionPort } from './types';
import { compareDecimal, nextDecimal, requireState, stableKey } from './safeJson';

/** 身份字段使用长度无歧义的元组，不以名称拼接或 taskId 充当实体身份。 */
export function deviceIdentityKey(identity: DeepReadonly<DeviceIdentity>): string {
  return stableKey('device', identity.projectId, identity.sourceId, identity.deviceType, identity.assetCode);
}
export function dynamicDeviceId(identity: DeepReadonly<DeviceIdentity>, generatorId: string, generation: string): string {
  assertDecimal(generation);
  return stableKey('dynamic-device', deviceIdentityKey(identity), generatorId, generation);
}
export function fetchRowId(sourceId: string, row: string): string { return stableKey('fetch-row', sourceId, row); }
export function assertDecimal(value: string): void {
  requireState(typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && value.length <= 256,
    'CURSOR', '游标和生成计数须为有界无符号十进制字符串。');
}
export function compareInputCursor(a: DeepReadonly<InputCursor>, b: DeepReadonly<InputCursor>): number {
  requireState(a.captureDomainId === b.captureDomainId && a.captureEpoch === b.captureEpoch,
    'CAPTURE_RESET_REQUIRED', '不能比较不同采集关联域或采集代次的游标；须重新加载基线。');
  assertDecimal(a.offset); assertDecimal(b.offset);
  return compareDecimal(a.offset, b.offset);
}
export function compareStateCursor(a: DeepReadonly<StateCursor>, b: DeepReadonly<StateCursor>): number {
  requireState(a.projectionId === b.projectionId, 'STATE_RESET_REQUIRED', '投影代次不同，须重新加载全态。');
  assertDecimal(a.stateRevision); assertDecimal(b.stateRevision);
  return compareDecimal(a.stateRevision, b.stateRevision);
}
/** 计数由同一事务持久化，失败不会消耗编号；命名空间不接受运行时随机种子。 */
export function nextGeneration(transaction: StateTransactionPort, namespace: string): string {
  requireState(typeof namespace === 'string' && namespace.length > 0 && namespace.length <= 512,
    'IDENTITY', '生成计数命名空间必须是有界非空字符串。');
  const id = stableKey('counter', namespace);
  const value = nextDecimal(transaction.get('counters', id)?.value ?? '0');
  transaction.put('counters', { id, value });
  return value;
}
/** 动态实例的生成代次与 generator 绑定，恢复时必须保留此计数器。 */
export function nextGeneratorGeneration(transaction: StateTransactionPort, generatorId: string): string {
  requireState(transaction.logic.generators.some(generator => generator.id === generatorId), 'IDENTITY', '生成器未在逻辑清单中声明。');
  return nextGeneration(transaction, stableKey('generator', generatorId));
}
export function allocateCargoId(transaction: StateTransactionPort, sourceId: string): string {
  requireState(transaction.logic.sources.some(source => source.id === sourceId), 'SOURCE', '货物来源未在逻辑清单中声明。');
  return transaction.allocateId(stableKey('cargo', sourceId));
}
