import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { mapAgvPointToScene } from '../../../editor/model/agvMap.ts';
import type { AgvMapComponent } from '../../../editor/model/components';

/** CAD 平面以 X/Z 为底，Y 轴由映射后的两个平面轴确定。 */
export function getAgvMapPlane({ xAxis, yAxis }: Pick<AgvMapComponent, 'xAxis' | 'yAxis'>) {
  const axes = { xAxis, yAxis, scale: 1 };
  const x = mapAgvPointToScene({ x: 1, y: 0 }, axes);
  const z = mapAgvPointToScene({ x: 0, y: 1 }, axes);
  const right = new Vector3(x.x, x.y, x.z);
  const forward = new Vector3(z.x, z.y, z.z);
  return { right, up: Vector3.Cross(forward, right), forward };
}
