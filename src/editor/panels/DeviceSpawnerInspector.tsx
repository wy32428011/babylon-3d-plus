import { useEditorStore } from '../store/editorStore';
import type { DeviceSpawnerComponent, DeviceSpawnerTemplateRule } from '../model/components';
import {
  DEVICE_SPAWNER_MAX_TEMPLATE_RULES,
  DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS,
  DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS,
  isAgvSpawnerTemplateEntity,
} from '../model/deviceSpawner';
import { SearchableSelect } from '../ui/SearchableSelect';
import { createId } from '../../shared/ids';

type DeviceSpawnerInspectorProps = {
  component: DeviceSpawnerComponent;
  disabled?: boolean;
  agvOnly?: boolean;
};

type TemplateProblem = 'missing' | 'invalid-type' | null;

/** 渲染并编辑设备产生器配置：产生器 id、模板实体与离线超时。 */
export function DeviceSpawnerInspector({ component, disabled = false, agvOnly = false }: DeviceSpawnerInspectorProps) {
  const updateSelectedDeviceSpawner = useEditorStore((state) => state.updateSelectedDeviceSpawner);
  const scene = useEditorStore((state) => state.scene);
  const templateRules = component.templateRules ?? [];

  const templateOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelAsset && (!agvOnly || isAgvSpawnerTemplateEntity(entity)))
    .map((entity) => ({ value: entity!.id, label: entity!.name }));

  function getTemplateProblem(templateEntityId: string | null): TemplateProblem {
    if (!templateEntityId) return null;
    const entity = scene.entities[templateEntityId];
    if (!entity?.components.modelAsset) return 'missing';
    return agvOnly && !isAgvSpawnerTemplateEntity(entity) ? 'invalid-type' : null;
  }

  function templateMissingLabel(value: string): string {
    const entity = scene.entities[value];
    if (entity?.components.modelAsset && getTemplateProblem(value) === 'invalid-type') {
      return `${entity.name}（非 AGV 模板）`;
    }
    return `已删除实体（${value}）`;
  }

  /** 提交完整不可变组件，由 Store 统一校验并写入撤销历史。 */
  function commitComponent(patch: Partial<DeviceSpawnerComponent>, label: string): void {
    if (disabled) return;
    updateSelectedDeviceSpawner({ ...component, ...patch }, label);
  }

  function updateRule(index: number, patch: Partial<Omit<DeviceSpawnerTemplateRule, 'id'>>, label: string): void {
    commitComponent({
      templateRules: templateRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule),
    }, label);
  }

  function addRule(): void {
    if (templateRules.length >= DEVICE_SPAWNER_MAX_TEMPLATE_RULES) return;
    commitComponent({
      templateRules: [...templateRules, {
        id: createId('agv_template_rule'),
        attributeName: '',
        attributeValue: '',
        templateEntityId: null,
      }],
    }, '添加AGV条件模板规则');
  }

  function removeRule(index: number): void {
    commitComponent({
      templateRules: templateRules.filter((_, ruleIndex) => ruleIndex !== index),
    }, '删除AGV条件模板规则');
  }

  function moveRule(index: number, offset: -1 | 1): void {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= templateRules.length) return;
    const nextRules = [...templateRules];
    [nextRules[index], nextRules[targetIndex]] = [nextRules[targetIndex], nextRules[index]];
    commitComponent({ templateRules: nextRules }, '调整AGV条件模板规则顺序');
  }

  function renderTemplateProblem(templateEntityId: string | null) {
    const problem = getTemplateProblem(templateEntityId);
    if (problem === 'missing') {
      return <p className="telemetry-runtime-error">绑定的模板实体已被删除，运行时该模板不可用。</p>;
    }
    if (problem === 'invalid-type') {
      return <p className="telemetry-runtime-error">模板实例的设备类型必须是 agv 或以 agv 开头。</p>;
    }
    return null;
  }

  return (
    <fieldset className="transform-fieldset">
      <legend>{agvOnly ? 'AGV产生器' : '设备产生器'}</legend>
      <label className="inspector-row">
        <span>产生器ID</span>
        <input
          type="text"
          disabled={disabled}
          value={component.spawnerCode}
          onChange={(event) => commitComponent({ spawnerCode: event.target.value }, '更新设备产生器')}
        />
      </label>
      <label className="inspector-row">
        <span>{agvOnly ? '默认模板实体' : '模板实体'}</span>
        <SearchableSelect
          disabled={disabled}
          missingLabel={templateMissingLabel}
          options={[{ value: '__none__', label: '未绑定' }, ...templateOptions]}
          value={component.templateEntityId || '__none__'}
          onChange={(value) => commitComponent({ templateEntityId: value !== '__none__' ? value : null }, '更新设备产生器模板')}
        />
      </label>
      {renderTemplateProblem(component.templateEntityId)}
      <label className="number-row">
        <span>离线超时(秒)</span>
        <input
          type="number"
          disabled={disabled}
          min={DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS}
          max={DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS}
          step="1"
          value={component.timeoutSeconds}
          onChange={(event) => commitComponent({ timeoutSeconds: Number(event.target.value) }, '更新设备产生器超时')}
        />
      </label>

      {agvOnly ? (
        <>
          <div className="model-generator-section-header">
            <span>条件模板规则</span>
            <button
              disabled={disabled || templateRules.length >= DEVICE_SPAWNER_MAX_TEMPLATE_RULES}
              onClick={addRule}
              title="添加条件模板规则"
              type="button"
            >
              +
            </button>
          </div>
          {templateRules.length === 0 ? <p className="muted">暂无规则，全部消息使用默认模板实体。</p> : null}
          {templateRules.map((rule, index) => (
            <div className="model-generator-rule-card" key={rule.id}>
              <div className="model-generator-card-header">
                <span>规则 {index + 1}</span>
                <span className="model-generator-inline-actions">
                  <button disabled={disabled || index === 0} onClick={() => moveRule(index, -1)} title="上移规则" type="button">↑</button>
                  <button disabled={disabled || index === templateRules.length - 1} onClick={() => moveRule(index, 1)} title="下移规则" type="button">↓</button>
                  <button disabled={disabled} onClick={() => removeRule(index)} title="删除规则" type="button">−</button>
                </span>
              </div>
              <label className="inspector-row">
                <span>属性名</span>
                <input
                  disabled={disabled}
                  maxLength={256}
                  type="text"
                  value={rule.attributeName}
                  onChange={(event) => updateRule(index, { attributeName: event.target.value }, '更新AGV规则属性名')}
                />
              </label>
              <label className="inspector-row">
                <span>属性值</span>
                <input
                  disabled={disabled}
                  maxLength={256}
                  type="text"
                  value={rule.attributeValue}
                  onChange={(event) => updateRule(index, { attributeValue: event.target.value }, '更新AGV规则属性值')}
                />
              </label>
              <label className="inspector-row">
                <span>规则模板实体</span>
                <SearchableSelect
                  disabled={disabled}
                  missingLabel={templateMissingLabel}
                  options={[{ value: '__none__', label: '使用默认模板' }, ...templateOptions]}
                  value={rule.templateEntityId || '__none__'}
                  onChange={(value) => updateRule(
                    index,
                    { templateEntityId: value !== '__none__' ? value : null },
                    '更新AGV规则模板实体',
                  )}
                />
              </label>
              {renderTemplateProblem(rule.templateEntityId)}
            </div>
          ))}
          <p className="muted">
            按规则顺序取第一条命中；属性名读取消息字段，也支持 sourceId、deviceType、assetCode。
            属性值按字符串精确比较；规则模板留空或未命中任何规则时使用默认模板。
          </p>
        </>
      ) : null}

      <p className="muted">
        运行预览时收到常规遥测消息（topic 与设备一致）、点位 s 字段命中产生器ID且编号未被占用时，克隆模板生成设备实例（assetCode 取 topic 段）；
        超过离线时间无消息或收到 p=status、v=offline 消息时销毁实例；重新上线的首条消息必须携带 s 才会再次生成。
      </p>
    </fieldset>
  );
}
