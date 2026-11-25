import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { robotJointDebugSession } from '../../../robotJointDebugSession';
import { isRobotRuntimeModel } from './specializedModelAssets';
import { RobotTelemetryDriver, type RobotArmSide } from './robotDriver';

export const ROBOT_JOINT_DEBUG_SEGMENT_SECONDS = 1.5;
const DEBUG_TARGETS = [0, Math.PI, 0, -Math.PI, 0];

export function sampleRobotJointDebugAngle(elapsedSeconds: number): { angle: number; done: boolean } {
  const elapsed = Math.max(0, elapsedSeconds);
  const segmentIndex = Math.floor(elapsed / ROBOT_JOINT_DEBUG_SEGMENT_SECONDS);
  if (segmentIndex >= DEBUG_TARGETS.length - 1) return { angle: 0, done: true };
  const progress = (elapsed - segmentIndex * ROBOT_JOINT_DEBUG_SEGMENT_SECONDS) / ROBOT_JOINT_DEBUG_SEGMENT_SECONDS;
  const eased = progress * progress * (3 - 2 * progress);
  return {
    angle: DEBUG_TARGETS[segmentIndex] + (DEBUG_TARGETS[segmentIndex + 1] - DEBUG_TARGETS[segmentIndex]) * eased,
    done: false,
  };
}

type DebugModelEntry = { entityId: string; model: ModelRuntimeEntry };

type ActiveDebug = {
  requestId: number;
  entityId: string;
  model: ModelRuntimeEntry;
  side: RobotArmSide;
  jointIndex: number;
  elapsedSeconds: number;
};

export class RobotJointDebugSystem {
  private readonly driver = new RobotTelemetryDriver();
  private active: ActiveDebug | null = null;

  get hasActive(): boolean {
    return this.active !== null;
  }

  tick(models: Iterable<DebugModelEntry>, running: boolean, deltaSeconds: number): void {
    const snapshot = robotJointDebugSession.getActive();
    const request = snapshot?.request;
    if (running || !request) {
      this.clearActive();
      if (running) robotJointDebugSession.clear();
      return;
    }

    const entry = [...models].find(candidate => candidate.entityId === request.entityId
      && candidate.model.assetHandle
      && candidate.model.stackerTelemetryReady
      && !candidate.model.root.isDisposed()
      && isRobotRuntimeModel(candidate.model));
    if (!entry) {
      if (this.active?.requestId === request.id) this.clearActive();
      robotJointDebugSession.update(request.id, 0, '等待机器人模型准备完成');
      return;
    }

    if (this.active?.requestId !== request.id || this.active.model !== entry.model) {
      this.clearActive();
      this.active = {
        requestId: request.id,
        entityId: request.entityId,
        model: entry.model,
        side: request.side,
        jointIndex: request.jointIndex,
        elapsedSeconds: 0,
      };
    }

    const active = this.active;
    active.elapsedSeconds += Math.min(0.25, Math.max(0, deltaSeconds));
    const sample = sampleRobotJointDebugAngle(active.elapsedSeconds);
    if (!this.driver.applyDebugToModel(active.model, active.side, active.jointIndex, sample.angle)) {
      robotJointDebugSession.update(request.id, 0, '未找到对应关节节点');
      return;
    }
    robotJointDebugSession.update(request.id, sample.angle * 180 / Math.PI, '正在调试');
    if (sample.done) {
      this.clearActive();
      robotJointDebugSession.finish(request.id);
    }
  }

  clearActive(): void {
    const active = this.active;
    if (active) this.driver.restoreDebugJoint(active.model, active.side, active.jointIndex);
    this.active = null;
    this.driver.resetMotionStates();
  }

  clear(): void {
    this.clearActive();
    robotJointDebugSession.clear();
  }

  dispose(): void {
    this.clear();
  }
}
