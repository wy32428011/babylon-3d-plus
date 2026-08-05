import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { type ArcRotateCamera, Vector3 } from '@babylonjs/core';
import {
  STANDARD_SCENE_CAMERA_ORIENTATIONS,
  type SceneCameraOrientation,
  type StandardSceneCameraOrientation,
} from '../model/SceneDocument';
import {
  STANDARD_CAMERA_VIEW_LABELS,
  getShortestCameraAlphaDelta,
  getStandardCameraViewAccessibleLabel,
  resolveCompassAxisOffset,
} from '../model/cameraOrientation';
import '../../styles/viewport-orientation-compass.css';

type ViewportOrientationCompassProps = {
  camera: ArcRotateCamera | null;
  orientation: SceneCameraOrientation;
  disabled?: boolean;
  onReset: () => void;
  onToggleStandardView: (orientation: StandardSceneCameraOrientation) => void;
};

type FaceDefinition = {
  orientation: StandardSceneCameraOrientation;
  normal: Vector3;
  vertices: readonly Vector3[];
};

type AxisDefinition = {
  id: string;
  direction: Vector3;
  orientation: StandardSceneCameraOrientation;
  label: string;
  color: string;
  fallback: readonly [number, number];
};

type FaceElements = {
  group: SVGGElement | null;
  polygon: SVGPolygonElement | null;
  text: SVGTextElement | null;
};

type AxisElements = {
  line: SVGLineElement | null;
  group: SVGGElement | null;
};

const SVG_CENTER_X = 52;
const SVG_CENTER_Y = 38;
const CUBE_HALF_SIZE = 0.72;
const CUBE_SCALE = 30;
const AXIS_RADIUS = 37;
const DEPTH_AXIS_FALLBACK_RADIUS = 24;
const COMPACT_WIDTH_THRESHOLD = 520;
const COMPACT_HEIGHT_THRESHOLD = 360;

function vector(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

const FACE_DEFINITIONS: readonly FaceDefinition[] = [
  {
    orientation: 'top',
    normal: vector(0, 1, 0),
    vertices: [vector(-1, 1, -1), vector(1, 1, -1), vector(1, 1, 1), vector(-1, 1, 1)],
  },
  {
    orientation: 'bottom',
    normal: vector(0, -1, 0),
    vertices: [vector(-1, -1, 1), vector(1, -1, 1), vector(1, -1, -1), vector(-1, -1, -1)],
  },
  {
    orientation: 'front',
    normal: vector(0, 0, -1),
    vertices: [vector(-1, -1, -1), vector(1, -1, -1), vector(1, 1, -1), vector(-1, 1, -1)],
  },
  {
    orientation: 'back',
    normal: vector(0, 0, 1),
    vertices: [vector(1, -1, 1), vector(-1, -1, 1), vector(-1, 1, 1), vector(1, 1, 1)],
  },
  {
    orientation: 'right',
    normal: vector(1, 0, 0),
    vertices: [vector(1, -1, -1), vector(1, -1, 1), vector(1, 1, 1), vector(1, 1, -1)],
  },
  {
    orientation: 'left',
    normal: vector(-1, 0, 0),
    vertices: [vector(-1, -1, 1), vector(-1, -1, -1), vector(-1, 1, -1), vector(-1, 1, 1)],
  },
] as const;

const AXIS_DEFINITIONS: readonly AxisDefinition[] = [
  { id: 'positive-x', direction: vector(1, 0, 0), orientation: 'right', label: 'X', color: '#ff5b62', fallback: [1, 0] },
  { id: 'negative-x', direction: vector(-1, 0, 0), orientation: 'left', label: '−X', color: '#ff5b62', fallback: [1, 0] },
  { id: 'positive-y', direction: vector(0, 1, 0), orientation: 'top', label: 'Y', color: '#55d778', fallback: [0, -1] },
  { id: 'negative-y', direction: vector(0, -1, 0), orientation: 'bottom', label: '−Y', color: '#55d778', fallback: [0, -1] },
  { id: 'positive-z', direction: vector(0, 0, 1), orientation: 'back', label: 'Z', color: '#55a7ff', fallback: [0.72, 0.7] },
  { id: 'negative-z', direction: vector(0, 0, -1), orientation: 'front', label: '−Z', color: '#55a7ff', fallback: [0.72, 0.7] },
] as const;

function createFaceElementMap(): Record<StandardSceneCameraOrientation, FaceElements> {
  return Object.fromEntries(
    STANDARD_SCENE_CAMERA_ORIENTATIONS.map((orientation) => [orientation, { group: null, polygon: null, text: null }]),
  ) as Record<StandardSceneCameraOrientation, FaceElements>;
}

function createAxisElementMap(): Record<string, AxisElements> {
  return Object.fromEntries(AXIS_DEFINITIONS.map((axis) => [axis.id, { line: null, group: null }]));
}

function handleKeyboardActivation(
  event: ReactKeyboardEvent<SVGGElement>,
  disabled: boolean,
  action: () => void,
): void {
  if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  action();
}

/** Scene View 右上角世界坐标 ViewCube；逐帧只改 SVG 属性，不把相机角度写入 React/Store。 */
export function ViewportOrientationCompass(props: ViewportOrientationCompassProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const faceElementsRef = useRef(createFaceElementMap());
  const axisElementsRef = useRef(createAxisElementMap());
  const [compact, setCompact] = useState(false);
  const disabled = props.disabled === true || !props.camera;

  useEffect(() => {
    const root = rootRef.current;
    const viewport = root?.parentElement;
    if (!viewport || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextCompact = entry.contentRect.width < COMPACT_WIDTH_THRESHOLD
        || entry.contentRect.height < COMPACT_HEIGHT_THRESHOLD;
      setCompact((current) => current === nextCompact ? current : nextCompact);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const camera = props.camera;
    if (!camera || props.disabled) return;

    const transformed = new Vector3();
    const projectedVertices = FACE_DEFINITIONS.map((face) => face.vertices.map(() => new Vector3()));
    let lastAlpha = Number.NaN;
    let lastBeta = Number.NaN;

    const update = (): void => {
      if (Number.isFinite(lastAlpha)
        && Math.abs(getShortestCameraAlphaDelta(lastAlpha, camera.alpha)) < 1e-5
        && Math.abs(lastBeta - camera.beta) < 1e-5) {
        return;
      }
      lastAlpha = camera.alpha;
      lastBeta = camera.beta;
      const viewMatrix = camera.getViewMatrix(true);

      FACE_DEFINITIONS.forEach((face, faceIndex) => {
        const elements = faceElementsRef.current[face.orientation];
        if (!elements.group || !elements.polygon || !elements.text) return;

        Vector3.TransformNormalToRef(face.normal, viewMatrix, transformed);
        const visible = transformed.z < -0.015;
        const faceStrength = Math.min(1, Math.max(0, -transformed.z));
        elements.group.style.display = visible ? '' : 'none';
        if (!visible) return;

        const points: string[] = [];
        let centerX = 0;
        let centerY = 0;
        face.vertices.forEach((vertex, vertexIndex) => {
          const scaledVertex = projectedVertices[faceIndex][vertexIndex];
          scaledVertex.copyFrom(vertex).scaleInPlace(CUBE_HALF_SIZE);
          Vector3.TransformNormalToRef(scaledVertex, viewMatrix, transformed);
          const x = SVG_CENTER_X + transformed.x * CUBE_SCALE;
          const y = SVG_CENTER_Y - transformed.y * CUBE_SCALE;
          centerX += x;
          centerY += y;
          points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        });

        elements.polygon.setAttribute('points', points.join(' '));
        elements.polygon.style.setProperty('--face-light', faceStrength.toFixed(3));
        elements.text.setAttribute('x', (centerX / face.vertices.length).toFixed(2));
        elements.text.setAttribute('y', (centerY / face.vertices.length + 3.5).toFixed(2));
        elements.text.style.display = faceStrength >= 0.32 ? '' : 'none';
      });

      AXIS_DEFINITIONS.forEach((axis) => {
        const elements = axisElementsRef.current[axis.id];
        if (!elements?.line || !elements.group) return;

        Vector3.TransformNormalToRef(axis.direction, viewMatrix, transformed);
        const offset = resolveCompassAxisOffset(
          transformed.x,
          -transformed.y,
          transformed.z,
          axis.fallback,
          AXIS_RADIUS,
          DEPTH_AXIS_FALLBACK_RADIUS,
        );
        const offsetX = offset.x;
        const offsetY = offset.y;

        const x = SVG_CENTER_X + offsetX;
        const y = SVG_CENTER_Y + offsetY;
        const frontFacing = transformed.z < 0;
        elements.line.setAttribute('x2', x.toFixed(2));
        elements.line.setAttribute('y2', y.toFixed(2));
        elements.line.classList.toggle('rear', !frontFacing);
        elements.group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        elements.group.classList.toggle('rear', !frontFacing);
      });
    };

    update();
    const scene = camera.getScene();
    const observer = scene.onAfterRenderObservable.add(update);
    return () => { scene.onAfterRenderObservable.remove(observer); };
  }, [props.camera, props.disabled]);

  const rootClassName = [
    'viewport-orientation-compass',
    compact ? 'compact' : '',
    disabled ? 'disabled' : '',
  ].filter(Boolean).join(' ');
  const activeLabel = props.orientation === 'orbit' ? null : STANDARD_CAMERA_VIEW_LABELS[props.orientation];

  return (
    <div aria-label="视口定向罗盘" className={rootClassName} ref={rootRef}>
      {activeLabel ? (
        <span aria-live="polite" className="viewport-orientation-lock-status" role="status">
          锁 · {activeLabel.face}
        </span>
      ) : null}
      <svg className="viewport-orientation-svg" viewBox="0 0 104 82">
        <g className="viewport-orientation-axis-lines" aria-hidden="true">
          {AXIS_DEFINITIONS.map((axis) => (
            <line
              key={axis.id}
              ref={(element) => { axisElementsRef.current[axis.id].line = element; }}
              className="viewport-orientation-axis-line"
              style={{ '--axis-color': axis.color } as CSSProperties}
              x1={SVG_CENTER_X}
              x2={SVG_CENTER_X}
              y1={SVG_CENTER_Y}
              y2={SVG_CENTER_Y}
            />
          ))}
        </g>
        <g className="viewport-orientation-cube" aria-hidden="true">
          {FACE_DEFINITIONS.map((face) => {
            const label = STANDARD_CAMERA_VIEW_LABELS[face.orientation];
            const active = props.orientation === face.orientation;
            return (
              <g
                key={face.orientation}
                ref={(element) => { faceElementsRef.current[face.orientation].group = element; }}
                className={active ? 'viewport-orientation-face active' : 'viewport-orientation-face'}
                onClick={() => { if (!disabled) props.onToggleStandardView(face.orientation); }}
              >
                <title>{getStandardCameraViewAccessibleLabel(face.orientation)}</title>
                <polygon ref={(element) => { faceElementsRef.current[face.orientation].polygon = element; }} />
                <text ref={(element) => { faceElementsRef.current[face.orientation].text = element; }}>{label.face}</text>
              </g>
            );
          })}
        </g>
        <g className="viewport-orientation-axis-actions">
          {AXIS_DEFINITIONS.map((axis) => {
            const accessibleLabel = getStandardCameraViewAccessibleLabel(axis.orientation);
            const active = props.orientation === axis.orientation;
            return (
              <g
                key={axis.id}
                ref={(element) => { axisElementsRef.current[axis.id].group = element; }}
                aria-disabled={disabled}
                aria-label={accessibleLabel}
                aria-pressed={active}
                className={active ? 'viewport-orientation-axis-action active' : 'viewport-orientation-axis-action'}
                onClick={() => { if (!disabled) props.onToggleStandardView(axis.orientation); }}
                onKeyDown={(event) => handleKeyboardActivation(
                  event,
                  disabled,
                  () => props.onToggleStandardView(axis.orientation),
                )}
                role="button"
                style={{ '--axis-color': axis.color } as CSSProperties}
                tabIndex={disabled ? -1 : 0}
              >
                <title>{accessibleLabel}</title>
                <circle className="viewport-orientation-axis-hit" r="12" />
                <circle className="viewport-orientation-axis-dot" r="5.5" />
                <text className="viewport-orientation-axis-label" x="0" y="3.5">{axis.label}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <button
        aria-label="Reset / 复位到已保存视角"
        className="viewport-orientation-home"
        disabled={disabled}
        onClick={props.onReset}
        title="Reset / 复位到已保存视角"
        type="button"
      >
        <span aria-hidden="true">⌂</span>
      </button>
    </div>
  );
}
