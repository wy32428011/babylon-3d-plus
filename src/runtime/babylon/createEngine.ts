import {
  ArcRotateCamera,
  Color3,
  Engine,
  GlowLayer,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { SCENE_LENGTH_UNIT_SYMBOL } from '../../editor/model/sceneUnits';

export type BabylonViewport = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
};

const GRID_SIZE_METERS = 240;
const GRID_SUBDIVISIONS = 240;
const GRID_SPACING_METERS = GRID_SIZE_METERS / GRID_SUBDIVISIONS;
const GRID_CELL_SIZE_LABEL = `${GRID_SPACING_METERS} ${SCENE_LENGTH_UNIT_SYMBOL}`;
const GRID_ALPHA_BASE = 0.18;
const GRID_ALPHA_PULSE = 0.08;
const GRID_LINE_GLOW_ALPHA_BASE = 0.08;
const GRID_LINE_GLOW_ALPHA_PULSE = 0.18;
const GRID_LINE_GLOW_INTENSITY_BASE = 0.22;
const GRID_LINE_GLOW_INTENSITY_PULSE = 0.42;
const BREATHING_SPEED = 0.0018;

/** 按米制网格间距吸附位置，保证网格跟随相机时仍然对齐世界坐标。 */
function snapToGrid(value: number): number {
  return Math.round(value / GRID_SPACING_METERS) * GRID_SPACING_METERS;
}

/** 创建编辑器辅助地面网格和网格线呼吸光晕；网格每小格表示 1 m，该辅助层不进入 SceneDocument，也不可被拾取选中。 */
function createEditorGround(scene: Scene): void {
  const grid = MeshBuilder.CreateGround(
    'EditorGroundGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions: GRID_SUBDIVISIONS,
    },
    scene,
  );
  grid.isPickable = false;
  grid.metadata = { cellSizeLabel: GRID_CELL_SIZE_LABEL };

  const gridMaterial = new StandardMaterial('EditorGroundGridMaterial', scene);
  gridMaterial.diffuseColor = Color3.FromHexString('#4fa8ff');
  gridMaterial.emissiveColor = Color3.FromHexString('#1e6fb5');
  gridMaterial.alpha = GRID_ALPHA_BASE;
  gridMaterial.wireframe = true;
  gridMaterial.backFaceCulling = false;
  grid.material = gridMaterial;

  const lineGlowGrid = MeshBuilder.CreateGround(
    'EditorGroundLineGlowGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions: GRID_SUBDIVISIONS,
    },
    scene,
  );
  lineGlowGrid.position.y = 0.006;
  lineGlowGrid.isPickable = false;

  const lineGlowMaterial = new StandardMaterial('EditorGroundLineGlowMaterial', scene);
  lineGlowMaterial.diffuseColor = Color3.FromHexString('#7fd4ff');
  lineGlowMaterial.emissiveColor = Color3.FromHexString('#7fd4ff');
  lineGlowMaterial.alpha = GRID_LINE_GLOW_ALPHA_BASE;
  lineGlowMaterial.wireframe = true;
  lineGlowMaterial.backFaceCulling = false;
  lineGlowGrid.material = lineGlowMaterial;

  const lineGlowLayer = new GlowLayer('EditorGroundLineGlowLayer', scene);
  lineGlowLayer.intensity = GRID_LINE_GLOW_INTENSITY_BASE;
  lineGlowLayer.addIncludedOnlyMesh(lineGlowGrid);

  scene.onBeforeRenderObservable.add(() => {
    const cameraPosition = scene.activeCamera?.position;
    if (cameraPosition) {
      const snappedX = snapToGrid(cameraPosition.x);
      const snappedZ = snapToGrid(cameraPosition.z);
      grid.position.x = snappedX;
      grid.position.z = snappedZ;
      lineGlowGrid.position.x = snappedX;
      lineGlowGrid.position.z = snappedZ;
    }

    const pulse = (Math.sin(performance.now() * BREATHING_SPEED) + 1) / 2;
    gridMaterial.alpha = GRID_ALPHA_BASE + pulse * GRID_ALPHA_PULSE;
    lineGlowMaterial.alpha = GRID_LINE_GLOW_ALPHA_BASE + pulse * GRID_LINE_GLOW_ALPHA_PULSE;
    lineGlowLayer.intensity = GRID_LINE_GLOW_INTENSITY_BASE + pulse * GRID_LINE_GLOW_INTENSITY_PULSE;
  });
}

export function createBabylonViewport(canvas: HTMLCanvasElement): BabylonViewport {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor.set(0.08, 0.08, 0.09, 1);

  const camera = new ArcRotateCamera('EditorCamera', Math.PI / 4, Math.PI / 3, 8, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 40;

  const light = new HemisphericLight('EditorLight', new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  createEditorGround(scene);

  engine.runRenderLoop(() => {
    scene.render();
  });

  return { engine, scene, camera };
}
