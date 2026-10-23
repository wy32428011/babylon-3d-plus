import { Constants } from '@babylonjs/core/Engines/constants.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { LocatorComponent, LocatorStorageDepth } from '../../../editor/model/components';
import { deriveColumnSplitFromBinding } from '../../../editor/model/builtInSlotBinding';
import { type SceneDocument } from '../../../editor/model/SceneDocument';
import { LocatorFetchRuntime } from '../LocatorFetchRuntime';
import { resolveLocatorBoxIndex, resolveLocatorCellLocalBounds, resolveLocatorCellLocalIndex, resolveLocatorCellSupportWorldPosition } from '../telemetry/stackerStorageLocation';
import { isPlainRecord } from '../runtimeValueUtils';
import { getNodeWorldRotation } from '../runtimeNodeGeometry';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import type { SceneLocatorFetchController } from './SceneLocatorFetchController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import { SELECTED_MATERIAL_COLOR, LOCATOR_EDGE_COLOR, LOCATOR_SURFACE_ALPHA, SELECTED_LOCATOR_SURFACE_ALPHA, LOCATOR_CONTIGUOUS_EPSILON, LOCATOR_COLUMN_LABEL_TEXTURE_SIZE, LOCATOR_COLUMN_LABEL_MIN_SIZE, LOCATOR_COLUMN_LABEL_MAX_SIZE, SLOT_HIGHLIGHT_SIZE_SCALE, SLOT_HIGHLIGHT_SURFACE_ALPHA, SLOT_HIGHLIGHT_EDGE_THICKNESS, EDITOR_ENTITY_ID_METADATA_KEY, type ModelRuntimeEntry, type ModelGeneratorRuntimeEntry, type LocatorColumnLabel, type LocatorRuntimeEntry, type LocatorSlotHighlightOverlay, type LocatorBindingSteps, type BuiltInSlotRowLayoutInfo, type BuiltInSlotLayoutInfo, type LayerChangePlatformLayoutInfo } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly outputs: Pick<GeneratedModelOutputController, 'reportedCargoIssues' | 'modelGenerators' | 'defaultCargoGeneratorId'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes' | 'applyTransform' | 'applyMeshInteractivity'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities' | 'modelArrayTelemetryProxies' | 'createModelArrayRenderSignature'>;
  readonly document: Pick<SceneDocumentController, 'syncedEntities' | 'entityStates' | 'isEntityVisible'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariantByEntityId'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'selectedEntityIds' | 'localSlotHighlight' | 'externalSlotHighlight' | 'localSlotHighlightOverlay' | 'externalSlotHighlightOverlay' | 'isEntityHighlighted' | 'externalHighlightedEntityIds'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'resolveModelArrayRenderModel'>;
  readonly fetch: Pick<SceneLocatorFetchController, 'locatorFetchRuntimes' | 'disposeLocatorFetchRuntime'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'invalidateModelStatistics'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'clearEntityArrayPreviewIfSource'>;
  readonly telemetry: Pick<SceneTelemetryController, 'specializedTelemetryRuntime' | 'telemetryPreviewActive'>;
};


/** SceneLocatorController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneLocatorController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly locators = new Map<string, LocatorRuntimeEntry>();
  public readonly locatorTargets = new Map<string, LocatorRuntimeEntry>();
  public readonly locatorDeviceIndex = new Map<string, Map<number, LocatorRuntimeEntry[]>>();
  /** 巷道索引：aisleCode → 排号 → 条目列表，与设备索引同循环构建；多穿小车 front_/to_ 定位的唯一数据源。 */
  public readonly locatorAisleIndex = new Map<string, Map<number, LocatorRuntimeEntry[]>>();
  public readonly reportedDuplicateLocatorTargets = new Set<string>();
  public readonly reportedOverlappingLocatorRanges = new Set<string>();

  /** 货箱运行问题按稳定 key 只写一次 Console。 */
  public reportCargoIssue(key: string, message: string): void {
    if (this.dependencies.outputs.reportedCargoIssues.has(key)) return;
    this.dependencies.outputs.reportedCargoIssues.add(key);
    Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]);
  }

  /** 读取设备绑定的模型生成器运行时条目；未绑定或绑定失效时回退场景默认，最终回退内置几何体。 */
  public resolveCargoGeneratorForModel(model: ModelRuntimeEntry): ModelGeneratorRuntimeEntry | null {
    const boundId = model.telemetryBinding?.cargoGeneratorId?.trim();
    if (boundId) {
      const bound = this.dependencies.outputs.modelGenerators.get(boundId) ?? null;
      if (bound) return bound;
      this.reportCargoIssue(
        `cargo-generator-missing:${model.assetCode}:${boundId}`,
        `设备 ${model.assetCode} 绑定的模型生成器已被删除，货箱回退场景默认或内置几何体。`,
      );
    }

    const defaultId = this.dependencies.outputs.defaultCargoGeneratorId;
    if (!defaultId) return null;
    const fallback = this.dependencies.outputs.modelGenerators.get(defaultId) ?? null;
    if (!fallback) {
      this.reportCargoIssue(
        `cargo-generator-default-missing:${defaultId}`,
        `场景默认模型生成器已被删除，货箱回退内置几何体。`,
      );
    }
    return fallback;
  }

  /** 按实体 ID 解析 RGV 列接驳位实体的世界位姿：依次查模型、定位线框、基础网格和合批阵列实例。 */
  public resolveColumnTargetPose(entityId: string): { position: Vector3; rotation: Quaternion } | null {
    const model = this.dependencies.assets.models.get(entityId);
    if (model) {
      return { position: model.root.getAbsolutePosition(), rotation: getNodeWorldRotation(model.root) };
    }
    const locator = this.locators.get(entityId);
    if (locator) {
      return { position: locator.root.getAbsolutePosition(), rotation: getNodeWorldRotation(locator.root) };
    }
    const mesh = this.dependencies.presentation.meshes.get(entityId);
    if (mesh) {
      return { position: mesh.getAbsolutePosition(), rotation: getNodeWorldRotation(mesh) };
    }
    // 合批阵列实例没有独立运行时节点；其实体 Transform 就是批次实例的世界矩阵，直接等价于 root 位姿。
    const arrayInstance = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    if (arrayInstance) {
      const transform = arrayInstance.components.transform;
      return {
        position: new Vector3(transform.position.x, transform.position.y, transform.position.z),
        rotation: Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
      };
    }
    return null;
  }

  /** 重建虚拟定位线框资产编号索引与设备绑定索引，供 to_x/to_y/to_z 快速查找目标位。 */
  public rebuildLocatorTargetIndex(document: SceneDocument): void {
    this.locatorTargets.clear();
    this.locatorDeviceIndex.clear();
    this.locatorAisleIndex.clear();
    const duplicateAssetIds = new Set<string>();

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      const locatorComponent = entity?.components.locator;
      const assetId = locatorComponent?.assetId.trim();
      const locator = this.locators.get(entityId);
      if (!assetId || !locator || duplicateAssetIds.has(assetId)) continue;

      locator.assetId = assetId;
      const isBuiltInSlot = Boolean(locatorComponent?.builtInBinding);
      const assetIdTaken = this.locatorTargets.has(assetId);
      // 换层站台不进入通用目标索引：站台起始列可被编辑为 0，与同排输送线接驳货格逻辑坐标重叠，
      // 参与唯一匹配会互相抢占；站台由 findLayerChangePlatformLocator 单独解析。
      const isLayerChangePlatform = locator.kind === 'layerChangePlatform';

      // 构建设备绑定索引：内置货格各排共用宿主资产编号，必须逐排登记，否则堆垛机 to_x/to_y/to_z 只能命中首排。
      const deviceCode = locatorComponent?.deviceAssetCode?.trim();
      if (deviceCode && !isLayerChangePlatform && (isBuiltInSlot || !assetIdTaken)) {
        const rowNumber = locatorComponent?.rowNumber ?? 1;
        let rowMap = this.locatorDeviceIndex.get(deviceCode);
        if (!rowMap) {
          rowMap = new Map();
          this.locatorDeviceIndex.set(deviceCode, rowMap);
        }
        const list = rowMap.get(rowNumber) ?? [];
        list.push(locator);
        rowMap.set(rowNumber, list);
      }

      // 构建巷道索引：多穿小车按巷道编号+排+列层定位，与设备索引同规则逐排登记。
      const aisleCode = locatorComponent?.aisleCode?.trim();
      if (aisleCode && !isLayerChangePlatform && (isBuiltInSlot || !assetIdTaken)) {
        const rowNumber = locatorComponent?.rowNumber ?? 1;
        let rowMap = this.locatorAisleIndex.get(aisleCode);
        if (!rowMap) {
          rowMap = new Map();
          this.locatorAisleIndex.set(aisleCode, rowMap);
        }
        const list = rowMap.get(rowNumber) ?? [];
        list.push(locator);
        rowMap.set(rowNumber, list);
      }

      if (assetIdTaken) {
        // 同一宿主的多排内置货格共用资产编号是声明内的布局，不按编号冲突处理。
        if (isBuiltInSlot) continue;
        this.locatorTargets.delete(assetId);
        duplicateAssetIds.add(assetId);
        continue;
      }
      this.locatorTargets.set(assetId, locator);
    }

    for (const assetId of duplicateAssetIds) {
      if (this.reportedDuplicateLocatorTargets.has(assetId)) continue;
      this.reportedDuplicateLocatorTargets.add(assetId);
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`库位资产编号冲突，已停止目标绑定：${assetId}`]);
    }
    for (const assetId of [...this.reportedDuplicateLocatorTargets]) {
      if (!duplicateAssetIds.has(assetId)) this.reportedDuplicateLocatorTargets.delete(assetId);
    }

    // 同设备/同巷道同排的列/层范围重叠检测：front_ 定位要求唯一命中，重叠时在编辑期即告警，运行时拒绝定位
    const overlappingPairs = new Set<string>();
    const collectOverlap = (
      index: Map<string, Map<number, LocatorRuntimeEntry[]>>,
      describeScope: (code: string) => string,
    ) => {
      for (const [code, rowMap] of index) {
        for (const [rowNumber, list] of rowMap) {
          for (let i = 0; i < list.length; i += 1) {
            for (let j = i + 1; j < list.length; j += 1) {
              const a = list[i];
              const b = list[j];
              const columnOverlap = a.startColumn < b.startColumn + b.columns && b.startColumn < a.startColumn + a.columns;
              const layerOverlap = a.startLayer < b.startLayer + b.layers && b.startLayer < a.startLayer + a.layers;
              if (!columnOverlap || !layerOverlap) continue;
              const pairKey = `${describeScope(code)}:${rowNumber}:${[a.assetId, b.assetId].sort().join('|')}`;
              overlappingPairs.add(pairKey);
              if (this.reportedOverlappingLocatorRanges.has(pairKey)) continue;
              this.reportedOverlappingLocatorRanges.add(pairKey);
              Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`错误：定位线框「${a.assetId}」（列${a.startColumn}-${a.startColumn + a.columns - 1} 层${a.startLayer}-${a.startLayer + a.layers - 1}）与「${b.assetId}」（列${b.startColumn}-${b.startColumn + b.columns - 1} 层${b.startLayer}-${b.startLayer + b.layers - 1}）${describeScope(code)} 排${rowNumber} 且范围重叠，front_ 定位将拒绝命中重叠区域，请调整使范围互不重叠。`]);
            }
          }
        }
      }
    };
    collectOverlap(this.locatorDeviceIndex, (code) => `关联同一设备 ${code}`);
    collectOverlap(this.locatorAisleIndex, (code) => `关联同一巷道 ${code}`);
    for (const key of [...this.reportedOverlappingLocatorRanges]) {
      if (!overlappingPairs.has(key)) this.reportedOverlappingLocatorRanges.delete(key);
    }
  }

  /**
   * 按设备编号 + 排号 + 列/层范围查找目标 Locator：front_ 定位要求 (x, y, z) 唯一命中，零个或多个（同排范围重叠）命中都返回 null。
   * 传 storageDepth 时按排深过滤（同排可同时存在浅/深库位，多穿小车靠排深区分）。
   */
  public findLocatorByDevice(
    deviceAssetCode: string,
    toX: number,
    toY: number,
    toZ: number,
    storageDepth?: LocatorStorageDepth,
  ): LocatorRuntimeEntry | null {
    const rowMap = this.locatorDeviceIndex.get(deviceAssetCode);
    if (!rowMap) return null;
    const list = rowMap.get(toZ);
    if (!list?.length) return null;
    let matched: LocatorRuntimeEntry | null = null;
    for (const locator of list) {
      if (storageDepth && locator.storageDepth !== storageDepth) continue;
      const covered = toX >= locator.startColumn && toX < locator.startColumn + locator.columns
        && toY >= locator.startLayer && toY < locator.startLayer + locator.layers;
      if (!covered) continue;
      if (matched) return null;
      matched = locator;
    }
    return matched;
  }

  /** 返回设备绑定的全部 Locator（所有排），无绑定时返回空数组。 */
  public findLocatorsByDevice(deviceAssetCode: string): LocatorRuntimeEntry[] {
    const rowMap = this.locatorDeviceIndex.get(deviceAssetCode);
    if (!rowMap) return [];
    const result: LocatorRuntimeEntry[] = [];
    for (const list of rowMap.values()) result.push(...list);
    return result;
  }

  /**
   * 按巷道编号 + 排号 + 列/层范围查找目标 Locator：多穿小车 front_ 定位要求 (x, y, z) 唯一命中，零个或多个命中都返回 null。
   * 传 storageDepth 时按排深过滤（同排可同时存在浅/深库位，多穿小车靠排深区分）。
   */
  public findLocatorByAisle(
    aisleCode: string,
    toX: number,
    toY: number,
    toZ: number,
    storageDepth?: LocatorStorageDepth,
  ): LocatorRuntimeEntry | null {
    const rowMap = this.locatorAisleIndex.get(aisleCode);
    if (!rowMap) return null;
    const list = rowMap.get(toZ);
    if (!list?.length) return null;
    let matched: LocatorRuntimeEntry | null = null;
    for (const locator of list) {
      if (storageDepth && locator.storageDepth !== storageDepth) continue;
      const covered = toX >= locator.startColumn && toX < locator.startColumn + locator.columns
        && toY >= locator.startLayer && toY < locator.startLayer + locator.layers;
      if (!covered) continue;
      if (matched) return null;
      matched = locator;
    }
    return matched;
  }

  /** 返回巷道绑定的全部 Locator（所有排），无绑定时返回空数组。 */
  public findLocatorsByAisle(aisleCode: string): LocatorRuntimeEntry[] {
    const rowMap = this.locatorAisleIndex.get(aisleCode);
    if (!rowMap) return [];
    const result: LocatorRuntimeEntry[] = [];
    for (const list of rowMap.values()) result.push(...list);
    return result;
  }

  /** 按设备编号或巷道编号找换层站台 Locator：deviceAssetCode 命中优先，其次 aisleCode 匹配。 */
  findLayerChangePlatformLocator(assetCode: string, aisleCode: string): LocatorRuntimeEntry | null {
    let aisleMatch: LocatorRuntimeEntry | null = null;
    for (const entry of this.locators.values()) {
      if (entry.kind !== 'layerChangePlatform') continue;
      if (assetCode && entry.deviceAssetCode === assetCode) return entry;
      if (!aisleMatch && aisleCode && entry.aisleCode === aisleCode) aisleMatch = entry;
    }
    return aisleMatch;
  }

  /** 按宿主实体 ID 找其内置货格运行时条目（无绑定返回 null）。 */
  public findBuiltInSlotLocatorForHostModel(hostEntityId: string): LocatorRuntimeEntry | null {
    for (const entry of this.locators.values()) {
      const binding = this.dependencies.document.syncedEntities.get(entry.entityId)?.components.locator?.builtInBinding;
      if (binding?.hostEntityId === hostEntityId) return entry;
    }
    return null;
  }

  /** 反查内置货格的宿主模型与其货格条目（非内置货格或宿主非模型时返回 null）。 */
  public resolveBuiltInSlotHost(
    locatorEntityId: string,
  ): { model: ModelRuntimeEntry; locator: LocatorRuntimeEntry } | null {
    const locator = this.locators.get(locatorEntityId);
    if (!locator) return null;
    const hostEntityId = this.dependencies.document.syncedEntities.get(locatorEntityId)?.components.locator?.builtInBinding?.hostEntityId;
    if (!hostEntityId) return null;
    // 宿主可能是常规模型、合批阵列的遥测代理或参数变体代表机：三张注册表都要查，否则阵列输送线站台取/放交接失效
    const model = this.dependencies.assets.models.get(hostEntityId)
      ?? this.dependencies.arrays.modelArrayTelemetryProxies.get(hostEntityId)
      ?? this.resolveModelArrayVariantRepresentativeModel(hostEntityId);
    return model ? { model, locator } : null;
  }

  /** 按代表实例实体 ID 反查参数变体宿主模型（非代表实例或未映射变体返回 null）。 */
  public resolveModelArrayVariantRepresentativeModel(entityId: string): ModelRuntimeEntry | null {
    const variant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(entityId);
    return variant && variant.representativeEntityId === entityId ? variant.model : null;
  }

  /** 在 Locator 的 boxes 网格中根据列/层定位具体 box 的世界矩阵，平移对齐 box 底面中心（货物支撑位）。 */
  public getLocatorBoxWorldMatrix(locator: LocatorRuntimeEntry, toX: number, toY: number): Matrix | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      startLayer: locator.startLayer,
      columns: locator.columns,
      layers: locator.layers,
      columnReversed: locator.columnReversed,
      toX,
      toY,
    });
    if (boxIndex === null) return null;
    const supportPosition = resolveLocatorCellSupportWorldPosition(locator, boxIndex);
    if (!supportPosition) return null;
    // 货物模板原点即底部支撑点：矩阵平移取格子底面中心，与 stacker 接管货物的支撑位一致
    const worldMatrix = locator.root.getWorldMatrix().clone();
    worldMatrix.setTranslation(supportPosition);
    return worldMatrix;
  }

  /** 同步虚拟定位线框的根 Transform、业务尺寸和选中态线框颜色。 */
  public syncLocatorEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    const locator = entity.components.locator;
    if (!locator) return;

    const binding = locator.builtInBinding ?? null;
    const hostEntry = binding ? this.dependencies.assets.models.get(binding.hostEntityId) ?? null : null;
    // 阵列副本没有独立模型宿主：副本参数与源分化后经参数变体渲染，布局必须读实际渲染它的模型。
    const arrayHostEntity = !hostEntry && binding
      ? this.dependencies.arrays.modelArrayInstanceEntities.get(binding.hostEntityId) ?? null
      : null;
    const arrayHostRenderEntry = arrayHostEntity ? this.dependencies.bounds.resolveModelArrayRenderModel(arrayHostEntity) : null;
    const bound = Boolean(binding && (hostEntry || (arrayHostEntity && arrayHostRenderEntry)));
    const hostBindingConfig = bound && binding
      ? this.dependencies.document.syncedEntities.get(binding.hostEntityId)?.components.modelAsset?.builtInSlotBindingConfig
        ?? arrayHostEntity?.components.modelAsset?.builtInSlotBindingConfig
        ?? hostEntry?.entitySnapshot?.components.modelAsset?.builtInSlotBindingConfig
        ?? arrayHostRenderEntry?.entitySnapshot?.components.modelAsset?.builtInSlotBindingConfig
      : undefined;
    const hostParameterValues = bound && binding
      ? this.dependencies.document.syncedEntities.get(binding.hostEntityId)?.components.modelAsset?.parameterValues
        ?? arrayHostEntity?.components.modelAsset?.parameterValues
        ?? hostEntry?.entitySnapshot?.components.modelAsset?.parameterValues
        ?? arrayHostRenderEntry?.entitySnapshot?.components.modelAsset?.parameterValues
      : undefined;
    const columnSplit = hostBindingConfig ? deriveColumnSplitFromBinding(hostBindingConfig, hostParameterValues) : 1;
    const columnSign = hostBindingConfig?.columnDirection === '-x' ? -1 : 1;
    const isLayerChangePlatform = binding?.kind === 'layerChangePlatform';
    const hostMetadata = hostEntry?.contentRoot.metadata ?? arrayHostRenderEntry?.contentRoot.metadata;
    const layout = bound && !isLayerChangePlatform ? this.readBuiltInSlotLayout(hostMetadata) : null;
    const platformLayout = bound && isLayerChangePlatform ? this.readLayerChangePlatformLayout(hostMetadata) : null;
    const bindingSteps = bound
      ? {
          // layout 写的是物理格距，按列向分裂比例细分为逻辑列步距；layout 未就绪时 locator.length 已是派生后的逻辑格宽
          columnStepX: isLayerChangePlatform
            ? locator.length + locator.columnGap
            : columnSign * (layout ? layout.columnSpacing / columnSplit : locator.length + locator.columnGap),
          layerStepY: (isLayerChangePlatform ? platformLayout?.layerStepY : layout?.layerStepY) ?? locator.height + locator.layerGap,
        }
      : null;
    // 多排绑定：按排索引取本排布局（越界落到末排）。排进深可能小于货格自身宽度（例如一个整格沿进深均分），
    // 此时用该进深覆盖线框宽度，让填充/边线/拾取/遥测解算都按真实格子尺寸走。
    const layoutRows = layout?.rows;
    const rowLayout = layoutRows?.[Math.min(binding?.rowIndex ?? 0, layoutRows.length - 1)];
    const effectiveLocator = rowLayout?.depthZ !== undefined && rowLayout.depthZ !== locator.width
      ? { ...locator, width: rowLayout.depthZ }
      : locator;
    const signature = this.createLocatorSignature(effectiveLocator, bindingSteps);

    let runtimeLocator = this.locators.get(entity.id);
    if (runtimeLocator && runtimeLocator.root.isDisposed()) {
      // 模型重载会递归销毁挂在模型根下的货格节点（重挂 parent 无法复活）；
      // 原地替换节点字段而不是换条目对象：locatorTargets/locatorDeviceIndex/fetch 上下文都持有条目引用，
      // 换对象会让索引滞留死节点直到下一次完整同步，期间遥测按死节点的脏矩阵解算库位。
      const rebuilt = this.createLocator(entity.id, effectiveLocator, bindingSteps);
      runtimeLocator.material.dispose();
      runtimeLocator.root = rebuilt.root;
      runtimeLocator.fillMesh = rebuilt.fillMesh;
      runtimeLocator.edgeLines = rebuilt.edgeLines;
      runtimeLocator.columnLabelsRoot = rebuilt.columnLabelsRoot;
      runtimeLocator.columnLabels = rebuilt.columnLabels;
      runtimeLocator.cellSteps = rebuilt.cellSteps;
      runtimeLocator.material = rebuilt.material;
      runtimeLocator.signature = signature;
    }
    if (!runtimeLocator) {
      runtimeLocator = this.createLocator(entity.id, effectiveLocator, bindingSteps);
      runtimeLocator.signature = signature;
      this.locators.set(entity.id, runtimeLocator);
    }

    if (bound && binding && (hostEntry || arrayHostEntity)) {
      const offset = binding.originOffset;
      const localPosition = isLayerChangePlatform
        ? (platformLayout
            ? {
                x: platformLayout.centerX + offset.x,
                y: platformLayout.firstLayerSurfaceY + offset.y,
                z: platformLayout.depthCenterZ + offset.z,
              }
            // 布局 metadata 未就绪（脚本尚未运行），先落在货架局部原点，脚本就绪后由 refreshBuiltInSlotBindings 修正。
            : { x: offset.x, y: offset.y, z: offset.z })
        : layout
        ? {
            // 逻辑首格中心 = 物理首格中心沿列向退让 (物理格宽−逻辑格宽)/2；
            // 退让方向由 columnDirection 决定（'-x' 时改向 +x 退），故符号只作用在退让量上。
            x: layout.firstCellCenterX - columnSign * layout.columnSpacing * (columnSplit - 1) / (2 * columnSplit) + offset.x,
            y: layout.firstLayerSurfaceY + offset.y,
            z: (rowLayout?.depthCenterZ ?? layout.depthCenterZ) + offset.z,
          }
        // 布局 metadata 未就绪（脚本尚未运行），先落在货架局部原点，脚本就绪后由 refreshBuiltInSlotBindings 修正。
        : { x: offset.x, y: offset.y, z: offset.z };
      if (hostEntry) {
        runtimeLocator.root.parent = hostEntry.root;
        runtimeLocator.root.position.set(localPosition.x, localPosition.y, localPosition.z);
        runtimeLocator.root.rotationQuaternion = null;
        runtimeLocator.root.rotation.set(0, 0, 0);
        runtimeLocator.root.scaling.set(1, 1, 1);
        runtimeLocator.platformTrackEndWorld = isLayerChangePlatform && platformLayout?.trackEndX !== undefined
          ? Vector3.TransformCoordinates(
              new Vector3(platformLayout.trackEndX + offset.x, localPosition.y, localPosition.z),
              hostEntry.root.getWorldMatrix(),
            )
          : null;
      } else if (arrayHostEntity) {
        // 阵列副本在场景中没有宿主节点：把源布局点经副本实体 transform 转到世界空间。
        const hostTransform = arrayHostEntity.components.transform;
        const hostMatrix = Matrix.Compose(
          new Vector3(hostTransform.scale.x, hostTransform.scale.y, hostTransform.scale.z),
          Quaternion.RotationYawPitchRoll(hostTransform.rotation.y, hostTransform.rotation.x, hostTransform.rotation.z),
          new Vector3(hostTransform.position.x, hostTransform.position.y, hostTransform.position.z),
        );
        const worldPosition = Vector3.TransformCoordinates(
          new Vector3(localPosition.x, localPosition.y, localPosition.z),
          hostMatrix,
        );
        runtimeLocator.root.parent = null;
        runtimeLocator.root.position.copyFrom(worldPosition);
        runtimeLocator.root.rotationQuaternion = null;
        runtimeLocator.root.rotation.set(hostTransform.rotation.x, hostTransform.rotation.y, hostTransform.rotation.z);
        runtimeLocator.root.scaling.set(hostTransform.scale.x, hostTransform.scale.y, hostTransform.scale.z);
        runtimeLocator.platformTrackEndWorld = isLayerChangePlatform && platformLayout?.trackEndX !== undefined
          ? Vector3.TransformCoordinates(
              new Vector3(platformLayout.trackEndX + offset.x, localPosition.y, localPosition.z),
              hostMatrix,
            )
          : null;
      }
      // 宿主可能被阵列批次挂起（根节点保持启用），货格显隐由绑定条件统一计算。
      runtimeLocator.root.setEnabled(this.computeBuiltInSlotRenderable(entity, highlightSet));
    } else {
      if (runtimeLocator.root.parent) runtimeLocator.root.parent = null;
      runtimeLocator.platformTrackEndWorld = null;
      this.dependencies.presentation.applyTransform(runtimeLocator.root, entity.components.transform);
    }
    // 覆写前捕获旧拓扑：供货格网格增量更新判定（拓扑不变走原地刷新，避免参数调整时数万顶点销毁重建）
    const previousLocatorTopology = {
      columns: runtimeLocator.columns,
      layers: runtimeLocator.layers,
      startColumn: runtimeLocator.startColumn,
      columnReversed: runtimeLocator.columnReversed,
      contiguous: Math.abs(runtimeLocator.cellSteps.columnStepX - runtimeLocator.cellSize.length) < LOCATOR_CONTIGUOUS_EPSILON
        && Math.abs(runtimeLocator.cellSteps.layerStepY - runtimeLocator.cellSize.height) < LOCATOR_CONTIGUOUS_EPSILON,
    };
    runtimeLocator.assetId = locator.assetId;
    runtimeLocator.deviceAssetCode = locator.deviceAssetCode;
    runtimeLocator.aisleCode = locator.aisleCode;
    runtimeLocator.rowNumber = locator.rowNumber;
    runtimeLocator.columns = locator.columns;
    runtimeLocator.layers = locator.layers;
    runtimeLocator.startColumn = locator.startColumn;
    runtimeLocator.startLayer = locator.startLayer;
    runtimeLocator.columnReversed = locator.columnReversed;
    runtimeLocator.storageDepth = locator.storageDepth;
    runtimeLocator.kind = locator.builtInBinding?.kind === 'layerChangePlatform' ? 'layerChangePlatform' : 'slot';
    runtimeLocator.retainCargo = locator.retainCargo === true;
    runtimeLocator.cellSize = { length: effectiveLocator.length, height: effectiveLocator.height, width: effectiveLocator.width };

    const locatorMetadata = { assetId: locator.assetId };
    runtimeLocator.root.metadata = { ...(runtimeLocator.root.metadata ?? {}), storageLocation: locatorMetadata };

    if (runtimeLocator.signature !== signature) {
      // 拓扑不变走原地更新（边线/标签缓冲复用），否则全量重建
      const cellSteps = {
        columnStepX: bindingSteps?.columnStepX ?? effectiveLocator.length + effectiveLocator.columnGap,
        layerStepY: bindingSteps?.layerStepY ?? effectiveLocator.height + effectiveLocator.layerGap,
      };
      if (!this.tryUpdateLocatorGridInPlace(entity.id, effectiveLocator, runtimeLocator, cellSteps, previousLocatorTopology)) {
        runtimeLocator.fillMesh.dispose(false, false);
        runtimeLocator.edgeLines.dispose(false, false);
        this.disposeLocatorColumnLabels(runtimeLocator);
        const rebuilt = this.buildLocatorGridMeshes(entity.id, effectiveLocator, runtimeLocator.root, runtimeLocator.material, cellSteps);
        runtimeLocator.fillMesh = rebuilt.fillMesh;
        runtimeLocator.edgeLines = rebuilt.edgeLines;
        runtimeLocator.columnLabels = this.buildLocatorColumnLabels(entity.id, effectiveLocator, cellSteps, runtimeLocator.columnLabelsRoot);
      }
      runtimeLocator.cellSteps = cellSteps;
      runtimeLocator.signature = signature;
      if (this.dependencies.selection.localSlotHighlight?.entityId === entity.id) this.refreshSlotHighlightOverlay('local');
      if (this.dependencies.selection.externalSlotHighlight?.entityId === entity.id) this.refreshSlotHighlightOverlay('external');
    } else if (
      this.dependencies.selection.localSlotHighlight?.entityId === entity.id
      && this.dependencies.selection.localSlotHighlightOverlay?.entityId !== entity.id
    ) {
      this.refreshSlotHighlightOverlay('local');
    } else if (
      this.dependencies.selection.externalSlotHighlight?.entityId === entity.id
      && this.dependencies.selection.externalSlotHighlightOverlay?.entityId !== entity.id
    ) {
      this.refreshSlotHighlightOverlay('external');
    }

    runtimeLocator.fillMesh.metadata = { ...(runtimeLocator.fillMesh.metadata ?? {}), storageLocation: locatorMetadata };
    this.applyLocatorStyle(runtimeLocator, selected);
    this.applyLocatorInteractivity(runtimeLocator, entity, highlightSet);

    if (locator.fetchDrive?.enabled) {
      if (!this.dependencies.fetch.locatorFetchRuntimes.has(entity.id)) {
        const fetchRuntime = new LocatorFetchRuntime(this.context.scene, entity.id, (message) => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]));
        fetchRuntime.onStatisticsChanged = () => this.dependencies.readiness.invalidateModelStatistics();
        this.dependencies.fetch.locatorFetchRuntimes.set(entity.id, fetchRuntime);
      }
    } else {
      this.dependencies.fetch.disposeLocatorFetchRuntime(entity.id);
    }
  }

  /** 创建虚拟定位线框：根节点交给 Gizmo；填充面与边线各一个网格，整货架只产生两次 draw call。 */
  public createLocator(entityId: string, locator: LocatorComponent, bindingSteps?: LocatorBindingSteps | null): LocatorRuntimeEntry {
    const root = new TransformNode(`${entityId}_locatorRoot`, this.context.scene);
    const material = new StandardMaterial(`${entityId}_locatorMat`, this.context.scene);

    material.disableLighting = true;
    material.alpha = LOCATOR_SURFACE_ALPHA;
    material.diffuseColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    material.emissiveColor = Color3.FromHexString(LOCATOR_EDGE_COLOR);

    const cellSteps: LocatorBindingSteps = {
      columnStepX: bindingSteps?.columnStepX ?? locator.length + locator.columnGap,
      layerStepY: bindingSteps?.layerStepY ?? locator.height + locator.layerGap,
    };
    const { fillMesh, edgeLines } = this.buildLocatorGridMeshes(entityId, locator, root, material, cellSteps);

    const columnLabelsRoot = new TransformNode(`${entityId}_locatorColumnLabelsRoot`, this.context.scene);
    columnLabelsRoot.parent = root;
    columnLabelsRoot.setEnabled(false);
    const columnLabels = this.buildLocatorColumnLabels(entityId, locator, cellSteps, columnLabelsRoot);

    return { entityId, root, fillMesh, edgeLines, columnLabelsRoot, columnLabels, cellSteps, cellSize: { length: locator.length, height: locator.height, width: locator.width }, material, assetId: '', signature: '', columns: locator.columns, layers: locator.layers, startColumn: locator.startColumn, startLayer: locator.startLayer, columnReversed: locator.columnReversed, deviceAssetCode: locator.deviceAssetCode, aisleCode: locator.aisleCode, rowNumber: locator.rowNumber, storageDepth: locator.storageDepth, kind: locator.builtInBinding?.kind === 'layerChangePlatform' ? 'layerChangePlatform' : 'slot', platformTrackEndWorld: null, retainCargo: locator.retainCargo === true };
  }

  /**
   * 生成货格的填充网格与合并边线网格。
   * 格子中心公式（列 × 列步距, 高/2 + 层 × 层步距, 0）是渲染与支撑位解析的共同来源，改动必须两边同步。
   * 连续网格（步距等于格子尺寸）时合并为单个覆盖盒 + 通长网格线，软渲染下避免上万实例的顶点处理。
   */
  public buildLocatorGridMeshes(
    entityId: string,
    locator: LocatorComponent,
    root: TransformNode,
    material: StandardMaterial,
    cellSteps: LocatorBindingSteps,
  ): { fillMesh: Mesh; edgeLines: LinesMesh } {
    const fillMesh = this.buildLocatorFillMesh(entityId, locator, cellSteps);
    fillMesh.parent = root;
    fillMesh.material = material;
    fillMesh.metadata = { [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };

    const edgeLinesMesh = MeshBuilder.CreateLineSystem(`${entityId}_locatorEdges`, { lines: this.buildLocatorEdgeLinePaths(locator, cellSteps), updatable: true }, this.context.scene);
    edgeLinesMesh.parent = root;
    edgeLinesMesh.color = Color3.FromHexString(LOCATOR_EDGE_COLOR);
    edgeLinesMesh.alpha = 1;
    edgeLinesMesh.isPickable = false;
    return { fillMesh, edgeLines: edgeLinesMesh };
  }

  /** 货格网格是否为连续模式（步距等于格子尺寸）：合并单覆盖盒 + 通长网格线。 */
  public isLocatorGridContiguous(locator: LocatorComponent, cellSteps: LocatorBindingSteps): boolean {
    return (
      Math.abs(cellSteps.columnStepX - locator.length) < LOCATOR_CONTIGUOUS_EPSILON &&
      Math.abs(cellSteps.layerStepY - locator.height) < LOCATOR_CONTIGUOUS_EPSILON
    );
  }

  /** 创建填充网格（parent/material/metadata 由调用方设置）：连续模式单覆盖盒，否则单格盒 + 薄实例矩阵。 */
  public buildLocatorFillMesh(
    entityId: string,
    locator: LocatorComponent,
    cellSteps: LocatorBindingSteps,
  ): Mesh {
    const { length, height, width, columns, layers } = locator;
    if (this.isLocatorGridContiguous(locator, cellSteps)) {
      const spanX = (columns - 1) * cellSteps.columnStepX + length;
      const spanY = (layers - 1) * cellSteps.layerStepY + height;
      const fillMesh = MeshBuilder.CreateBox(`${entityId}_locatorFill`, { width: spanX, height: spanY, depth: width }, this.context.scene);
      fillMesh.position.set((columns - 1) * cellSteps.columnStepX / 2, spanY / 2, 0);
      return fillMesh;
    }

    const cellCount = Math.max(1, columns * layers);
    const fillMesh = MeshBuilder.CreateBox(`${entityId}_locatorFill`, { width: length, height, depth: width }, this.context.scene);
    const matrices = new Float32Array(cellCount * 16);
    for (let layer = 0; layer < layers; layer += 1) {
      for (let col = 0; col < columns; col += 1) {
        const cellIndex = layer * columns + col;
        Matrix.Translation(col * cellSteps.columnStepX, height / 2 + layer * cellSteps.layerStepY, 0).copyToArray(matrices, cellIndex * 16);
      }
    }
    fillMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
    fillMesh.thinInstanceRefreshBoundingInfo(true);
    return fillMesh;
  }

  /** 生成全部货格边线的线段路径：连续模式为通长网格线，否则每格 12 边；顶点数由拓扑（列数/层数/模式）决定。 */
  public buildLocatorEdgeLinePaths(locator: LocatorComponent, cellSteps: LocatorBindingSteps): Vector3[][] {
    const { length, height, width, columns, layers } = locator;
    const halfLength = length / 2;
    const halfHeight = height / 2;
    const halfWidth = width / 2;
    const edgeLines: Vector3[][] = [];

    if (this.isLocatorGridContiguous(locator, cellSteps)) {
      const spanX = (columns - 1) * cellSteps.columnStepX + length;
      const spanY = (layers - 1) * cellSteps.layerStepY + height;
      const minX = -halfLength;
      const maxX = minX + spanX;
      const maxY = spanY;
      for (const z of [-halfWidth, halfWidth]) {
        for (let i = 0; i <= columns; i += 1) {
          const x = minX + i * cellSteps.columnStepX;
          edgeLines.push([new Vector3(x, 0, z), new Vector3(x, maxY, z)]);
        }
        for (let j = 0; j <= layers; j += 1) {
          const y = j * cellSteps.layerStepY;
          edgeLines.push([new Vector3(minX, y, z), new Vector3(maxX, y, z)]);
        }
      }
      for (let i = 0; i <= columns; i += 1) {
        for (let j = 0; j <= layers; j += 1) {
          const x = minX + i * cellSteps.columnStepX;
          const y = j * cellSteps.layerStepY;
          edgeLines.push([new Vector3(x, y, -halfWidth), new Vector3(x, y, halfWidth)]);
        }
      }
      return edgeLines;
    }

    for (let layer = 0; layer < layers; layer += 1) {
      for (let col = 0; col < columns; col += 1) {
        const centerX = col * cellSteps.columnStepX;
        const centerY = height / 2 + layer * cellSteps.layerStepY;
        const minX = centerX - halfLength;
        const maxX = centerX + halfLength;
        const minY = centerY - halfHeight;
        const maxY = centerY + halfHeight;
        const minZ = -halfWidth;
        const maxZ = halfWidth;
        edgeLines.push(
          [new Vector3(minX, minY, minZ), new Vector3(maxX, minY, minZ)],
          [new Vector3(maxX, minY, minZ), new Vector3(maxX, minY, maxZ)],
          [new Vector3(maxX, minY, maxZ), new Vector3(minX, minY, maxZ)],
          [new Vector3(minX, minY, maxZ), new Vector3(minX, minY, minZ)],
          [new Vector3(minX, maxY, minZ), new Vector3(maxX, maxY, minZ)],
          [new Vector3(maxX, maxY, minZ), new Vector3(maxX, maxY, maxZ)],
          [new Vector3(maxX, maxY, maxZ), new Vector3(minX, maxY, maxZ)],
          [new Vector3(minX, maxY, maxZ), new Vector3(minX, maxY, minZ)],
          [new Vector3(minX, minY, minZ), new Vector3(minX, maxY, minZ)],
          [new Vector3(minX, minY, maxZ), new Vector3(minX, maxY, maxZ)],
          [new Vector3(maxX, minY, minZ), new Vector3(maxX, maxY, minZ)],
          [new Vector3(maxX, minY, maxZ), new Vector3(maxX, maxY, maxZ)],
        );
      }
    }
    return edgeLines;
  }

  /**
   * 拓扑（列数/层数/连续模式）不变时的原地更新：fillMesh 重建（24 顶点盒子便宜），
   * 边线复用 LinesMesh 缓冲（顶点数由拓扑决定，拓扑不变则数量一致），
   * 列号标签文案不变时复用纹理仅改位置缩放。返回 false 表示需走全量重建。
   */
  public tryUpdateLocatorGridInPlace(
    entityId: string,
    locator: LocatorComponent,
    runtimeLocator: LocatorRuntimeEntry,
    cellSteps: LocatorBindingSteps,
    previous: { columns: number; layers: number; startColumn: number; columnReversed: boolean; contiguous: boolean },
  ): boolean {
    if (
      previous.columns !== locator.columns
      || previous.layers !== locator.layers
      || previous.contiguous !== this.isLocatorGridContiguous(locator, cellSteps)
    ) {
      return false;
    }

    runtimeLocator.fillMesh.dispose(false, false);
    const fillMesh = this.buildLocatorFillMesh(entityId, locator, cellSteps);
    fillMesh.parent = runtimeLocator.root;
    fillMesh.material = runtimeLocator.material;
    fillMesh.metadata = { [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };
    runtimeLocator.fillMesh = fillMesh;

    MeshBuilder.CreateLineSystem(
      `${entityId}_locatorEdges`,
      { lines: this.buildLocatorEdgeLinePaths(locator, cellSteps), instance: runtimeLocator.edgeLines },
      this.context.scene,
    );

    if (previous.startColumn === locator.startColumn && previous.columnReversed === locator.columnReversed) {
      this.syncLocatorColumnLabelsInPlace(locator, cellSteps, runtimeLocator.columnLabels);
    } else {
      this.disposeLocatorColumnLabels(runtimeLocator);
      runtimeLocator.columnLabels = this.buildLocatorColumnLabels(entityId, locator, cellSteps, runtimeLocator.columnLabelsRoot);
    }
    return true;
  }

  /**
   * 为每列顶部创建列号标签（billboard 平面 + 数字纹理），仅在选中高亮时由 applyLocatorStyle 启用。
   * 位置公式与格子中心同源（列 × 列步距），合批/薄实例两种渲染模式共用一套坐标；
   * 列号文案按 columnReversed 换算业务列号。无 canvas 环境（NullEngine 测试）直接返回空数组。
   */
  public buildLocatorColumnLabels(
    entityId: string,
    locator: LocatorComponent,
    cellSteps: LocatorBindingSteps,
    labelsRoot: TransformNode,
  ): LocatorColumnLabel[] {
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return [];

    const { length, height, columns, layers, startColumn, columnReversed } = locator;
    const topY = (layers - 1) * cellSteps.layerStepY + height;
    const size = Math.min(
      LOCATOR_COLUMN_LABEL_MAX_SIZE,
      Math.max(LOCATOR_COLUMN_LABEL_MIN_SIZE, Math.min(Math.abs(cellSteps.columnStepX), length) * 0.8),
    );
    const labels: LocatorColumnLabel[] = [];
    for (let col = 0; col < columns; col += 1) {
      const businessColumn = startColumn + (columnReversed ? columns - 1 - col : col);
      const text = String(businessColumn);
      const texture = new DynamicTexture(
        `${entityId}_locatorColumnLabel_${col}`,
        { width: LOCATOR_COLUMN_LABEL_TEXTURE_SIZE, height: LOCATOR_COLUMN_LABEL_TEXTURE_SIZE },
        this.context.scene,
        false,
      );
      texture.hasAlpha = true;
      const context = texture.getContext() as unknown as CanvasRenderingContext2D;
      const fontSize = text.length >= 3 ? 44 : text.length === 2 ? 56 : 68;
      context.font = `700 ${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = SELECTED_MATERIAL_COLOR;
      context.fillText(text, LOCATOR_COLUMN_LABEL_TEXTURE_SIZE / 2, LOCATOR_COLUMN_LABEL_TEXTURE_SIZE / 2 + 3);
      // 保持默认 invertY 翻转：canvas y 向下，不翻转会贴到平面上数字上下颠倒。
      texture.update();

      const material = new StandardMaterial(`${entityId}_locatorColumnLabelMat_${col}`, this.context.scene);
      material.disableLighting = true;
      material.backFaceCulling = false;
      material.diffuseTexture = texture;
      material.opacityTexture = texture;
      material.emissiveColor = Color3.White();

      const plane = MeshBuilder.CreatePlane(`${entityId}_locatorColumnLabelPlane_${col}`, { size: 1 }, this.context.scene);
      plane.parent = labelsRoot;
      plane.scaling.setAll(size);
      plane.position.set(col * cellSteps.columnStepX, topY + size * 0.6, 0);
      plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
      plane.material = material;
      plane.isPickable = false;
      labels.push({ mesh: plane, material, texture });
    }
    return labels;
  }

  /** 拓扑与文案不变时的列号标签原地更新：复用纹理/材质/网格，仅按新步距刷新位置与缩放。 */
  public syncLocatorColumnLabelsInPlace(
    locator: LocatorComponent,
    cellSteps: LocatorBindingSteps,
    labels: LocatorColumnLabel[],
  ): void {
    if (labels.length !== locator.columns) return;
    const topY = (locator.layers - 1) * cellSteps.layerStepY + locator.height;
    const size = Math.min(
      LOCATOR_COLUMN_LABEL_MAX_SIZE,
      Math.max(LOCATOR_COLUMN_LABEL_MIN_SIZE, Math.min(Math.abs(cellSteps.columnStepX), locator.length) * 0.8),
    );
    labels.forEach((label, col) => {
      label.mesh.scaling.setAll(size);
      label.mesh.position.set(col * cellSteps.columnStepX, topY + size * 0.6, 0);
    });
  }

  /** 销毁列号标签网格及其独立材质纹理；labelsRoot 本身随 locator root 统一销毁。 */
  public disposeLocatorColumnLabels(entry: LocatorRuntimeEntry): void {
    for (const label of entry.columnLabels) {
      label.mesh.dispose(false, true);
    }
    entry.columnLabels = [];
  }

  /** 读取货架脚本写入 contentRoot metadata 的内置货格实测布局；字段缺失或非有限数字时视为未就绪。 */
  public readBuiltInSlotLayout(metadata: unknown): BuiltInSlotLayoutInfo | null {
    if (!isPlainRecord(metadata)) return null;
    const layout = metadata.builtInSlotLayout;
    if (!isPlainRecord(layout)) return null;
    const read = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const firstCellCenterX = read(layout.firstCellCenterX);
    const firstLayerSurfaceY = read(layout.firstLayerSurfaceY);
    const columnSpacing = read(layout.columnSpacing);
    const layerStepY = read(layout.layerStepY);
    const depthCenterZ = read(layout.depthCenterZ);
    if (firstCellCenterX === null || firstLayerSurfaceY === null || columnSpacing === null || layerStepY === null || depthCenterZ === null) {
      return null;
    }
    // 多排布局：逐排读进深中心，depthZ 可选（缺省由运行时回退货格自身宽度）；非法项直接丢弃。
    const rows: BuiltInSlotRowLayoutInfo[] = [];
    if (Array.isArray(layout.rows)) {
      for (const raw of layout.rows) {
        if (!isPlainRecord(raw)) continue;
        const rowCenterZ = read(raw.depthCenterZ);
        if (rowCenterZ === null) continue;
        const rowDepthZ = read(raw.depthZ);
        rows.push(rowDepthZ === null ? { depthCenterZ: rowCenterZ } : { depthCenterZ: rowCenterZ, depthZ: rowDepthZ });
      }
    }
    return { firstCellCenterX, firstLayerSurfaceY, columnSpacing, layerStepY, depthCenterZ, ...(rows.length > 0 ? { rows } : {}) };
  }

  /** 读取货架脚本写入 contentRoot metadata 的换层站台布局；字段缺失或非有限数字时视为未就绪。 */
  public readLayerChangePlatformLayout(metadata: unknown): LayerChangePlatformLayoutInfo | null {
    if (!isPlainRecord(metadata)) return null;
    const layout = metadata.layerChangePlatformLayout;
    if (!isPlainRecord(layout)) return null;
    const read = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const centerX = read(layout.centerX);
    const firstLayerSurfaceY = read(layout.firstLayerSurfaceY);
    const layerStepY = read(layout.layerStepY);
    const depthCenterZ = read(layout.depthCenterZ);
    if (centerX === null || firstLayerSurfaceY === null || layerStepY === null || depthCenterZ === null) return null;
    const trackEndX = read(layout.trackEndX);
    return { centerX, firstLayerSurfaceY, layerStepY, depthCenterZ, ...(trackEndX !== null ? { trackEndX } : {}) };
  }

  public createLocatorSignature(locator: LocatorComponent, bindingSteps?: LocatorBindingSteps | null): string {
    return [
      locator.length.toFixed(3),
      locator.height.toFixed(3),
      locator.width.toFixed(3),
      String(locator.columns),
      String(locator.layers),
      // 起始列与列反向只影响列号标签文案，不影响网格几何；纳入签名触发标签重建。
      String(locator.startColumn),
      locator.columnReversed ? 'rev' : 'fwd',
      locator.columnGap.toFixed(3),
      locator.layerGap.toFixed(3),
      bindingSteps ? `${bindingSteps.columnStepX.toFixed(3)}|${bindingSteps.layerStepY.toFixed(3)}` : 'free',
    ].join('|');
  }

  /** 释放虚拟定位线框的根节点、填充/边线网格和材质。 */
  public disposeLocator(entityId: string, locator: LocatorRuntimeEntry): void {
    this.dependencies.transforms.clearEntityArrayPreviewIfSource(entityId);
    this.dependencies.telemetry.specializedTelemetryRuntime.disposeRetainedSlotCargoForLocator(entityId);
    this.dependencies.fetch.disposeLocatorFetchRuntime(entityId);
    if (this.dependencies.selection.localSlotHighlightOverlay?.entityId === entityId) this.disposeSlotHighlightOverlay('local');
    if (this.dependencies.selection.externalSlotHighlightOverlay?.entityId === entityId) this.disposeSlotHighlightOverlay('external');
    if (this.dependencies.selection.localSlotHighlight?.entityId === entityId) this.dependencies.selection.localSlotHighlight = null;
    if (this.dependencies.selection.externalSlotHighlight?.entityId === entityId) this.dependencies.selection.externalSlotHighlight = null;
    locator.fillMesh.dispose(false, false);
    locator.edgeLines.dispose(false, false);
    this.disposeLocatorColumnLabels(locator);
    locator.material.dispose();
    locator.root.dispose(false, true);
    this.locators.delete(entityId);
  }

  /**
   * 计算绑定货格当前是否应渲染：眼睛开关开启且宿主或货格自身被高亮时显示。
   * 运行预览/发布 Viewer 默认仍隐藏内置货格，但外部搜索高亮宿主或货格时需要露出线框。
   * 非绑定货格返回 true，不受管控。
   */
  public computeBuiltInSlotRenderable(
    entity: Entity,
    selectedEntityIds: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): boolean {
    const binding = entity.components.locator?.builtInBinding;
    if (!binding) return true;
    const hostState = this.dependencies.document.entityStates.get(binding.hostEntityId);
    if (!hostState || hostState.visible === false) return false;
    if (!this.dependencies.document.isEntityVisible(entity.id)) return false;
    const highlighted = this.dependencies.selection.isEntityHighlighted(binding.hostEntityId, selectedEntityIds)
      || this.dependencies.selection.isEntityHighlighted(entity.id, selectedEntityIds)
      || this.dependencies.selection.externalSlotHighlight?.entityId === entity.id;
    if (this.dependencies.telemetry.telemetryPreviewActive) {
      // 发布 Viewer / 运行预览默认隐藏内置货格；外部搜索描边露出整架线框，
      // 点击单元的单格高亮仅启用 root 供 overlay 渲染，货格自身线框在 applyLocatorInteractivity 中隐藏。
      return this.dependencies.selection.externalHighlightedEntityIds.has(entity.id)
        || this.dependencies.selection.externalSlotHighlight?.entityId === entity.id
        || this.dependencies.selection.localSlotHighlight?.entityId === entity.id;
    }
    return highlighted;
  }

  /** 预览开关切换时全量重算绑定货格显隐；幂等，未创建的 locator 条目直接跳过。 */
  public refreshAllBuiltInSlotRenderability(): void {
    for (const entity of this.dependencies.document.syncedEntities.values()) {
      if (!entity.components.locator?.builtInBinding) continue;
      const locator = this.locators.get(entity.id);
      if (locator) locator.root.setEnabled(this.computeBuiltInSlotRenderable(entity));
    }
  }

  /** 货格交互：填充网格承载拾取（薄实例拾取解析到实体），边线只跟随显隐。 */
  public applyLocatorInteractivity(
    locator: LocatorRuntimeEntry,
    entity: Entity,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    this.dependencies.presentation.applyMeshInteractivity(locator.fillMesh, entity.id);
    locator.edgeLines.isVisible = this.dependencies.document.isEntityVisible(entity.id);
    locator.columnLabelsRoot.isVisible = locator.edgeLines.isVisible;
    if (this.dependencies.selection.localSlotHighlight?.entityId === entity.id) {
      // 点击单元高亮时隐藏货格自身蓝色线框/填充/列号，只呈现独立的单格 overlay。
      locator.fillMesh.isVisible = false;
      locator.fillMesh.isPickable = false;
      locator.edgeLines.isVisible = false;
      locator.columnLabelsRoot.isVisible = false;
    }
    if (entity.components.locator?.builtInBinding) {
      locator.root.setEnabled(this.computeBuiltInSlotRenderable(entity, highlightSet));
    }
  }

  /** 刷新单个 locator 的选中样式与显隐，用于外部货格高亮切换。 */
  public refreshLocatorPresentation(entityId: string): void {
    const entity = this.dependencies.document.syncedEntities.get(entityId);
    const locator = this.locators.get(entityId);
    if (!entity?.components.locator || !locator) return;
    this.applyLocatorStyle(locator, this.dependencies.selection.isEntityHighlighted(entityId));
    this.applyLocatorInteractivity(locator, entity);
  }

  /** 释放指定来源产生的单格 overlay。 */
  public disposeSlotHighlightOverlay(source: 'local' | 'external'): void {
    const overlay = source === 'local' ? this.dependencies.selection.localSlotHighlightOverlay : this.dependencies.selection.externalSlotHighlightOverlay;
    if (!overlay) return;
    overlay.fillMesh.parent = null;
    overlay.edgeFrame.parent = null;
    overlay.fillMesh.dispose(false, false);
    overlay.edgeFrame.dispose(false, false);
    overlay.material.dispose();
    overlay.edgeMaterial.dispose();
    if (source === 'local') this.dependencies.selection.localSlotHighlightOverlay = null;
    else this.dependencies.selection.externalSlotHighlightOverlay = null;
  }

  /** 按指定来源当前的货格坐标重建略微放大的单格填充盒与 12 边线框。 */
  public refreshSlotHighlightOverlay(source: 'local' | 'external'): void {
    const highlight = source === 'local' ? this.dependencies.selection.localSlotHighlight : this.dependencies.selection.externalSlotHighlight;
    this.disposeSlotHighlightOverlay(source);
    if (!highlight) return;
    const locator = this.locators.get(highlight.entityId);
    if (!locator || locator.root.isDisposed()) return;
    const boxIndex = resolveLocatorCellLocalIndex(locator, highlight.coordinate);
    if (boxIndex === null) return;
    const local = resolveLocatorCellLocalBounds(locator, boxIndex);
    if (!local) return;

    const material = new StandardMaterial(`${source}_${highlight.entityId}_slotHighlightMat`, this.context.scene);
    material.disableLighting = true;
    material.alpha = SLOT_HIGHLIGHT_SURFACE_ALPHA;
    const color3 = Color3.FromHexString(SELECTED_MATERIAL_COLOR);
    material.diffuseColor = color3;
    material.emissiveColor = color3;
    // 高亮 overlay 不做深度测试，始终画在最上层不被货架/货物遮挡。
    material.depthFunction = Constants.ALWAYS;

    const sizeX = local.size.x * SLOT_HIGHLIGHT_SIZE_SCALE;
    const sizeY = local.size.y * SLOT_HIGHLIGHT_SIZE_SCALE;
    const sizeZ = local.size.z * SLOT_HIGHLIGHT_SIZE_SCALE;
    const fillMesh = MeshBuilder.CreateBox(`${source}_${highlight.entityId}_slotHighlightFill`, {
      width: sizeX,
      height: sizeY,
      depth: sizeZ,
    }, this.context.scene);
    fillMesh.parent = locator.root;
    fillMesh.position.set(local.center.x, local.center.y, local.center.z);
    fillMesh.material = material;
    fillMesh.isPickable = false;
    fillMesh.renderingGroupId = 1;

    const hx = sizeX / 2;
    const hy = sizeY / 2;
    const hz = sizeZ / 2;
    const t = SLOT_HIGHLIGHT_EDGE_THICKNESS;
    const edgeMaterial = new StandardMaterial(`${source}_${highlight.entityId}_slotHighlightEdgeMat`, this.context.scene);
    edgeMaterial.disableLighting = true;
    edgeMaterial.diffuseColor = color3;
    edgeMaterial.emissiveColor = color3;
    edgeMaterial.depthFunction = Constants.ALWAYS;

    const edgeFrame = new TransformNode(`${source}_${highlight.entityId}_slotHighlightEdges`, this.context.scene);
    edgeFrame.parent = locator.root;
    edgeFrame.position.set(local.center.x, local.center.y, local.center.z);
    const edgeSpecs: { size: [number, number, number]; center: [number, number, number] }[] = [
      { size: [sizeX, t, t], center: [0, -hy, -hz] },
      { size: [sizeX, t, t], center: [0, -hy, hz] },
      { size: [sizeX, t, t], center: [0, hy, -hz] },
      { size: [sizeX, t, t], center: [0, hy, hz] },
      { size: [t, sizeY, t], center: [-hx, 0, -hz] },
      { size: [t, sizeY, t], center: [hx, 0, -hz] },
      { size: [t, sizeY, t], center: [-hx, 0, hz] },
      { size: [t, sizeY, t], center: [hx, 0, hz] },
      { size: [t, t, sizeZ], center: [-hx, -hy, 0] },
      { size: [t, t, sizeZ], center: [hx, -hy, 0] },
      { size: [t, t, sizeZ], center: [-hx, hy, 0] },
      { size: [t, t, sizeZ], center: [hx, hy, 0] },
    ];
    edgeSpecs.forEach((spec, index) => {
      const edge = MeshBuilder.CreateBox(`${source}_${highlight.entityId}_slotHighlightEdge_${index}`, {
        width: spec.size[0],
        height: spec.size[1],
        depth: spec.size[2],
      }, this.context.scene);
      edge.parent = edgeFrame;
      edge.position.set(spec.center[0], spec.center[1], spec.center[2]);
      edge.material = edgeMaterial;
      edge.isPickable = false;
      edge.renderingGroupId = 1;
    });

    const overlay: LocatorSlotHighlightOverlay = {
      entityId: highlight.entityId,
      coordinate: highlight.coordinate,
      fillMesh,
      edgeFrame,
      material,
      edgeMaterial,
    };
    if (source === 'local') this.dependencies.selection.localSlotHighlightOverlay = overlay;
    else this.dependencies.selection.externalSlotHighlightOverlay = overlay;
  }

  /** 根据选中状态更新 locator 填充面与边线颜色；列号标签仅在选中高亮且非运行预览时启用。 */
  public applyLocatorStyle(entry: LocatorRuntimeEntry, selected: boolean): void {
    const color = selected ? SELECTED_MATERIAL_COLOR : LOCATOR_EDGE_COLOR;
    const color3 = Color3.FromHexString(color);

    entry.material.alpha = selected ? SELECTED_LOCATOR_SURFACE_ALPHA : LOCATOR_SURFACE_ALPHA;
    entry.material.diffuseColor = color3;
    entry.material.emissiveColor = color3;
    entry.edgeLines.color = color3;
    entry.columnLabelsRoot.setEnabled(selected && !this.dependencies.telemetry.telemetryPreviewActive);
  }

  /** 货架脚本更新布局 metadata 后，重同步其全部绑定货格的位置与网格步距。 */
  public refreshBuiltInSlotBindings(hostEntityId: string): void {
    const hostEntity = this.dependencies.document.syncedEntities.get(hostEntityId) ?? null;
    const hostAsset = hostEntity?.components.modelAsset;
    const hostRenderSignature = hostAsset
      ? this.dependencies.arrays.createModelArrayRenderSignature(hostAsset, hostEntity?.components.telemetryBinding)
      : null;
    for (const entity of this.dependencies.document.syncedEntities.values()) {
      const locator = entity.components.locator;
      const boundHostId = locator?.builtInBinding?.hostEntityId;
      if (!boundHostId) continue;
      if (boundHostId === hostEntityId) {
        this.syncLocatorEntity(entity, this.dependencies.selection.isEntityHighlighted(entity.id));
        continue;
      }
      // 绑定到阵列副本的货格跟随副本渲染源的布局更新；副本参数与源已分化时改由参数变体脚本就绪后刷新。
      const boundHost = this.dependencies.document.syncedEntities.get(boundHostId) ?? this.dependencies.arrays.modelArrayInstanceEntities.get(boundHostId);
      if (boundHost?.components.modelArrayInstance?.sourceEntityId !== hostEntityId) continue;
      const boundHostAsset = boundHost.components.modelAsset;
      if (
        hostRenderSignature
        && boundHostAsset
        && this.dependencies.arrays.createModelArrayRenderSignature(boundHostAsset, boundHost.components.telemetryBinding) !== hostRenderSignature
      ) {
        continue;
      }
      this.syncLocatorEntity(entity, this.dependencies.selection.isEntityHighlighted(entity.id));
    }
  }
}
