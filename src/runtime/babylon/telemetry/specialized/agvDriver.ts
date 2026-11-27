import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import {
  AGV_MAP_NODE_RADIUS_DEFAULT,
  findAgvMapNodeWithinRadius,
  findAgvMapShortestRoute,
  getAgvMapSceneAxisBase,
  mapAgvPointToScene,
  projectAgvPointToRoute,
  resolveAgvMapNodeId,
  sliceAgvMapRouteFromNode,
  type AgvMapRoute,
  type AgvMapSceneAxis,
} from '../../../../editor/model/agvMap';
import type { TelemetryBindingComponent } from '../../../../editor/model/telemetryBinding';
import { readIntegerField, readNumberField, readStringField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import type { AgvMapPlacement } from '../../scene-runtime/sceneRuntimeTypes';
import { AgvTaskRouteHighlight } from '../../agv/AgvTaskRouteHighlight';
import { findModelNodesByName, getNodesWorldBounds, worldDeltaToParentLocalDelta } from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import { normalizeCargoTask, type GeneratedCargoRuntimeEntry, type SpecializedTelemetryDriverContext } from './types';

export type AgvModelForwardAxis = NonNullable<TelemetryBindingComponent['modelForwardAxis']>;

const FORWARD_AXIS_OFFSET_DEGREES: Record<AgvModelForwardAxis, number> = {
  x: 0,
  '-x': 180,
  z: -90,
  '-z': 90,
};

/** NDC8 车头角以场景 +X 为零、顺时针为正；模型轴只补偿几何初始朝向。 */
export function resolveAgvYawRadians(
  headingDegrees: number,
  modelForwardAxis: AgvModelForwardAxis = 'x',
): number {
  return (headingDegrees + FORWARD_AXIS_OFFSET_DEGREES[modelForwardAxis]) * Math.PI / 180;
}

function createAgvMapPlacementMatrix(placement: AgvMapPlacement): Matrix {
  const { transform } = placement;
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.FromEulerAngles(transform.rotation.x, transform.rotation.y, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

function readAgvMapCoordinate(point: Vector3, axis: AgvMapSceneAxis, scale: number): number {
  const value = point[getAgvMapSceneAxisBase(axis)];
  return (axis.startsWith('-') ? -value : value) / scale;
}

function resolveAgvMapPosition(
  model: ModelRuntimeEntry,
  x: number | null,
  y: number | null,
  currentPosition: Vector3,
): Vector3 {
  const placement = model.agvMapPlacement;
  if (!placement) {
    return new Vector3(x ?? currentPosition.x, currentPosition.y, y ?? currentPosition.z);
  }

  const matrix = createAgvMapPlacementMatrix(placement);
  const current = Vector3.TransformCoordinates(currentPosition, matrix.clone().invert());
  const mapped = mapAgvPointToScene({
    x: x ?? readAgvMapCoordinate(current, placement.map.xAxis, placement.map.scale),
    y: y ?? readAgvMapCoordinate(current, placement.map.yAxis, placement.map.scale),
  }, placement.map);
  return Vector3.TransformCoordinates(new Vector3(mapped.x, mapped.y, mapped.z), matrix);
}

function resolveClosestAgvYaw(targetYaw: number, referenceYaw: number): number {
  const delta = targetYaw - referenceYaw;
  return referenceYaw + Math.atan2(Math.sin(delta), Math.cos(delta));
}

export const AGV_MOTION_DEFAULT_SEGMENT_SECONDS = 0.5;
const AGV_MOTION_MIN_SEGMENT_SECONDS = 1 / 60;

function readSnapshotTime(snapshot: DeviceTelemetrySnapshot): number {
  return snapshot.sourceTimestamp ?? snapshot.receivedAt;
}

function resolveSegmentDuration(
  model: ModelRuntimeEntry,
  previousTimeMs: number,
  nextTimeMs: number,
): number {
  const measuredSeconds = (nextTimeMs - previousTimeMs) / 1000;
  if (Number.isFinite(measuredSeconds) && measuredSeconds > 0) {
    return Math.max(AGV_MOTION_MIN_SEGMENT_SECONDS, measuredSeconds);
  }
  const expectedSeconds = (model.telemetryBinding?.expectedIntervalMs
    ?? AGV_MOTION_DEFAULT_SEGMENT_SECONDS * 1000) / 1000;
  return Math.max(AGV_MOTION_MIN_SEGMENT_SECONDS, expectedSeconds);
}

function readTaskPoint(snapshot: DeviceTelemetrySnapshot, key: string): string | null {
  return readStringField(snapshot.fields, key)?.trim() || null;
}

function readTaskRouteKey(snapshot: DeviceTelemetrySnapshot): string | null {
  const start = readTaskPoint(snapshot, 'task_begin_point');
  const end = readTaskPoint(snapshot, 'task_end_point');
  return start && end ? `${start}\0${end}` : null;
}

type AgvLiftState = {
  nodes: TransformNode[];
  baselines: Map<TransformNode, Vector3>;
  offset: number;
  targetOffset: number;
};

type AgvCargoConfig = {
  deckNodes: string[];
  liftNodes: string[];
  liftDistance: number;
  liftSpeed: number;
};

type AgvMotionState = {
  lastSnapshot: DeviceTelemetrySnapshot;
  lastSampleTimeMs: number;
  startPosition: Vector3;
  targetPosition: Vector3;
  startYaw: number;
  targetYaw: number | null;
  elapsedSeconds: number;
  durationSeconds: number;
  taskRouteKey: string | null;
  taskRouteAnchorNodeId: string | null;
  taskRouteEndNodeId: string | null;
  taskRoute: AgvMapRoute | null;
  taskRouteFull: AgvMapRoute | null;
  taskRouteHighlight: AgvTaskRouteHighlight | null;
};

const AGV_CARGO_LIFT_DISTANCE_DEFAULT = 0.1;
const AGV_CARGO_LIFT_SPEED_DEFAULT = 0.2;

/** 动态 AGV 按产生器地图原点、轴映射和比例尺定位；静态 AGV 保持世界坐标驱动。 */
export class AgvTelemetryDriver {
  private motionStates = new WeakMap<ModelRuntimeEntry, AgvMotionState>();
  private liftStates = new WeakMap<ModelRuntimeEntry, AgvLiftState>();
  private readonly liftStateSet = new Set<AgvLiftState>();
  private readonly routeHighlights = new Set<AgvTaskRouteHighlight>();
  private readonly reportedCargoIssues = new Set<string>();

  constructor(private readonly context?: SpecializedTelemetryDriverContext) {}

  public applyToModel(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    if (snapshot.faulted || readIntegerField(snapshot.fields, 'mode') === 0) return;

    const x = readNumberField(snapshot.fields, 'x');
    const y = readNumberField(snapshot.fields, 'y');
    const heading = readNumberField(snapshot.fields, 'r');
    let state = this.motionStates.get(model);
    if (!state) {
      if (x === null && y === null && heading === null) {
        this.updateCargo(model, snapshot, deltaSeconds);
        return;
      }
      const targetYaw = heading === null ? null : this.resolveModelYaw(model, heading);
      model.root.position.copyFrom(resolveAgvMapPosition(model, x, y, model.root.position));
      if (targetYaw !== null) {
        model.root.rotationQuaternion = null;
        model.root.rotation.y = targetYaw;
      }
      state = {
        lastSnapshot: snapshot,
        lastSampleTimeMs: readSnapshotTime(snapshot),
        startPosition: model.root.position.clone(),
        targetPosition: model.root.position.clone(),
        startYaw: model.root.rotation.y,
        targetYaw,
        elapsedSeconds: AGV_MOTION_DEFAULT_SEGMENT_SECONDS,
        durationSeconds: AGV_MOTION_DEFAULT_SEGMENT_SECONDS,
        taskRouteKey: null,
        taskRouteAnchorNodeId: null,
        taskRouteEndNodeId: null,
        taskRoute: null,
        taskRouteFull: null,
        taskRouteHighlight: null,
      };
      this.motionStates.set(model, state);
      model.root.onDisposeObservable.add(() => {
        const current = this.motionStates.get(model);
        if (current) this.disposeTaskRouteHighlight(current);
      });
      this.updateTaskRoute(model, snapshot, state);
      this.updateTaskRouteHighlight(model, state, 0);
      this.updateCargo(model, snapshot, deltaSeconds);
      return;
    }

    if (state.lastSnapshot !== snapshot) {
      const sampleTimeMs = readSnapshotTime(snapshot);
      const targetPosition = resolveAgvMapPosition(model, x, y, state.targetPosition);
      const resolvedYaw = heading === null ? null : this.resolveModelYaw(model, heading);
      const targetYaw = resolvedYaw === null
        ? state.targetYaw
        : resolveClosestAgvYaw(resolvedYaw, state.targetYaw ?? model.root.rotation.y);
      if (!targetPosition.equals(state.targetPosition) || targetYaw !== state.targetYaw) {
        state.startPosition.copyFrom(model.root.position);
        state.targetPosition.copyFrom(targetPosition);
        state.startYaw = model.root.rotation.y;
        state.targetYaw = targetYaw;
        state.elapsedSeconds = 0;
        state.durationSeconds = resolveSegmentDuration(model, state.lastSampleTimeMs, sampleTimeMs);
      }
      state.lastSampleTimeMs = sampleTimeMs;
      state.lastSnapshot = snapshot;
      this.updateTaskRoute(model, snapshot, state);
    }

    if (state.elapsedSeconds < state.durationSeconds) {
      state.elapsedSeconds = Math.min(
        state.durationSeconds,
        state.elapsedSeconds + Math.max(0, deltaSeconds),
      );
      const progress = state.elapsedSeconds / state.durationSeconds;
      Vector3.LerpToRef(state.startPosition, state.targetPosition, progress, model.root.position);
      if (state.targetYaw !== null) {
        model.root.rotationQuaternion = null;
        model.root.rotation.y = state.startYaw + (state.targetYaw - state.startYaw) * progress;
      }
    }
    this.updateTaskRouteHighlight(model, state, deltaSeconds);
    this.updateCargo(model, snapshot, deltaSeconds);
  }

  public hasPendingMotion(model: ModelRuntimeEntry): boolean {
    const state = this.motionStates.get(model);
    const liftState = this.liftStates.get(model);
    return (state ? state.elapsedSeconds < state.durationSeconds : false)
      || (liftState ? Math.abs(liftState.targetOffset - liftState.offset) > 1e-9 : false);
  }

  public getTaskRoute(model: ModelRuntimeEntry, startNodeId?: string, endNodeId?: string): AgvMapRoute | null {
    const state = this.motionStates.get(model);
    if (!state) return null;
    if (startNodeId !== undefined && endNodeId !== undefined
      && state.taskRouteKey !== `${startNodeId}\0${endNodeId}`) return null;
    return state.taskRoute;
  }

  public disposeCargoForAssetCode(assetCode: string): void {
    if (!this.context) return;
    const cargo = this.context.state.agvCargoMeshes.get(assetCode);
    if (cargo) this.context.host.disposeGeneratedCargo(cargo);
    this.context.state.agvCargoMeshes.delete(assetCode);
  }

  private updateCargo(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    if (!this.context) return;
    const signalBits = readIntegerField(snapshot.fields, 'signalBits');
    const command = readIntegerField(snapshot.fields, 'command');
    this.updateLift(model, snapshot, command, signalBits, deltaSeconds);
    if (signalBits === 0 || command === 6) {
      this.disposeCargoForAssetCode(model.assetCode);
      return;
    }

    const existing = this.context.state.agvCargoMeshes.get(model.assetCode) ?? null;
    if (signalBits !== 1 && !existing) return;
    const supportPosition = this.resolveCargoSupportPosition(model);
    if (!supportPosition) return;
    const cargo = existing ?? this.createCargo(model.assetCode);
    const containerCode = readStringField(snapshot.fields, 'containerCode');
    const task = readIntegerField(snapshot.fields, 'task');
    if (containerCode !== null) cargo.containerCode = containerCode.trim();
    if (task !== null) cargo.task = normalizeCargoTask(task);

    this.context.host.syncGeneratedCargoVisual(
      cargo,
      'agv',
      snapshot,
      this.context.host.resolveCargoGeneratorForModel(model),
      model.entitySnapshot?.id ?? '',
    );
    model.root.computeWorldMatrix(true);
    const rotation = Quaternion.Identity();
    model.root.getWorldMatrix().decompose(undefined, rotation);
    this.context.host.setGeneratedCargoRootPose(cargo, supportPosition, rotation);
    cargo.lockedWorldRotation = rotation.clone();
  }

  private createCargo(assetCode: string): GeneratedCargoRuntimeEntry {
    const context = this.context!;
    const root = new TransformNode(`agv_cargo_root_${sanitizeBabylonName(assetCode)}`, context.scene);
    const cargo: GeneratedCargoRuntimeEntry = {
      assetCode,
      containerCode: '',
      task: '',
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
      axialLengthCache: null,
      lockedWorldRotation: null,
    };
    context.state.agvCargoMeshes.set(assetCode, cargo);
    return cargo;
  }

  private updateLift(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    command: number | null,
    signalBits: number | null,
    deltaSeconds: number,
  ): void {
    const config = this.readCargoConfig(model);
    if (config.liftNodes.length === 0) return;
    const nodes = findModelNodesByName(model, this.context!.scene, config.liftNodes);
    if (nodes.length !== new Set(config.liftNodes).size) return;

    let state = this.liftStates.get(model);
    if (!state) {
      state = {
        nodes,
        baselines: new Map(nodes.map(node => [node, node.position.clone()])),
        offset: 0,
        targetOffset: 0,
      };
      this.liftStates.set(model, state);
      this.liftStateSet.add(state);
    }

    if (command === 3) state.targetOffset = config.liftDistance;
    else if (command === 1 || command === 2 || command === 4 || command === 5 || command === 6) {
      state.targetOffset = 0;
    } else if (command === 0 || command === null) {
      state.targetOffset = signalBits === 1 ? config.liftDistance : 0;
    }

    const elapsed = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    const remaining = state.targetOffset - state.offset;
    const step = Math.sign(remaining) * Math.min(Math.abs(remaining), config.liftSpeed * elapsed);
    state.offset += step;
    const worldOffset = new Vector3(0, state.offset, 0);
    for (const node of state.nodes) {
      const baseline = state.baselines.get(node)!;
      node.position = baseline.add(worldDeltaToParentLocalDelta(node, worldOffset));
      node.computeWorldMatrix(true);
    }
  }

  private resolveCargoSupportPosition(model: ModelRuntimeEntry): Vector3 | null {
    const nodeNames = this.readCargoConfig(model).deckNodes;
    const nodes = findModelNodesByName(model, this.context!.scene, nodeNames);
    if (nodeNames.length > 0 && nodes.length === new Set(nodeNames).size) {
      const bounds = getNodesWorldBounds(nodes);
      if (bounds) {
        const position = bounds.minimum.add(bounds.maximum).scale(0.5);
        position.y = bounds.maximum.y;
        return position;
      }
    }

    const issueKey = `agv-cargo-deck:${model.assetCode}`;
    if (!this.reportedCargoIssues.has(issueKey)) {
      this.reportedCargoIssues.add(issueKey);
      this.context!.host.pushLog(
        `AGV ${model.assetCode} 无法生成货物：请完整配置 dataDriven.cargo.deckNodes 载货节点，并确认节点存在。`,
      );
    }
    return null;
  }

  private readCargoConfig(model: ModelRuntimeEntry): AgvCargoConfig {
    const documentConfig = model.resolvedModelAsset?.dataDrivenConfig
      ?? model.entitySnapshot?.components.modelAsset?.dataDrivenConfig;
    const configs = [
      ...(documentConfig ? [documentConfig] : []),
      ...(model.externalScriptRuntime?.getDataDrivenConfigs() ?? []),
    ];
    for (const dataDriven of configs) {
      const declaredDeckNodes = readStringArrayPath(dataDriven, ['cargo', 'deckNodes']);
      const deckNodes = declaredDeckNodes.length > 0
        ? declaredDeckNodes
        : readStringArrayPath(dataDriven, ['cargo', 'nodes']);
      if (deckNodes.length === 0) continue;
      const cargo = isPlainRecord(dataDriven) && isPlainRecord(dataDriven.cargo) ? dataDriven.cargo : {};
      const lift = isPlainRecord(cargo.lift) ? cargo.lift : {};
      const declaredLiftNodes = readStringArrayPath(lift, ['followNodes']);
      const configuredLiftNodes = declaredLiftNodes.length > 0
        ? declaredLiftNodes
        : readStringArrayPath(lift, ['nodes']);
      const rawDistance = typeof lift.distance === 'number' ? lift.distance : Number(lift.distance);
      const rawSpeed = typeof lift.speed === 'number' ? lift.speed : Number(lift.speed);
      return {
        deckNodes,
        liftNodes: configuredLiftNodes.length > 0 ? configuredLiftNodes : deckNodes,
        liftDistance: Number.isFinite(rawDistance) && rawDistance >= 0
          ? rawDistance
          : AGV_CARGO_LIFT_DISTANCE_DEFAULT,
        liftSpeed: Number.isFinite(rawSpeed) && rawSpeed > 0
          ? rawSpeed
          : AGV_CARGO_LIFT_SPEED_DEFAULT,
      };
    }
    return {
      deckNodes: [],
      liftNodes: [],
      liftDistance: AGV_CARGO_LIFT_DISTANCE_DEFAULT,
      liftSpeed: AGV_CARGO_LIFT_SPEED_DEFAULT,
    };
  }

  public resetMotionStates(): void {
    for (const state of this.liftStateSet) {
      for (const [node, baseline] of state.baselines) {
        if (!node.isDisposed()) node.position.copyFrom(baseline);
      }
    }
    this.liftStateSet.clear();
    this.liftStates = new WeakMap<ModelRuntimeEntry, AgvLiftState>();
    for (const highlight of this.routeHighlights) highlight.dispose();
    this.routeHighlights.clear();
    this.motionStates = new WeakMap<ModelRuntimeEntry, AgvMotionState>();
  }

  private updateTaskRoute(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    state: AgvMotionState,
  ): void {
    const routeKey = readTaskRouteKey(snapshot);
    if (routeKey === state.taskRouteKey) return;
    state.taskRouteKey = routeKey;
    state.taskRoute = null;
    state.taskRouteFull = null;
    state.taskRouteAnchorNodeId = null;
    state.taskRouteEndNodeId = null;
    this.disposeTaskRouteHighlight(state);
    const placement = model.agvMapPlacement;
    const map = placement?.definition;
    if (!routeKey || !map || !placement) return;
    const [startPoint, endPoint] = routeKey.split('\0');
    this.replaceTaskRoute(
      model,
      state,
      resolveAgvMapNodeId(map, startPoint),
      resolveAgvMapNodeId(map, endPoint),
    );
  }

  private replaceTaskRoute(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    startNodeId: string | null,
    endNodeId: string | null,
  ): void {
    const map = model.agvMapPlacement?.definition;
    this.setTaskRoute(
      model,
      state,
      startNodeId,
      endNodeId,
      map && startNodeId && endNodeId ? findAgvMapShortestRoute(map, startNodeId, endNodeId) : null,
    );
  }

  private setTaskRoute(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    startNodeId: string | null,
    endNodeId: string | null,
    route: AgvMapRoute | null,
  ): void {
    const placement = model.agvMapPlacement;
    this.disposeTaskRouteHighlight(state);
    state.taskRouteAnchorNodeId = startNodeId;
    state.taskRouteEndNodeId = endNodeId;
    state.taskRoute = route;
    state.taskRouteFull = route;
    const highlight = placement?.routeHighlight;
    if (!placement || !state.taskRoute || state.taskRoute.distance <= 0 || !highlight?.enabled) return;
    state.taskRouteHighlight = new AgvTaskRouteHighlight(
      model.root.name,
      model.root.getScene(),
      state.taskRoute,
      placement,
      highlight,
    );
    this.routeHighlights.add(state.taskRouteHighlight);
  }

  private updateTaskRouteHighlight(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    deltaSeconds: number,
  ): void {
    const placement = model.agvMapPlacement;
    if (!placement) return;
    const current = Vector3.TransformCoordinates(
      model.root.position,
      createAgvMapPlacementMatrix(placement).invert(),
    );
    const mapPoint = {
      x: readAgvMapCoordinate(current, placement.map.xAxis, placement.map.scale),
      y: readAgvMapCoordinate(current, placement.map.yAxis, placement.map.scale),
    };
    const map = placement.definition;
    const fullRoute = state.taskRouteFull;
    let projection = fullRoute ? projectAgvPointToRoute(fullRoute.points, mapPoint) : null;
    if (map && state.taskRouteEndNodeId) {
      const nodeRadius = (placement.map.nodeRadius ?? AGV_MAP_NODE_RADIUS_DEFAULT) / placement.map.scale;
      const touchedNodeId = findAgvMapNodeWithinRadius(map, mapPoint, nodeRadius);
      if (touchedNodeId && touchedNodeId !== state.taskRouteAnchorNodeId) {
        const remainingRoute = fullRoute
          ? sliceAgvMapRouteFromNode(map, fullRoute, touchedNodeId)
          : null;
        const followsCurrentRoute = projection !== null
          && Math.hypot(mapPoint.x - projection.point.x, mapPoint.y - projection.point.y) <= nodeRadius;
        if (remainingRoute) {
          state.taskRouteAnchorNodeId = touchedNodeId;
          state.taskRoute = remainingRoute;
          if (remainingRoute.distance <= 0) this.disposeTaskRouteHighlight(state);
        } else if (followsCurrentRoute) {
          state.taskRouteAnchorNodeId = touchedNodeId;
        } else {
          this.replaceTaskRoute(model, state, touchedNodeId, state.taskRouteEndNodeId);
          projection = state.taskRouteFull
            ? projectAgvPointToRoute(state.taskRouteFull.points, mapPoint)
            : null;
        }
      }
    }
    const highlight = state.taskRouteHighlight;
    if (!highlight || !state.taskRouteFull) return;
    highlight.update(projection?.progress ?? 0, deltaSeconds);
  }

  private disposeTaskRouteHighlight(state: AgvMotionState): void {
    if (!state.taskRouteHighlight) return;
    this.routeHighlights.delete(state.taskRouteHighlight);
    state.taskRouteHighlight.dispose();
    state.taskRouteHighlight = null;
  }

  private resolveModelYaw(model: ModelRuntimeEntry, heading: number): number {
    return resolveAgvYawRadians(
      heading,
      model.telemetryBinding?.modelForwardAxis
        ?? model.entitySnapshot?.components.modelAsset?.dataDrivenConfig?.device.modelForwardAxis
        ?? 'x',
    );
  }
}
