import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { CAD_REFERENCE_GRID_Y_OFFSET_METERS } from '../../../editor/cad/cadReferenceCore';
import {
  NDC8_POINT_LAYER_NAME,
  type CadReferenceFillCircle,
} from '../../../editor/cad/cadReferenceDrawingStyle';

/** 把所有点位填充合批在一个 CAD 图层中。 */
export function createCadReferenceFillMesh(
  entityId: string,
  root: TransformNode,
  circles: readonly CadReferenceFillCircle[],
) {
  const scene = root.getScene();
  const mesh = CreateDisc(`${entityId}_cadPointFills`, { radius: 1, tessellation: 32 }, scene);
  mesh.bakeTransformIntoVertices(Matrix.RotationX(Math.PI / 2));
  mesh.parent = root;
  mesh.isPickable = false;
  mesh.metadata = { cadReferenceLayer: NDC8_POINT_LAYER_NAME };
  const material = new StandardMaterial(`${mesh.name}_material`, scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.onDisposeObservable.addOnce(() => material.dispose());
  const matrices = new Float32Array(circles.length * 16);
  for (const [index, { x, y, radius }] of circles.entries()) {
    const offset = index * 16;
    matrices[offset] = matrices[offset + 10] = radius;
    matrices[offset + 5] = matrices[offset + 15] = 1;
    matrices[offset + 12] = x;
    matrices[offset + 13] = CAD_REFERENCE_GRID_Y_OFFSET_METERS;
    matrices[offset + 14] = y;
  }
  mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
  return mesh;
}
