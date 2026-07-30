import {
  type AbstractEngine,
  ArcRotateCamera,
  Camera,
  Color3,
  Engine,
  MeshBuilder,
  type Observer,
  Scene,
  ShaderMaterial,
  Vector2,
} from '@babylonjs/core';
import { SCENE_LENGTH_UNIT_SYMBOL } from '../../editor/model/sceneUnits';

export type EditorGridCellSize = 1 | 2 | 5 | 10;

export type EditorGridSettings = {
  visible: boolean;
  cellSizeMeters: EditorGridCellSize;
};

export const EDITOR_GRID_CELL_SIZES: readonly EditorGridCellSize[] = [1, 2, 5, 10];
export const DEFAULT_EDITOR_GRID_SETTINGS: EditorGridSettings = {
  visible: true,
  cellSizeMeters: 5,
};

export type EditorGroundGridController = {
  setSettings: (settings: EditorGridSettings) => void;
  dispose: () => void;
};

type EditorGroundGridState = {
  anchorX: number;
  anchorZ: number;
  coverageRadiusMeters: number;
};

const GRID_ANCHOR_CELL_MULTIPLIER = 10;
const GRID_COARSE_CELL_MULTIPLIER = 100;
const GRID_MIN_COVERAGE_RADIUS_METERS = 100;
const GRID_COVERAGE_VIEW_DISTANCE_RATIO = 0.9;
const GRID_COVERAGE_MARGIN = 1.15;
const GRID_MIN_GROUND_VIEW_DOT = 0.12;
const GRID_FADE_START_RATIO = 0.72;
const GRID_FADE_END_RATIO = 0.92;
const GRID_DEPTH_OFFSET = -1;
const GRID_ALPHA_INDEX = -1_000;
const GRID_MIN_ALPHA = 0.001;

const GRID_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;

uniform mat4 worldViewProjection;
uniform vec2 gridOriginModulo;
uniform float gridRadiusMeters;

const float GRID_FAR_CLIP_NDC = 0.999999;

varying vec2 vGridPosition;
varying vec2 vLocalMeters;

void main(void) {
  vec2 localMeters = position.xz * gridRadiusMeters;
  vLocalMeters = localMeters;
  vGridPosition = localMeters + gridOriginModulo;
  vec4 clipPosition = worldViewProjection * vec4(position, 1.0);
  if (clipPosition.w > 0.0) {
    clipPosition.z = min(clipPosition.z, clipPosition.w * GRID_FAR_CLIP_NDC);
  }
  gl_Position = clipPosition;
}
`;

const GRID_FRAGMENT_SHADER = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

varying vec2 vGridPosition;
varying vec2 vLocalMeters;

uniform float baseCellSizeMeters;
uniform float fadeStartSquared;
uniform float fadeEndSquared;
uniform vec3 minorLineColor;
uniform vec3 majorLineColor;
uniform vec3 coarseLineColor;
uniform float minorLineAlpha;
uniform float majorLineAlpha;
uniform float coarseLineAlpha;

float getGridLine(vec2 gridPosition, vec2 derivative, float lineWidthPixels) {
  vec2 distanceToCell = abs(fract(gridPosition - 0.5) - 0.5) / derivative;
  float distanceToLine = min(distanceToCell.x, distanceToCell.y);
  return 1.0 - smoothstep(lineWidthPixels, lineWidthPixels + 1.0, distanceToLine);
}

float getCellVisibility(vec2 derivative, float fadeInPixels, float fullPixels) {
  float pixelsPerCell = 1.0 / max(max(derivative.x, derivative.y), 0.00001);
  return smoothstep(fadeInPixels, fullPixels, pixelsPerCell);
}

void main(void) {
  float majorCellSizeMeters = baseCellSizeMeters * 10.0;
  float coarseCellSizeMeters = baseCellSizeMeters * 100.0;

  vec2 minorGridPosition = vGridPosition / max(baseCellSizeMeters, 0.0001);
  vec2 majorGridPosition = vGridPosition / max(majorCellSizeMeters, 0.0001);
  vec2 coarseGridPosition = vGridPosition / max(coarseCellSizeMeters, 0.0001);
  vec2 minorDerivative = max(fwidth(minorGridPosition), vec2(0.00001));
  vec2 majorDerivative = max(fwidth(majorGridPosition), vec2(0.00001));
  vec2 coarseDerivative = max(fwidth(coarseGridPosition), vec2(0.00001));

  float minorVisibility = getCellVisibility(minorDerivative, 1.5, 3.5);
  float majorVisibility = getCellVisibility(majorDerivative, 1.25, 3.0);
  float coarseVisibility = getCellVisibility(coarseDerivative, 0.75, 2.0);

  float distanceSquared = dot(vLocalMeters, vLocalMeters);
  float normalizedDistanceSquared = distanceSquared / max(fadeEndSquared, 0.0001);
  float minorDistanceFade = 1.0 - smoothstep(0.09, 0.3844, normalizedDistanceSquared);
  float majorDistanceFade = 1.0 - smoothstep(0.2704, 0.6724, normalizedDistanceSquared);
  float outerFade = 1.0 - smoothstep(fadeStartSquared, fadeEndSquared, distanceSquared);

  float minorCoverage = getGridLine(minorGridPosition, minorDerivative, 0.55)
    * minorVisibility
    * minorDistanceFade;
  float majorCoverage = getGridLine(majorGridPosition, majorDerivative, 0.78)
    * majorVisibility
    * majorDistanceFade;
  float coarseCoverage = getGridLine(coarseGridPosition, coarseDerivative, 1.0)
    * coarseVisibility;

  float minorContribution = minorCoverage * minorLineAlpha;
  float majorContribution = majorCoverage * majorLineAlpha;
  float coarseContribution = coarseCoverage * coarseLineAlpha;
  float lineAlpha = max(max(minorContribution, majorContribution), coarseContribution) * outerFade;

  if (lineAlpha <= ${GRID_MIN_ALPHA.toFixed(3)}) {
    discard;
  }

  vec3 lineColor = minorLineColor;
  if (majorContribution >= minorContribution) {
    lineColor = majorLineColor;
  }
  if (coarseContribution >= max(minorContribution, majorContribution)) {
    lineColor = coarseLineColor;
  }

  gl_FragColor = vec4(lineColor, lineAlpha);
}
`;

/** 将网格中心吸附到十个基础格的整数倍，减少相机移动时的 Mesh/Uniform 更新。 */
export function calculateEditorGridAnchorCoordinate(
  worldCoordinate: number,
  cellSizeMeters: EditorGridCellSize,
): number {
  if (!Number.isFinite(worldCoordinate)) return 0;
  const anchorStepMeters = cellSizeMeters * GRID_ANCHOR_CELL_MULTIPLIER;
  const snapped = Math.round(worldCoordinate / anchorStepMeters) * anchorStepMeters;
  return Object.is(snapped, -0) ? 0 : snapped;
}

/** 将世界原点压缩到粗网格周期内，保持负坐标对齐并降低 Shader 浮点精度压力。 */
export function calculateEditorGridOriginModulo(worldCoordinate: number, periodMeters: number): number {
  if (!Number.isFinite(worldCoordinate) || !Number.isFinite(periodMeters) || periodMeters <= 0) return 0;
  const modulo = ((worldCoordinate % periodMeters) + periodMeters) % periodMeters;
  return Object.is(modulo, -0) ? 0 : modulo;
}

/** 按基础格和视图规模向上量化覆盖半径，避免滚轮细小变化持续改写网格资源。 */
function quantizeCoverageRadius(radiusMeters: number, cellSizeMeters: EditorGridCellSize): number {
  const anchorStepMeters = cellSizeMeters * GRID_ANCHOR_CELL_MULTIPLIER;
  const quantumMeters = Math.max(25, anchorStepMeters);
  return Math.ceil(radiusMeters / quantumMeters) * quantumMeters;
}

/** 根据当前相机投影估算地面有效工作区，有限覆盖后由 Shader 在边缘渐隐。 */
function calculateCoverageRadius(
  camera: ArcRotateCamera,
  engine: Engine,
  cellSizeMeters: EditorGridCellSize,
): number {
  const renderWidth = Math.max(1, engine.getRenderWidth());
  const renderHeight = Math.max(1, engine.getRenderHeight());
  const aspectRatio = renderWidth / renderHeight;
  const cameraRadius = Math.max(0.001, Math.abs(camera.radius));
  const verticalDistance = Math.abs(camera.position.y - camera.target.y);
  const groundViewDot = Math.max(GRID_MIN_GROUND_VIEW_DOT, Math.min(1, verticalDistance / cameraRadius));

  let projectedGroundRadius: number;
  if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
    const fallbackHalfHeight = Math.tan(camera.fov / 2) * cameraRadius;
    const halfHeight = Math.max(
      Math.abs(camera.orthoTop ?? fallbackHalfHeight),
      Math.abs(camera.orthoBottom ?? -fallbackHalfHeight),
    );
    const fallbackHalfWidth = fallbackHalfHeight * aspectRatio;
    const halfWidth = Math.max(
      Math.abs(camera.orthoRight ?? fallbackHalfWidth),
      Math.abs(camera.orthoLeft ?? -fallbackHalfWidth),
    );
    projectedGroundRadius = Math.hypot(halfWidth, halfHeight) / groundViewDot;
  } else {
    const configuredHalfFov = Math.max(0.01, Math.min(Math.PI / 2 - 0.001, camera.fov / 2));
    const verticalHalfSpan = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
      ? Math.tan(configuredHalfFov) * cameraRadius / aspectRatio
      : Math.tan(configuredHalfFov) * cameraRadius;
    const horizontalHalfSpan = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
      ? Math.tan(configuredHalfFov) * cameraRadius
      : verticalHalfSpan * aspectRatio;
    const cameraGroundOffset = Math.hypot(
      camera.position.x - camera.target.x,
      camera.position.z - camera.target.z,
    );
    projectedGroundRadius = cameraGroundOffset
      + Math.hypot(horizontalHalfSpan, verticalHalfSpan) / groundViewDot;
  }

  const minimumCoverageRadius = Math.max(
    GRID_MIN_COVERAGE_RADIUS_METERS,
    cellSizeMeters * GRID_ANCHOR_CELL_MULTIPLIER * 2,
  );
  const finiteViewDistance = Number.isFinite(camera.maxZ) && camera.maxZ > 0
    ? camera.maxZ
    : minimumCoverageRadius / GRID_COVERAGE_VIEW_DISTANCE_RATIO;
  const maximumCoverageRadius = Math.max(
    minimumCoverageRadius,
    finiteViewDistance * GRID_COVERAGE_VIEW_DISTANCE_RATIO,
  );
  const desiredCoverageRadius = Math.min(
    maximumCoverageRadius,
    Math.max(minimumCoverageRadius, projectedGroundRadius * GRID_COVERAGE_MARGIN),
  );

  return quantizeCoverageRadius(desiredCoverageRadius, cellSizeMeters);
}

/** 创建单 Mesh、单 Shader 的相机局部编辑器网格；网格仍按世界米制坐标稳定对齐。 */
export function createEditorGroundGrid(
  scene: Scene,
  camera: ArcRotateCamera,
  engine: Engine,
  initialSettings: EditorGridSettings,
): EditorGroundGridController {
  let settings = { ...initialSettings };
  let disposed = false;
  let dirty = true;
  let synchronizing = false;
  let state: EditorGroundGridState | null = null;

  const gridMesh = MeshBuilder.CreateGround(
    'EditorGroundGrid',
    { width: 2, height: 2, subdivisions: 1 },
    scene,
  );
  gridMesh.isPickable = false;
  gridMesh.alwaysSelectAsActiveMesh = false;
  gridMesh.alphaIndex = GRID_ALPHA_INDEX;

  const gridMaterial = new ShaderMaterial(
    'EditorGroundGridMaterial',
    scene,
    {
      vertexSource: GRID_VERTEX_SHADER,
      fragmentSource: GRID_FRAGMENT_SHADER,
    },
    {
      attributes: ['position'],
      uniforms: [
        'worldViewProjection',
        'gridOriginModulo',
        'gridRadiusMeters',
        'baseCellSizeMeters',
        'fadeStartSquared',
        'fadeEndSquared',
        'minorLineColor',
        'majorLineColor',
        'coarseLineColor',
        'minorLineAlpha',
        'majorLineAlpha',
        'coarseLineAlpha',
      ],
      needAlphaBlending: true,
    },
  );
  gridMaterial.backFaceCulling = false;
  gridMaterial.disableDepthWrite = true;
  gridMaterial.zOffset = GRID_DEPTH_OFFSET;
  gridMaterial.setColor3('minorLineColor', Color3.FromHexString('#4fa8ff'));
  gridMaterial.setColor3('majorLineColor', Color3.FromHexString('#67bdff'));
  gridMaterial.setColor3('coarseLineColor', Color3.FromHexString('#8bd8ff'));
  gridMaterial.setFloat('minorLineAlpha', 0.13);
  gridMaterial.setFloat('majorLineAlpha', 0.22);
  gridMaterial.setFloat('coarseLineAlpha', 0.30);
  gridMesh.material = gridMaterial;

  function updateMetadata(syncCount: number, nextState: EditorGroundGridState): void {
    gridMesh.metadata = {
      editorGroundGrid: true,
      cellSizeLabel: `${settings.cellSizeMeters} ${SCENE_LENGTH_UNIT_SYMBOL}`,
      anchorX: nextState.anchorX,
      anchorZ: nextState.anchorZ,
      coverageRadiusMeters: nextState.coverageRadiusMeters,
      syncCount,
    };
  }

  function updateStaticMaterialSettings(): void {
    gridMaterial.setFloat('baseCellSizeMeters', settings.cellSizeMeters);
    scene.resetCachedMaterial();
  }

  function applyState(nextState: EditorGroundGridState): void {
    const anchorChanged = !state
      || state.anchorX !== nextState.anchorX
      || state.anchorZ !== nextState.anchorZ;
    const coverageChanged = !state || state.coverageRadiusMeters !== nextState.coverageRadiusMeters;
    if (!anchorChanged && !coverageChanged) return;

    if (anchorChanged) {
      gridMesh.position.x = nextState.anchorX;
      gridMesh.position.z = nextState.anchorZ;
    }
    if (coverageChanged) {
      gridMesh.scaling.x = nextState.coverageRadiusMeters;
      gridMesh.scaling.z = nextState.coverageRadiusMeters;
    }

    if (anchorChanged) {
      const coarseCellSizeMeters = settings.cellSizeMeters * GRID_COARSE_CELL_MULTIPLIER;
      gridMaterial.setVector2(
        'gridOriginModulo',
        new Vector2(
          calculateEditorGridOriginModulo(nextState.anchorX, coarseCellSizeMeters),
          calculateEditorGridOriginModulo(nextState.anchorZ, coarseCellSizeMeters),
        ),
      );
    }
    if (coverageChanged) {
      const fadeStartMeters = nextState.coverageRadiusMeters * GRID_FADE_START_RATIO;
      const fadeEndMeters = nextState.coverageRadiusMeters * GRID_FADE_END_RATIO;
      gridMaterial.setFloat('gridRadiusMeters', nextState.coverageRadiusMeters);
      gridMaterial.setFloat('fadeStartSquared', fadeStartMeters * fadeStartMeters);
      gridMaterial.setFloat('fadeEndSquared', fadeEndMeters * fadeEndMeters);
    }
    scene.resetCachedMaterial();

    const syncCount = Number(gridMesh.metadata?.syncCount ?? 0) + 1;
    state = nextState;
    updateMetadata(syncCount, nextState);
  }

  function synchronize(): void {
    if (disposed || synchronizing || !dirty || !settings.visible) return;
    dirty = false;
    synchronizing = true;
    try {
      const nextState: EditorGroundGridState = {
        anchorX: calculateEditorGridAnchorCoordinate(camera.target.x, settings.cellSizeMeters),
        anchorZ: calculateEditorGridAnchorCoordinate(camera.target.z, settings.cellSizeMeters),
        coverageRadiusMeters: calculateCoverageRadius(camera, engine, settings.cellSizeMeters),
      };
      applyState(nextState);
    } finally {
      synchronizing = false;
    }
  }

  function markDirty(): void {
    if (!disposed && !synchronizing) dirty = true;
  }

  updateStaticMaterialSettings();
  gridMesh.setEnabled(settings.visible);
  synchronize();
  gridMaterial.freeze();

  const cameraViewObserver: Observer<Camera> = camera.onViewMatrixChangedObservable.add(markDirty);
  const cameraProjectionObserver: Observer<Camera> = camera.onProjectionMatrixChangedObservable.add(markDirty);
  const engineResizeObserver: Observer<AbstractEngine> = engine.onResizeObservable.add(markDirty);
  const beforeRenderObserver: Observer<Scene> = scene.onBeforeRenderObservable.add(synchronize);

  return {
    setSettings(nextSettings): void {
      if (disposed) return;
      const cellSizeChanged = settings.cellSizeMeters !== nextSettings.cellSizeMeters;
      const visibilityChanged = settings.visible !== nextSettings.visible;
      settings = { ...nextSettings };

      if (cellSizeChanged) {
        state = null;
        dirty = true;
        updateStaticMaterialSettings();
      }
      if (visibilityChanged) {
        gridMesh.setEnabled(settings.visible);
      }
      if (settings.visible) {
        dirty = true;
        synchronize();
      } else if (state) {
        updateMetadata(Number(gridMesh.metadata?.syncCount ?? 0), state);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      camera.onViewMatrixChangedObservable.remove(cameraViewObserver);
      camera.onProjectionMatrixChangedObservable.remove(cameraProjectionObserver);
      engine.onResizeObservable.remove(engineResizeObserver);
      scene.onBeforeRenderObservable.remove(beforeRenderObserver);
      gridMesh.dispose(false, false);
      gridMaterial.dispose();
      state = null;
    },
  };
}
