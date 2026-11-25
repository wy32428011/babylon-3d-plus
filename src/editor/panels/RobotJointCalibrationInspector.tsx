import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_ROBOT_ARM_NODES,
  type ModelDataDrivenConfig,
  type RobotJointArmCalibration,
  type RobotJointCalibration,
  type RobotSignedJointAxis,
} from '../model/telemetryBinding';
import { robotJointDebugSession } from '../../runtime/robotJointDebugSession';
import { useEditorStore } from '../store/editorStore';

const JOINT_COUNT = 7;
const DEFAULT_AXES = ['Z', 'X', 'Z', 'X', 'Z', 'X', 'Z'];
const SIGNED_AXES: { value: RobotSignedJointAxis; label: string }[] = [
  { value: 'x', label: '+X' },
  { value: '-x', label: '−X' },
  { value: 'y', label: '+Y' },
  { value: '-y', label: '−Y' },
  { value: 'z', label: '+Z' },
  { value: '-z', label: '−Z' },
];
const SIDES = [
  { key: 'L', label: '左臂' },
  { key: 'R', label: '右臂' },
] as const;

type ArmSide = (typeof SIDES)[number]['key'];

type Props = {
  entityId: string;
  calibration: RobotJointCalibration | undefined;
  dataDrivenConfig: ModelDataDrivenConfig | null;
  disabled: boolean;
  onChange: (calibration: RobotJointCalibration | undefined) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toSignedAxis(axis: string, sign: number): RobotSignedJointAxis {
  const normalized = axis.toLowerCase();
  const unsigned = normalized === 'x' || normalized === 'y' ? normalized : 'z';
  return `${sign < 0 ? '-' : ''}${unsigned}` as RobotSignedJointAxis;
}

function readEffectiveAxis(
  calibration: RobotJointArmCalibration | undefined,
  defaults: { axes: string[]; signs: number[] },
  index: number,
): RobotSignedJointAxis {
  return calibration?.axes?.[index]
    ?? toSignedAxis(defaults.axes[index], calibration?.signs?.[index] ?? defaults.signs[index]);
}

export function RobotJointCalibrationInspector(props: Props) {
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const sceneSessionId = useEditorStore(state => state.sceneSessionId);
  const debugSnapshot = useSyncExternalStore(
    robotJointDebugSession.subscribe,
    () => robotJointDebugSession.getSnapshot(props.entityId),
    () => robotJointDebugSession.getSnapshot(props.entityId),
  );
  const motion = props.dataDrivenConfig?.specializedMotion;
  const angleUnit = motion?.angleUnit === 'deg' ? 'deg' : 'rad';
  const arms = isRecord(motion?.arms) ? motion.arms : {};

  useEffect(() => () => robotJointDebugSession.stop(props.entityId), [props.entityId, sceneSessionId, runtimeMode]);

  function readArm(side: ArmSide) {
    const arm = isRecord(arms[side]) ? arms[side] : {};
    const nodes = Array.isArray(arm.nodes) ? arm.nodes : [];
    const axes = Array.isArray(arm.axes) ? arm.axes : [];
    const signs = Array.isArray(arm.signs) ? arm.signs : [];
    const offsets = Array.isArray(arm.offsets) ? arm.offsets : [];
    return {
      nodes: Array.from({ length: JOINT_COUNT }, (_, index) => readString(nodes[index]) ?? DEFAULT_ROBOT_ARM_NODES[side][index]),
      axes: Array.from({ length: JOINT_COUNT }, (_, index) => readString(axes[index])?.toUpperCase() ?? DEFAULT_AXES[index]),
      signs: Array.from({ length: JOINT_COUNT }, (_, index) => readNumber(signs[index], 1) < 0 ? -1 : 1),
      offsetsDeg: Array.from({ length: JOINT_COUNT }, (_, index) => {
        const offset = readNumber(offsets[index], 0);
        return angleUnit === 'deg' ? offset : offset * 180 / Math.PI;
      }),
    };
  }

  function commitJoint(side: ArmSide, index: number, patch: { offsetDeg?: number; axis?: RobotSignedJointAxis }): void {
    const defaults = readArm(side);
    const current = props.calibration?.[side];
    const offsetsDeg = Array.from({ length: JOINT_COUNT }, (_, jointIndex) => (
      current?.offsetsDeg[jointIndex] ?? defaults.offsetsDeg[jointIndex]
    ));
    const axes = Array.from({ length: JOINT_COUNT }, (_, jointIndex) => (
      readEffectiveAxis(current, defaults, jointIndex)
    ));
    if (patch.offsetDeg !== undefined) offsetsDeg[index] = patch.offsetDeg;
    if (patch.axis !== undefined) axes[index] = patch.axis;
    props.onChange({
      ...props.calibration,
      [side]: { offsetsDeg, axes },
    });
  }

  const debugDisabled = props.disabled || runtimeMode !== 'edit';

  return (
    <div className="robot-joint-calibration">
      <div className="model-generator-section-header">
        <strong>机器人关节校准</strong>
        <button
          type="button"
          disabled={props.disabled || !props.calibration}
          onClick={() => props.onChange(undefined)}
        >
          恢复模型默认
        </button>
      </div>
      <p className="muted">模型关节角 =（MQTT 角度 + 零位偏置）× 转向轴方向。单关节调试先移动到包含零位偏置的数据 0 位并停留 1 秒，再执行约 10 秒的 0° → 180° → 0° → −180° → 0°，结束后恢复模型原位。</p>
      {SIDES.map(({ key: side, label }) => {
        const defaults = readArm(side);
        const calibration = props.calibration?.[side];
        return (
          <fieldset className="transform-fieldset robot-arm-calibration" key={side}>
            <legend>{label}（armJoint{side}）</legend>
            {defaults.nodes.map((node, index) => {
              const offsetDeg = calibration?.offsetsDeg[index] ?? defaults.offsetsDeg[index];
              const axis = readEffectiveAxis(calibration, defaults, index);
              const jointDebugging = debugSnapshot.request?.side === side && debugSnapshot.request.jointIndex === index;
              return (
                <div className="model-generator-rule-card" key={`${side}-${index}`}>
                  <div className="model-generator-card-header">
                    <span>关节 {index + 1}</span>
                  </div>
                  <div className="robot-joint-node-row">
                    <span>节点名称</span>
                    <output aria-label={`${label}关节${index + 1}节点名称`} title={node}>{node}</output>
                  </div>
                  <label className="number-row">
                    <span>零位偏置 (deg)</span>
                    <input
                      aria-label={`${label}关节${index + 1}零位偏置`}
                      type="number"
                      step="0.1"
                      disabled={props.disabled}
                      value={Number(offsetDeg.toFixed(6))}
                      onChange={(event) => {
                        if (event.target.value === '') return;
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) commitJoint(side, index, { offsetDeg: value });
                      }}
                    />
                  </label>
                  <label className="inspector-row">
                    <span>转向轴</span>
                    <select
                      aria-label={`${label}关节${index + 1}转向轴`}
                      disabled={props.disabled}
                      value={axis}
                      onChange={(event) => commitJoint(side, index, { axis: event.target.value as RobotSignedJointAxis })}
                    >
                      {SIGNED_AXES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <div className="robot-joint-debug-row">
                    <button
                      type="button"
                      disabled={debugDisabled}
                      aria-pressed={jointDebugging && debugSnapshot.running}
                      onClick={() => {
                        if (jointDebugging && debugSnapshot.running) robotJointDebugSession.stop(props.entityId);
                        else robotJointDebugSession.start(props.entityId, side, index);
                      }}
                    >
                      {jointDebugging && debugSnapshot.running ? '停止调试' : jointDebugging ? '重新调试' : '调试'}
                    </button>
                    <output aria-label={`${label}关节${index + 1}当前调试角度`}>
                      当前角度：{jointDebugging ? `${debugSnapshot.currentAngleDeg.toFixed(1)}°` : '—'}
                    </output>
                  </div>
                  {jointDebugging && debugSnapshot.message ? <p className="muted robot-joint-debug-status" role="status">{debugSnapshot.message}</p> : null}
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
