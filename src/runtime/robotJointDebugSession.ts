export type RobotJointDebugRequest = {
  id: number;
  entityId: string;
  side: 'L' | 'R';
  jointIndex: number;
};

export type RobotJointDebugSnapshot = {
  request: RobotJointDebugRequest | null;
  currentAngleDeg: number;
  running: boolean;
  message: string;
};

const IDLE_SNAPSHOT: RobotJointDebugSnapshot = {
  request: null,
  currentAngleDeg: 0,
  running: false,
  message: '',
};

let currentSnapshot = IDLE_SNAPSHOT;
let nextRequestId = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const robotJointDebugSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(entityId: string): RobotJointDebugSnapshot {
    return currentSnapshot.request?.entityId === entityId ? currentSnapshot : IDLE_SNAPSHOT;
  },
  getActive(): RobotJointDebugSnapshot | null {
    return currentSnapshot.running ? currentSnapshot : null;
  },
  hasActive(): boolean {
    return currentSnapshot.running;
  },
  start(entityId: string, side: 'L' | 'R', jointIndex: number): void {
    nextRequestId += 1;
    currentSnapshot = {
      request: { id: nextRequestId, entityId, side, jointIndex },
      currentAngleDeg: 0,
      running: true,
      message: '等待机器人模型',
    };
    notify();
  },
  update(requestId: number, currentAngleDeg: number, message: string): void {
    if (currentSnapshot.request?.id !== requestId || !currentSnapshot.running) return;
    const roundedAngle = Math.round(currentAngleDeg * 10) / 10;
    if (currentSnapshot.currentAngleDeg === roundedAngle && currentSnapshot.message === message) return;
    currentSnapshot = { ...currentSnapshot, currentAngleDeg: roundedAngle, message };
    notify();
  },
  finish(requestId: number): void {
    if (currentSnapshot.request?.id !== requestId || !currentSnapshot.running) return;
    currentSnapshot = { ...currentSnapshot, currentAngleDeg: 0, running: false, message: '调试完成，已恢复原姿态' };
    notify();
  },
  stop(entityId?: string): void {
    if (entityId !== undefined && currentSnapshot.request?.entityId !== entityId) return;
    if (currentSnapshot === IDLE_SNAPSHOT) return;
    currentSnapshot = IDLE_SNAPSHOT;
    notify();
  },
  clear(): void {
    this.stop();
  },
};
