import { useState, type DragEvent, type ReactElement } from 'react';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import type {
  ModelGeneratorBinding,
  ModelGeneratorComponent,
  ModelGeneratorRule,
  ModelGeneratorTarget,
  ModelGeneratorWarehouseFlow,
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
type ModelGeneratorBindingPatch = Partial<Omit<ModelGeneratorBinding, 'id'>>;

const EMPTY_WAREHOUSE_FLOW: ModelGeneratorWarehouseFlow = {
  enabled: true,
  inboundBindingId: '',
  stackerBindingId: '',
  outboundBindingId: '',
};

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

/** 渲染并编辑全局模型生成器的共享模板、条件规则、仓储 TTL 和设备绑定。 */
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

  /** 更新指定仓储设备 MQTT 绑定，不改变其他绑定。 */
  function updateBinding(index: number, patch: ModelGeneratorBindingPatch): void {
    const bindings = component.bindings.map((binding, bindingIndex) => (
      bindingIndex === index ? { ...binding, ...patch } : binding
    ));
    commitComponent({ ...component, bindings }, '更新仓储设备绑定');
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

  /** 新增一条仓储设备精确绑定，sourceId 默认使用现有遥测默认源。 */
  function addBinding(): void {
    if (component.bindings.length >= MODEL_GENERATOR_MAX_BINDINGS) return;
    const binding: ModelGeneratorBinding = {
      id: createId('model_generator_binding'),
      sourceId: 'default',
      deviceType: '',
      assetCode: '',
    };
    commitComponent({ ...component, bindings: [...component.bindings, binding] }, '添加仓储设备绑定');
  }

  /** 删除指定仓储设备绑定，并清空仓储流中对该稳定 ID 的引用。 */
  function removeBinding(index: number): void {
    const removedBindingId = component.bindings[index]?.id ?? '';
    const warehouseFlow = component.warehouseFlow;
    const nextWarehouseFlow = warehouseFlow
      ? {
          ...warehouseFlow,
          inboundBindingId: warehouseFlow.inboundBindingId === removedBindingId ? '' : warehouseFlow.inboundBindingId,
          stackerBindingId: warehouseFlow.stackerBindingId === removedBindingId ? '' : warehouseFlow.stackerBindingId,
          outboundBindingId: warehouseFlow.outboundBindingId === removedBindingId ? '' : warehouseFlow.outboundBindingId,
        }
      : undefined;
    commitComponent(
      {
        ...component,
        bindings: component.bindings.filter((_, bindingIndex) => bindingIndex !== index),
        ...(nextWarehouseFlow ? { warehouseFlow: nextWarehouseFlow } : {}),
      },
      '删除仓储设备绑定',
    );
  }

  /** 更新仓储流声明式配置，不在 Inspector 中重复保存设备资产编号。 */
  function updateWarehouseFlow(patch: Partial<ModelGeneratorWarehouseFlow>): void {
    const current = component.warehouseFlow ?? EMPTY_WAREHOUSE_FLOW;
    commitComponent({ ...component, warehouseFlow: { ...current, ...patch } }, '更新仓储流配置');
  }

  /** 渲染仓储流使用的绑定选择器，缺失引用保持为空并提示用户修复。 */
  function renderWarehouseBindingSelect(
    label: string,
    value: string,
    expectedDeviceType: 'conveyor' | 'stacker',
    onChange: (bindingId: string) => void,
  ): ReactElement {
    const options = component.bindings.filter((binding) => {
      const deviceType = binding.deviceType.trim().toLowerCase();
      return !deviceType || deviceType === expectedDeviceType;
    });
    const selectedExists = component.bindings.some((binding) => binding.id === value);

    return (
      <label className="inspector-row">
        <span>{label}</span>
        <select disabled={disabled} value={selectedExists ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">未配置</option>
          {options.map((binding) => (
            <option key={binding.id} value={binding.id}>
              {(binding.deviceType || expectedDeviceType) + ' / ' + (binding.assetCode || '未填资产编号')}
            </option>
          ))}
        </select>
      </label>
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
      {component.dataSource === 'fetch' && (
        <p className="muted">fetch 模式下由外部事件驱动，绑定的资产编号用于匹配虚拟定位线框。基础 URL 和 API Key 在工具栏中配置。</p>
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
          {component.warehouseFlow?.enabled
            ? '暂无生成规则；仓储流在入库输送机前端有货时直接使用共享模板。'
            : '暂无生成规则；普通设备有货时直接使用共享模板，模板为空时回退默认 Box。'}
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
        <p className="muted model-generator-unit-hint">单位：秒；用于 warehouseFlow 三条严格绑定快照的有效期判断。</p>
      )}

      <div className="model-generator-section-header">
        <span>仓储设备绑定</span>
        <button
          disabled={disabled || component.bindings.length >= MODEL_GENERATOR_MAX_BINDINGS}
          onClick={addBinding}
          title={component.dataSource === 'fetch' ? '添加定位线框绑定' : '添加 MQTT 绑定'}
          type="button"
        >
          +
        </button>
      </div>

      {component.bindings.length === 0 ? (
        <p className="muted model-generator-empty-hint">
          {component.dataSource === 'fetch'
            ? '暂无定位线框绑定；资产编号用于匹配虚拟定位线框的 assetId。'
            : '暂无仓储设备绑定；普通设备模板规则仍按各自遥测快照工作。'}
        </p>
      ) : null}

      {component.bindings.map((binding, index) => (
        <div className="model-generator-binding-card" key={binding.id}>
          <div className="model-generator-card-header">
            <span>绑定 {index + 1}</span>
            <button disabled={disabled} onClick={() => removeBinding(index)} title="删除绑定" type="button">−</button>
          </div>
          {component.dataSource !== 'fetch' ? (
            <>
          <label className="inspector-row">
            <span>sourceId</span>
            <input
              disabled={disabled}
              maxLength={256}
              type="text"
              value={binding.sourceId}
              onChange={(event) => updateBinding(index, { sourceId: event.target.value })}
            />
          </label>
          <label className="inspector-row">
            <span>deviceType</span>
            <input
              disabled={disabled}
              maxLength={256}
              type="text"
              value={binding.deviceType}
              onChange={(event) => updateBinding(index, { deviceType: event.target.value })}
            />
          </label>
            </>
          ) : null}
          <label className="inspector-row">
            <span>{component.dataSource === 'fetch' ? '定位线框编号' : 'assetCode'}</span>
            <input
              disabled={disabled}
              maxLength={128}
              type="text"
              value={binding.assetCode}
              onChange={(event) => updateBinding(index, { assetCode: event.target.value })}
            />
          </label>
        </div>
      ))}

      {component.dataSource !== 'fetch' && (
        <>
      <div className="model-generator-section-header">
        <span>仓储入库/出库流转</span>
      </div>
      <label className="toggle-row">
        <input
          checked={component.warehouseFlow?.enabled === true}
          disabled={disabled}
          type="checkbox"
          onChange={(event) => {
            if (event.target.checked) {
              updateWarehouseFlow({ enabled: true });
              return;
            }
            const { warehouseFlow: _warehouseFlow, ...componentWithoutWarehouseFlow } = component;
            commitComponent(componentWithoutWarehouseFlow, '关闭仓储流配置');
          }}
        />
        <span>启用同一货物跨设备接力</span>
      </label>
      {component.warehouseFlow?.enabled ? (
        <>
          {renderWarehouseBindingSelect(
            '入库输送机',
            component.warehouseFlow.inboundBindingId,
            'conveyor',
            (bindingId) => updateWarehouseFlow({ inboundBindingId: bindingId }),
          )}
          {renderWarehouseBindingSelect(
            '堆垛机',
            component.warehouseFlow.stackerBindingId,
            'stacker',
            (bindingId) => updateWarehouseFlow({ stackerBindingId: bindingId }),
          )}
          {renderWarehouseBindingSelect(
            '出库输送机',
            component.warehouseFlow.outboundBindingId,
            'conveyor',
            (bindingId) => updateWarehouseFlow({ outboundBindingId: bindingId }),
          )}
          <p className="muted model-generator-unit-hint">
            入库前端有货时生成模板；完成入库后实例保留在库位，出库时复用同一实例。
          </p>
        </>
      ) : null}
        </>
      )}
    </fieldset>
  );
}
