import type {
  AdapterInput, DeepReadonly, JsonObject, LogicManifest, StateReadView,
  StateTransactionPort, TimerState, VersionedAdapterState,
} from './types';
import { copySafeJson, DEFAULT_STATE_BUDGETS, freezeData, requireState, resolveStateBudgets } from './safeJson';
import type { StateBudgets } from './safeJson';
import { assertSupportedSchema, validateJsonSchema } from './schema';
import type { JsonSchema } from './schema';

/** 只有显式注册的受控同步模块可运行；不从 manifest、脚本 URL 或 checkpoint 加载代码。 */
export type StateAdapter = {
  adapterId: string; version: string; stateSchemaVersion: string;
  capability: 'codec-only' | 'reducer';
  /** 显式注册的真实遥测主体类型；与六类物流算法 kind 解耦，不存在任意类型兜底。 */
  deviceTypes: readonly string[];
  supportedScripts: readonly { id: string; digest: string }[];
  stateSchema: JsonSchema;
  eventSchemas: Readonly<Record<string, JsonSchema>>;
  timerSchemas: Readonly<Record<string, JsonSchema>>;
  /** 附加语义校验只读；可检查 state.value 内部的稳定货物/设备引用。 */
  validateState?: (value: DeepReadonly<JsonObject>, view: StateReadView) => void;
  /** 即使状态表为空也执行全域校验，不依赖某一条设备记录触发。 */
  validateView?: (view: StateReadView) => void;
  validateLogic?: (logic: DeepReadonly<LogicManifest>) => void;
  /** 输入回调负责规范化与调度；设备阶段和帧尾拉货通过带 phase 的定时任务进入统一截止队列。 */
  reduce?: (input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort) => void;
  /** 去重只跳过业务 reducer；逐消息生命周期观察须显式注册独立同步回调。 */
  onRepeatedInput?: (input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort) => void;
  onTimer?: (timer: DeepReadonly<TimerState>, transaction: StateTransactionPort) => void;
};
function assertSynchronousResult(result: unknown): void {
  requireState(result === undefined, 'ASYNC_ADAPTER', '适配器必须同步完成且不返回 Promise；不得在事务后继续写入。');
}
function safeSchema(schema: JsonSchema, budgets: Readonly<StateBudgets>): JsonSchema {
  const copied = copySafeJson(schema, budgets, true) as JsonSchema;
  assertSupportedSchema(copied);
  return freezeData(copied);
}

export class StateAdapterRegistry {
  readonly #adapters = new Map<string, Readonly<StateAdapter>>();
  readonly budgets: Readonly<StateBudgets>;
  constructor(budgets: Readonly<StateBudgets> = DEFAULT_STATE_BUDGETS) { this.budgets = resolveStateBudgets(budgets); }

  register(adapter: StateAdapter): this {
    for (const value of [adapter.adapterId, adapter.version, adapter.stateSchemaVersion]) {
      requireState(typeof value === 'string' && value.length > 0 && value.length <= 2048, 'ADAPTER', '适配器必须声明有界身份和版本。');
    }
    requireState(!this.#adapters.has(adapter.adapterId), 'ADAPTER_DUPLICATE', '同一注册表不得覆盖已有适配器；新版本建立新投影。');
    requireState(adapter.capability === 'codec-only' || adapter.capability === 'reducer', 'ADAPTER', '适配器能力未知。');
    requireState(new Set(adapter.deviceTypes).size === adapter.deviceTypes.length
      && adapter.deviceTypes.every(type => typeof type === 'string' && type.length > 0 && type.length <= 2048 && type === type.trim()),
    'ADAPTER', '适配器须显式声明有界、非空、不重复的实际设备类型，不能依赖未知类型兜底。');
    const events: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>;
    const timers: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>;
    for (const [key, schema] of Object.entries(adapter.eventSchemas)) events[key] = safeSchema(schema, this.budgets);
    for (const [key, schema] of Object.entries(adapter.timerSchemas)) timers[key] = safeSchema(schema, this.budgets);
    requireState(adapter.capability !== 'codec-only' || (!adapter.reduce && !adapter.onRepeatedInput && !adapter.onTimer), 'ADAPTER', 'codec-only 不能声明业务 reducer。');
    requireState(adapter.capability !== 'reducer' || ((Object.keys(events).length === 0 || typeof adapter.reduce === 'function')
      && (Object.keys(timers).length === 0 || typeof adapter.onTimer === 'function')), 'ADAPTER', '已声明输入缺少实际处理器。');
    const scripts = copySafeJson(adapter.supportedScripts, this.budgets, true) as { id: string; digest: string }[];
    requireState(scripts.every(item => typeof item.id === 'string' && item.id.length > 0
      && typeof item.digest === 'string' && item.digest.length > 0), 'ADAPTER', '脚本白名单须精确标识和摘要。');
    this.#adapters.set(adapter.adapterId, Object.freeze({
      adapterId: adapter.adapterId, version: adapter.version, stateSchemaVersion: adapter.stateSchemaVersion,
      capability: adapter.capability, deviceTypes: Object.freeze([...adapter.deviceTypes]), supportedScripts: freezeData(scripts),
      stateSchema: safeSchema(adapter.stateSchema, this.budgets), eventSchemas: Object.freeze(events), timerSchemas: Object.freeze(timers),
      validateState: adapter.validateState, validateView: adapter.validateView, validateLogic: adapter.validateLogic, reduce: adapter.reduce,
      onRepeatedInput: adapter.onRepeatedInput, onTimer: adapter.onTimer,
    }));
    return this;
  }

  /** 内核保存独立注册快照；后来 register 不会给已启动投影静默换算法。 */
  snapshot(): StateAdapterRegistry {
    const registry = new StateAdapterRegistry(this.budgets);
    for (const [id, adapter] of this.#adapters) registry.#adapters.set(id, adapter);
    return registry;
  }

  get(adapterId: string, version?: string): Readonly<StateAdapter> {
    const adapter = this.#adapters.get(adapterId);
    requireState(adapter && (version === undefined || adapter.version === version), 'UNSUPPORTED_ADAPTER', `未实现或版本不匹配的适配器 ${adapterId}。`);
    return adapter;
  }

  validateManifest(logic: DeepReadonly<LogicManifest>): void {
    const ids = new Set<string>();
    for (const required of logic.requiredAdapters) {
      requireState(!ids.has(required.adapterId), 'ADAPTER_DUPLICATE', '逻辑清单包含重复的适配器身份。'); ids.add(required.adapterId);
      const adapter = this.get(required.adapterId, required.version);
      requireState(new Set(required.deviceTypes).size === required.deviceTypes.length
        && adapter.stateSchemaVersion === required.stateSchemaVersion
        && required.deviceTypes.every(type => adapter.deviceTypes.includes(type)), 'ADAPTER_SCHEMA', '适配器状态 schema 或显式主体类型范围不匹配。');
      if (adapter.validateLogic) assertSynchronousResult(adapter.validateLogic(logic));
    }
    for (const script of logic.businessScripts) {
      requireState(ids.has(script.adapterId), 'UNSUPPORTED_SCRIPT', '业务脚本未映射到清单内的受控适配器。');
      const adapter = this.get(script.adapterId);
      requireState(adapter.supportedScripts.some(candidate => candidate.id === script.id && candidate.digest === script.digest),
        'UNSUPPORTED_SCRIPT', `业务脚本 ${script.id} 的当前摘要尚未迁移；不能形成完整 ready。`);
    }
  }

  assertReducerManifest(logic: DeepReadonly<LogicManifest>): void {
    for (const required of logic.requiredAdapters) {
      requireState(this.get(required.adapterId, required.version).capability === 'reducer', 'UNIMPLEMENTED_REDUCER',
        `适配器 ${required.adapterId} 仅能解码；不能宣称原始遥测业务算法已实现。`);
    }
  }

  validateAdapterState(state: DeepReadonly<VersionedAdapterState>, view: StateReadView, deviceType?: string): void {
    const required = view.logic.requiredAdapters.find(item => item.adapterId === state.adapterId);
    requireState(required && required.version === state.version && required.stateSchemaVersion === state.stateSchemaVersion,
      'VERSION_MISMATCH', '状态引用了清单之外的适配器或 schema 版本。');
    const adapter = this.get(state.adapterId, state.version);
    requireState(adapter.stateSchemaVersion === state.stateSchemaVersion
      && (deviceType === undefined || (required.deviceTypes.includes(deviceType) && adapter.deviceTypes.includes(deviceType))),
      'ADAPTER_SCHEMA', 'driverState 不匹配设备类型或状态 schema。');
    validateJsonSchema(state.value, adapter.stateSchema, this.budgets, `adapter:${state.adapterId}`);
    if (adapter.validateState) assertSynchronousResult(adapter.validateState(state.value, view));
  }

  validateView(view: StateReadView): void {
    for (const required of view.logic.requiredAdapters) {
      const adapter = this.get(required.adapterId, required.version);
      if (adapter.validateView) assertSynchronousResult(adapter.validateView(view));
    }
  }

  validateTimer(timer: DeepReadonly<TimerState>, logic: DeepReadonly<LogicManifest>): Readonly<StateAdapter> {
    requireState(logic.requiredAdapters.some(item => item.adapterId === timer.adapterId && item.version === timer.adapterVersion),
      'VERSION_MISMATCH', '定时任务不属于此逻辑清单。');
    const adapter = this.get(timer.adapterId, timer.adapterVersion), schema = adapter.timerSchemas[timer.timerType];
    requireState(schema, 'UNKNOWN_TIMER', `不支持的定时任务 ${timer.timerType}。`);
    validateJsonSchema(timer.payload, schema, this.budgets, `timer:${timer.timerType}`);
    return adapter;
  }

  validateInput(input: DeepReadonly<AdapterInput>, logic: DeepReadonly<LogicManifest>): Readonly<StateAdapter> {
    requireState(logic.requiredAdapters.some(item => item.adapterId === input.adapterId && item.version === input.adapterVersion),
      'VERSION_MISMATCH', '输入的适配器不属于此投影。');
    const adapter = this.get(input.adapterId, input.adapterVersion), schema = adapter.eventSchemas[input.eventType];
    requireState(schema, 'UNKNOWN_EVENT', `不支持的业务事件 ${input.eventType}。`);
    requireState(adapter.capability === 'reducer' && adapter.reduce, 'UNIMPLEMENTED_REDUCER', '业务算法尚未迁移。');
    validateJsonSchema(input.payload, schema, this.budgets, `event:${input.eventType}`);
    return adapter;
  }

  apply(input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort): void {
    const adapter = this.validateInput(input, transaction.logic);
    assertSynchronousResult(adapter.reduce!(input, transaction));
  }

  observeRepeated(input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort): void {
    const adapter = this.validateInput(input, transaction.logic);
    if (adapter.onRepeatedInput) assertSynchronousResult(adapter.onRepeatedInput(input, transaction));
  }

  fire(timer: DeepReadonly<TimerState>, transaction: StateTransactionPort): void {
    const adapter = this.validateTimer(timer, transaction.logic);
    requireState(adapter.capability === 'reducer' && adapter.onTimer, 'UNIMPLEMENTED_REDUCER', '定时算法尚未迁移。');
    assertSynchronousResult(adapter.onTimer(timer, transaction));
  }

  /** Java 只验证/存储这些合同；真正的设备规则仍由同版本 Node/Viewer 内核共用。 */
  exportSchemas(): readonly object[] {
    return [...this.#adapters.values()].sort((a, b) => a.adapterId < b.adapterId ? -1 : a.adapterId > b.adapterId ? 1 : 0)
      .map(({ adapterId, version, stateSchemaVersion, capability, deviceTypes, stateSchema, eventSchemas, timerSchemas }) =>
        Object.freeze({ adapterId, version, stateSchemaVersion, capability, deviceTypes, stateSchema, eventSchemas, timerSchemas }));
  }
}
