import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { getAgvMapSceneAxisBase, mapAgvPointToScene, type AgvMapSceneAxis } from '../../../../editor/model/agvMap';
import type { TelemetryBindingComponent } from '../../../../editor/model/telemetryBinding';
import { readIntegerField, readNumberField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import type { AgvMapPlacement } from '../../scene-runtime/sceneRuntimeTypes';

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

function applyAgvMapPosition(model: ModelRuntimeEntry, x: number | null, y: number | null): void {
  const placement = model.agvMapPlacement;
  if (!placement) {
    if (x !== null) model.root.position.x = x;
    if (y !== null) model.root.position.z = y;
    return;
  }

  const matrix = createAgvMapPlacementMatrix(placement);
  const current = Vector3.TransformCoordinates(model.root.position, matrix.clone().invert());
  const mapped = mapAgvPointToScene({
    x: x ?? readAgvMapCoordinate(current, placement.map.xAxis, placement.map.scale),
    y: y ?? readAgvMapCoordinate(current, placement.map.yAxis, placement.map.scale),
  }, placement.map);
  const world = Vector3.TransformCoordinates(new Vector3(mapped.x, mapped.y, mapped.z), matrix);
  model.root.position.copyFrom(world);
}

/** 动态 AGV 按产生器地图原点、轴映射和比例尺定位；静态 AGV 保持世界坐标驱动。 */
export class AgvTelemetryDriver {
  public applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
    if (snapshot.faulted || readIntegerField(snapshot.fields, 'mode') === 0) return;

    const x = readNumberField(snapshot.fields, 'x');
    const y = readNumberField(snapshot.fields, 'y');
    const heading = readNumberField(snapshot.fields, 'r');
    if (x !== null || y !== null) applyAgvMapPosition(model, x, y);
    if (heading !== null) {
      model.root.rotationQuaternion = null;
      model.root.rotation.y = resolveAgvYawRadians(
        heading,
        model.telemetryBinding?.modelForwardAxis
          ?? model.entitySnapshot?.components.modelAsset?.dataDrivenConfig?.device.modelForwardAxis
          ?? 'x',
      );
    }
  }
}
