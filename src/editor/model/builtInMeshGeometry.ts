import type { MeshKind } from './components';
import type { Vector3Data } from './math';

/** 内置 Box 的基准边长，编辑器场景单位固定为米。 */
export const BUILT_IN_BOX_SIZE_METERS = 1;
/** 内置 Sphere 的基准直径，编辑器场景单位固定为米。 */
export const BUILT_IN_SPHERE_DIAMETER_METERS = 1;
/** 内置 Plane 的 X/Z 基准边长，编辑器场景单位固定为米。 */
export const BUILT_IN_PLANE_SIZE_METERS = 2;

/** 返回内置 Mesh 的未缩放米制包围尺寸；Plane 没有实体厚度，因此 Y 为 0。 */
export function getBuiltInMeshBaseDimensionsMeters(meshKind: MeshKind): Vector3Data {
  if (meshKind === 'sphere') {
    return {
      x: BUILT_IN_SPHERE_DIAMETER_METERS,
      y: BUILT_IN_SPHERE_DIAMETER_METERS,
      z: BUILT_IN_SPHERE_DIAMETER_METERS,
    };
  }
  if (meshKind === 'plane') {
    return { x: BUILT_IN_PLANE_SIZE_METERS, y: 0, z: BUILT_IN_PLANE_SIZE_METERS };
  }

  return { x: BUILT_IN_BOX_SIZE_METERS, y: BUILT_IN_BOX_SIZE_METERS, z: BUILT_IN_BOX_SIZE_METERS };
}

/** 返回内置 Mesh 资源卡片使用的米制尺寸文案。 */
export function formatBuiltInMeshBaseDimensionsMeters(meshKind: MeshKind): string {
  if (meshKind === 'sphere') return `直径 ${BUILT_IN_SPHERE_DIAMETER_METERS} m`;
  if (meshKind === 'plane') return `${BUILT_IN_PLANE_SIZE_METERS} m × ${BUILT_IN_PLANE_SIZE_METERS} m`;
  return `${BUILT_IN_BOX_SIZE_METERS} m × ${BUILT_IN_BOX_SIZE_METERS} m × ${BUILT_IN_BOX_SIZE_METERS} m`;
}

/** 返回 Inspector 使用的内置几何单位说明，不改变 Transform.scale 的底层契约。 */
export function getBuiltInMeshMeterDescription(meshKind: MeshKind): string {
  if (meshKind === 'cube') {
    return `Box 基准尺寸：${formatBuiltInMeshBaseDimensionsMeters(meshKind)}；size 的 X/Y/Z 直接按米编辑。`;
  }

  return `${meshKind === 'sphere' ? 'Sphere' : 'Plane'} 基准尺寸：${formatBuiltInMeshBaseDimensionsMeters(meshKind)}；scale 仍表示无量纲缩放比例。`;
}

/** 返回内置 Mesh 拖到地面时需要抬高的中心高度，保证有体积对象底面落地。 */
export function getBuiltInMeshGroundOffsetMeters(meshKind: MeshKind): number {
  if (meshKind === 'sphere') return BUILT_IN_SPHERE_DIAMETER_METERS / 2;
  if (meshKind === 'cube') return BUILT_IN_BOX_SIZE_METERS / 2;
  return 0;
}
