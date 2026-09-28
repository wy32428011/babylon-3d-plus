import type { OpeningTerminal } from '../../shared/opening/OpeningPlaybackCoordinator';

type AlarmFocus = { managerId: string; targetId: string };

/** 开场不阻塞告警本身，只延后相机聚焦；用户接管时丢弃旧告警，避免覆盖新视角。 */
export class PendingOpeningAlarmFocus {
  private waiting = false;
  private latest: AlarmFocus | null = null;

  reset(waiting: boolean): void { this.waiting = waiting; this.latest = null; }
  begin(): void { this.waiting = true; }
  defer(event: AlarmFocus): boolean {
    if (!this.waiting) return false;
    this.latest = { managerId: event.managerId, targetId: event.targetId };
    return true;
  }
  finish(result: OpeningTerminal, isActive: (event: AlarmFocus) => boolean): AlarmFocus | null {
    const pending = this.latest;
    this.reset(false);
    return result !== 'cancelled' && pending && isActive(pending) ? pending : null;
  }
}
