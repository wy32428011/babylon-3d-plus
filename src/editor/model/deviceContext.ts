import { modelDeviceTypeField, normalizeModelDeviceType } from '../../../electron/shared/modelDeviceType.ts';
import type { DigitalTwinDeviceContext } from '../../player/digitalTwinInteractionProtocol';
import type { ModelAssetComponent } from './components';
import type { ModelParameterValues } from './modelParameters';
import type { SceneDocument } from './SceneDocument';

/** 构造器仅输出验证过的模型参数类型，比传输层的 unknown 入站类型更窄。 */
export type ModelDeviceContext = Omit<DigitalTwinDeviceContext, 'parameterValues'> & {
  parameterValues?: ModelParameterValues;
};

/** 给事件信封及 unit/host 留出预算；参数不完整时整份省略，不丢弃设备点击。 */
function cloneParameterValues(value: unknown): Pick<ModelDeviceContext, 'parameterValues' | 'parametersUnavailable'> {
  if (value === undefined) return {};
  let nodes = 384;
  let characters = 32_768;
  const plain = (entry: unknown): entry is Record<string, unknown> => entry !== null
    && typeof entry === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(entry));
  try {
    if (!plain(value)) return { parametersUnavailable: true };
    const keys = Object.keys(value);
    if (keys.length > 256) return { parametersUnavailable: true };
    const parameterValues: ModelParameterValues = {};
    for (const key of keys) {
      if (!key || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        return { parametersUnavailable: true };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return { parametersUnavailable: true };
      const entry: unknown = descriptor.value;
      characters -= key.length;
      nodes -= 1;
      if (typeof entry === 'string') {
        if (entry.length > 16_384) return { parametersUnavailable: true };
        characters -= entry.length;
        parameterValues[key] = entry;
      } else if (typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) {
        parameterValues[key] = entry;
      } else if (plain(entry) && Object.keys(entry).length === 3) {
        const vector = { x: 0, y: 0, z: 0 };
        for (const axis of ['x', 'y', 'z'] as const) {
          const coordinate = Object.getOwnPropertyDescriptor(entry, axis);
          if (!coordinate || !('value' in coordinate) || typeof coordinate.value !== 'number'
            || !Number.isFinite(coordinate.value)) return { parametersUnavailable: true };
          vector[axis] = coordinate.value;
        }
        nodes -= 3;
        characters -= 3;
        parameterValues[key] = vector;
      } else {
        return { parametersUnavailable: true };
      }
      if (nodes < 0 || characters < 0) return { parametersUnavailable: true };
    }
    return { parameterValues };
  } catch {
    return { parametersUnavailable: true };
  }
}

function identityText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const hasControl = Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  return text && text.length <= maxLength && !hasControl ? text : undefined;
}

/** 只读取实际实例的旧身份映射；模型类型不从 inspection 或遥测枚举回填。 */
function instanceIdentity(model: ModelAssetComponent | undefined, assetCode: string) {
  if (!model || model.assetCode?.trim() !== assetCode) return {};
  const device = model?.inspection?.device;
  // 中台类型已更新时，旧高模绑定的另一设备类型不能提供这次选择的实例身份。
  const deviceType = normalizeModelDeviceType(model.deviceType);
  if (deviceType && device?.deviceType !== deviceType) return {};
  const namespace = identityText(device?.namespace, 256);
  const deviceNo = identityText(device?.deviceNo, 256);
  return { ...(namespace ? { namespace } : {}), ...(deviceNo ? { deviceNo } : {}) };
}

/** 运行产物由拾取层提供自身/承运设备身份，绝不借用生成器模板的实例绑定。 */
export type DeviceContextGeneratedHit = {
  unitKind: 'cargo' | 'spawned-device';
  assetCode: string;
  highlightEntityId: string;
  hostEntityId?: string;
};

export function buildDeviceContext(
  scene: SceneDocument,
  entityId: string | null,
  generated?: DeviceContextGeneratedHit | null,
): ModelDeviceContext | null {
  const contextEntityId = generated
    ? generated.unitKind === 'cargo' ? generated.hostEntityId : generated.highlightEntityId
    : entityId;
  const safeEntityId = identityText(contextEntityId, 256);
  if (!safeEntityId) return null;
  const model = scene.entities[safeEntityId]?.components.modelAsset;
  const assetCode = identityText(generated ? generated.assetCode : model?.assetCode, 128);
  if (!assetCode) return null;
  return {
    assetCode,
    entityId: safeEntityId,
    ...modelDeviceTypeField(model?.deviceType),
    ...instanceIdentity(model, assetCode),
    ...cloneParameterValues(model?.parameterValues),
  };
}
