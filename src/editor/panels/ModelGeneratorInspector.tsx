import { useState, type DragEvent, type ReactElement } from 'react';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import type {
  ModelGeneratorComponent,
  ModelGeneratorFetchBinding,
  ModelGeneratorRule,
  ModelGeneratorTarget,
} from '../model/components';
import {
  MODEL_GENERATOR_MAX_BINDINGS,
  MODEL_GENERATOR_MAX_RULES,
  MODEL_GENERATOR_TTL_MAX_SECONDS,
  MODEL_GENERATOR_TTL_MIN_SECONDS,
  createMeshModelGeneratorTarget,
  createModelGeneratorTargetFromAsset,
  sanitizeModelGeneratorMetadataTtlSeconds,
} from '../model/modelGenerator';
import { useEditorStore } from '../store/editorStore';
import { createId } from '../../shared/ids';

type ModelGeneratorInspectorProps = {
  component: ModelGeneratorComponent;
  disabled?: boolean;
};

type ModelGeneratorRulePatch = Partial<Omit<ModelGeneratorRule, 'id'>>;
type ModelGeneratorFetchBindingPatch = Partial<Omit<ModelGeneratorFetchBinding, 'id'>>;

const BUILT_IN_MODEL_NAMES = {
  cube: '立方体',
  sphere: '球体',
  plane: '地面',
} as const;

/** 判断拖拽事件是否包含模型库可用于生成槽位的载荷。 */
function hasModelGeneratorTargetPayload(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE)
    || event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE);
}

/** 从模型库拖拽数据读取合法目标，只接受普通模型和内置基础网格。 */
function readModelGeneratorTargetFromDrop(event: DragEvent<HTMLElement>): ModelGeneratorTarget | null {
  const modelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
  const modelAsset = modelPayload ? decodeModelAssetDragPayload(modelPayload) : null;
  if (modelAsset?.libraryKind === 'model') {
    return createModelGeneratorTargetFromAsset(modelAsset);
  }

  const builtInPayload = event.dataTransfer.getData(BUILT_IN_ASSET_DRAG_MIME_TYPE);
  const builtInAsset = builtInPayload ? decodeBuiltInAssetDragPayload(builtInPayload) : null;
  if (builtInAsset?.kind !== 'mesh') return null;

  return createMeshModelGeneratorTarget(
    builtInAsset.meshKind,
    BUILT_IN_MODEL_NAMES[builtInAsset.meshKind],
  );
}

/** 渲染并编辑模型生成器的共享模板、条件规则与元数据 TTL；设备侧绑定在遥测绑定面板配置。 */
export function ModelGeneratorInspector({ component, disabled = false }: ModelGeneratorInspectorProps) {
  const updateSelectedModelGenerator = useEditorStore((state) => state.updateSelectedModelGenerator);
  const [activeDropZone, setActiveDropZone] = useState<string | null>(null);

  /** 提交完整不可变组件，由 Store 统一校验并写入撤销历史。 */
  function commitComponent(nextComponent: ModelGeneratorComponent, label: string): void {
    if (disabled) return;
    updateSelectedModelGenerator(nextComponent, label);
  }

  /** 更新指定规则，不改变列表顺序和稳定 ID。 */
  function updateRule(index: number, patch: ModelGeneratorRulePatch, label: string): void {
    const rules = component.rules.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    ));
    commitComponent({ ...component, rules }, label);
  }

  /** 更新指定 fetch 定位线框绑定。 */
  function updateFetchBinding(index: number, patch: ModelGeneratorFetchBindingPatch): void {
    const fetchBindings = component.fetchBindings.map((b, i) => (
      i === index ? { ...b, ...patch } : b
    ));
    commitComponent({ ...component, fetchBindings }, '更新定位线框绑定');
  }

  /** 新增一条空生成规则，目标由后续模型库拖放补齐。 */
  function addRule(): void {
    if (component.rules.length >= MODEL_GENERATOR_MAX_RULES) return;
    const rule: ModelGeneratorRule = {
      id: createId('model_generator_rule'),
      attributeName: '',
      attributeValue: '',
      target: null,
    };
    commitComponent({ ...component, rules: [...component.rules, rule] }, '添加生成规则');
  }

  /** 删除指定生成规则。 */
  function removeRule(index: number): void {
    commitComponent(
      { ...component, rules: component.rules.filter((_, ruleIndex) => ruleIndex !== index) },
      '删除生成规则',
    );
  }

  /** 调整规则优先级，运行时始终按当前列表顺序取首条命中。 */
  function moveRule(index: number, offset: -1 | 1): void {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= component.rules.length) return;
    const rules = [...component.rules];
    [rules[index], rules[targetIndex]] = [rules[targetIndex], rules[index]];
    commitComponent({ ...component, rules }, '调整生成规则顺序');
  }

  /** 新增一条 fetch 定位线框绑定。 */
  function addFetchBinding(): void {
    if (component.fetchBindings.length >= MODEL_GENERATOR_MAX_BINDINGS) return;
    const binding: ModelGeneratorFetchBinding = {
      id: createId('model_generator_binding'),
      assetCode: '',
    };
    commitComponent({ ...component, fetchBindings: [...component.fetchBindings, binding] }, '添加定位线框绑定');
  }

  /** 删除指定 fetch 定位线框绑定。 */
  function removeFetchBinding(index: number): void {
    commitComponent(
      { ...component, fetchBindings: component.fetchBindings.filter((_, i) => i !== index) },
      '删除定位线框绑定',
    );
  }

  /** 接收模型库拖放并更新对应默认槽位或规则槽位。 */
  function handleTargetDrop(
    event: DragEvent<HTMLDivElement>,
    dropZoneId: string,
    onTargetChange: (target: ModelGeneratorTarget | null) => void,
  ): void {
    if (disabled || !hasModelGeneratorTargetPayload(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveDropZone(null);

    const target = readModelGeneratorTargetFromDrop(event);
    if (target) onTargetChange(target);
  }

  /** 拖拽离开槽位整体时移除高亮，子节点之间移动不会误清理。 */
  function handleTargetDragLeave(event: DragEvent<HTMLDivElement>, dropZoneId: string): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    if (activeDropZone === dropZoneId) setActiveDropZone(null);
  }

  /** 渲染可接收模型库卡片的模型目标槽位。 */
  function renderTargetSlot(
    dropZoneId: string,
    label: string,
    target: ModelGeneratorTarget | null,
    onTargetChange: (target: ModelGeneratorTarget | null) => void,
  ): ReactElement {
    const className = activeDropZone === dropZoneId
      ? 'model-generator-target-slot model-generator-target-slot-active'
      : 'model-generator-target-slot';
    const title = target?.kind === 'model' ? target.modelAsset.sourcePath : target?.displayName;

    return (
      <div className="model-generator-target-row">
        <span className="model-generator-target-label">{label}</span>
        <div
          className={className}
          onDragEnter={(event) => {
            if (disabled || !hasModelGeneratorTargetPayload(event)) return;
            event.preventDefault();
            setActiveDropZone(dropZoneId);
          }}
          onDragLeave={(event) => handleTargetDragLeave(event, dropZoneId)}
          onDragOver={(event) => {
            if (disabled || !hasModelGeneratorTargetPayload(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setActiveDropZone(dropZoneId);
          }}
          onDrop={(event) => handleTargetDrop(event, dropZoneId, onTargetChange)}
          title={title || '从模型库拖入普通模型或内置基础网格'}
        >
          {target ? (
            <>
              <span className="model-generator-target-preview" aria-hidden="true">
                {target.kind === 'model' && target.thumbnailUrl ? (
                  <img alt="" src={target.thumbnailUrl} />
                ) : (
                  <span>{target.kind === 'mesh' ? 'Mesh' : 'Model'}</span>
                )}
              </span>
              <span className="model-generator-target-text">
                <strong>{target.displayName}</strong>
                <small>{target.kind === 'mesh' ? '内置基础网格' : '项目模型'}</small>
              </span>
              <button
                aria-label={'清空' + label}
                className="model-generator-clear-button"
                disabled={disabled}
                onClick={() => onTargetChange(null)}
                type="button"
              >
                ×
              </button>
            </>
          ) : (
            <span className="model-generator-target-empty">从模型库拖入模型</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <fieldset className="transform-fieldset model-generator-fieldset">
      <legend>模型生成器</legend>

      <label className="inspector-row">
        <span>数据源</span>
        <select
          disabled={disabled}
          value={component.dataSource}
          onChange={(event) => {
            const dataSource = event.target.value === 'fetch' ? 'fetch' : 'mqtt';
            commitComponent({ ...component, dataSource }, '切换数据源');
          }}
        >
          <option value="mqtt">MQTT</option>
          <option value="fetch">Fetch</option>
        </select>
      </label>
      {component.dataSource === 'fetch' ? (
        <p className="muted">fetch 模式下由外部事件驱动，绑定的资产编号用于匹配虚拟定位线框。基础 URL 和 API Key 在工具栏中配置。</p>
      ) : (
        <p className="muted">MQTT 模式下本生成器仅作为货箱模板库；在设备的遥测绑定面板中选择本生成器作为货箱来源。</p>
      )}

      {renderTargetSlot(
        'default-target',
        '共享生成模板',
        component.defaultTarget,
        (target) => commitComponent({ ...component, defaultTarget: target }, '更新共享生成模板'),
      )}
      <p className="muted model-generator-unit-hint">模板仅保存配置，编辑态不会显示；未命中规则时运行态使用共享模板。</p>

      <div className="model-generator-section-header">
        <span>生成规则</span>
        <button
          disabled={disabled || component.rules.length >= MODEL_GENERATOR_MAX_RULES}
          onClick={addRule}
          title="添加生成规则"
          type="button"
        >
          +
        </button>
      </div>

      {component.rules.length === 0 ? (
        <p className="muted model-generator-empty-hint">
          暂无生成规则；设备有货时直接使用共享模板，模板为空时回退默认 Box。
        </p>
      ) : null}

      {component.rules.map((rule, index) => (
        <div className="model-generator-rule-card" key={rule.id}>
          <div className="model-generator-card-header">
            <span>规则 {index + 1}</span>
            <span className="model-generator-inline-actions">
              <button disabled={disabled || index === 0} onClick={() => moveRule(index, -1)} title="上移规则" type="button">↑</button>
              <button disabled={disabled || index === component.rules.length - 1} onClick={() => moveRule(index, 1)} title="下移规则" type="button">↓</button>
              <button disabled={disabled} onClick={() => removeRule(index)} title="删除规则" type="button">−</button>
            </span>
          </div>
          <label className="inspector-row">
            <span>类型属性名</span>
            <input
              disabled={disabled}
              maxLength={256}
              type="text"
              value={rule.attributeName}
              onChange={(event) => updateRule(index, { attributeName: event.target.value }, '更新规则属性名')}
            />
          </label>
          <label className="inspector-row">
            <span>类型属性值</span>
            <input
              disabled={disabled}
              maxLength={256}
              type="text"
              value={rule.attributeValue}
              onChange={(event) => updateRule(index, { attributeValue: event.target.value }, '更新规则属性值')}
            />
          </label>
          {renderTargetSlot(
            'rule-target-' + rule.id,
            '规则覆盖模型（可选）',
            rule.target,
            (target) => updateRule(index, { target }, '更新规则覆盖模型'),
          )}
        </div>
      ))}

      {component.dataSource !== 'fetch' && (
      <label className="number-row model-generator-ttl-row">
        <span>元数据销毁时长</span>
        <input
          disabled={disabled}
          min={MODEL_GENERATOR_TTL_MIN_SECONDS}
          max={MODEL_GENERATOR_TTL_MAX_SECONDS}
          step="1"
          type="number"
          value={component.metadataTtlSeconds}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            commitComponent(
              { ...component, metadataTtlSeconds: sanitizeModelGeneratorMetadataTtlSeconds(value) },
              '更新元数据销毁时长',
            );
          }}
        />
      </label>
      )}
      {component.dataSource !== 'fetch' && (
        <p className="muted model-generator-unit-hint">单位：秒；遥测元数据超过该时长未刷新时销毁对应货箱。</p>
      )}

      {component.dataSource === 'fetch' && (
        <>
          <div className="model-generator-section-header">
            <span>定位线框绑定</span>
            <button
              disabled={disabled || component.fetchBindings.length >= MODEL_GENERATOR_MAX_BINDINGS}
              onClick={addFetchBinding}
              title="添加定位线框绑定"
              type="button"
            >
              +
            </button>
          </div>
          {component.fetchBindings.length === 0 ? (
            <p className="muted model-generator-empty-hint">暂无定位线框绑定；资产编号用于匹配虚拟定位线框的 assetId。</p>
          ) : null}
          {component.fetchBindings.map((binding, index) => (
            <div className="model-generator-binding-card" key={binding.id}>
              <div className="model-generator-card-header">
                <span>绑定 {index + 1}</span>
                <button disabled={disabled} onClick={() => removeFetchBinding(index)} title="删除绑定" type="button">−</button>
              </div>
              <label className="inspector-row">
                <span>定位线框编号</span>
                <input
                  disabled={disabled}
                  maxLength={128}
                  type="text"
                  value={binding.assetCode}
                  onChange={(event) => updateFetchBinding(index, { assetCode: event.target.value })}
                />
              </label>
            </div>
          ))}
        </>
      )}
    </fieldset>
  );
}
