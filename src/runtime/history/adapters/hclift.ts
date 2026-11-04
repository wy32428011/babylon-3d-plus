import { readIntegerField } from '../../mqtt/deviceTelemetry';
import type { ActorOf, DriverFrame, LogisticsContext } from './context';
import type { ShuttleSpec } from './manifest';
import { clamp, moveNumber, V } from './math';

/** hclift 只托举 shuttle，不生成或交接货箱；本阶段先于 shuttle 发布数值台面。 */
export function stepHclift(ctx: LogisticsContext, actor: ActorOf<'hclift'>, frame: DriverFrame): void {
  const state = actor.state, spec = actor.spec;
  state.workState = readIntegerField(frame.fields, 'work_state');
  const frozen = frame.faulted || state.workState === 10;
  const locator = ctx.platform(frame.assetCode, spec.aisleCode);
  if (!locator) ctx.issue(actor, 'hclift-platform-unbound');
  if (locator) {
    const current = readIntegerField(frame.fields, 'lift_current_level'), target = readIntegerField(frame.fields, 'task_target_level');
    const offsetFor = (level: number): number | null => {
      const cell = ctx.cell(locator, locator.startColumn, level);
      if (!cell) { ctx.issue(actor, 'hclift-level-out-of-range:' + level); return null; }
      return clamp(V.dot(cell.position, spec.upAxis) - spec.deckTopBase, spec.liftLimits.min, spec.liftLimits.max);
    };
    const initialLevel = !state.hasInitialLevel && current !== null && current >= 1 ? current : null;
    const initialOffset = initialLevel === null ? null : offsetFor(initialLevel);
    const levelAfterSnap = initialLevel !== null && initialOffset !== null ? initialLevel : state.targetLevel;
    const nextLevel = !frozen && target !== null && target >= 1 && target !== levelAfterSnap ? target : null;
    const nextOffset = nextLevel === null ? null : offsetFor(nextLevel);
    if (initialLevel !== null && initialOffset !== null) {
      state.liftOffset = initialOffset; state.liftTargetOffset = initialOffset; state.targetLevel = initialLevel; state.hasInitialLevel = true;
    }
    if (nextLevel !== null && nextOffset !== null) { state.targetLevel = nextLevel; state.liftTargetOffset = nextOffset; }
    const occupancy = state.occupancy, freshOccupancy = occupancy !== null && ctx.now - occupancy.updatedAt <= 2000;
    let allowed = false;
    if (!frozen) {
      if (state.workState !== null) allowed = state.workState === 5 && (!freshOccupancy || !occupancy!.shuttleFaulted && occupancy!.shuttleStatus !== 10);
      else {
        const associated = ctx.ids('shuttle').some(id => {
          const candidate = ctx.spec(ctx.tx.get('devices', id)!) as ShuttleSpec;
          return !spec.aisleCode || !candidate.aisleCode || candidate.aisleCode === spec.aisleCode;
        });
        allowed = !associated || freshOccupancy && occupancy!.phase === 'loaded' && !occupancy!.shuttleFaulted && occupancy!.shuttleStatus !== 10;
      }
    }
    if (allowed && state.liftTargetOffset !== null) state.liftOffset = moveNumber(state.liftOffset, state.liftTargetOffset, spec.liftSpeed * ctx.dt);
    state.liftOffset = clamp(state.liftOffset, spec.liftLimits.min, spec.liftLimits.max);
  }
  ctx.publishMotion(actor, { lift: V.scale(spec.upAxis, state.liftOffset) });
  state.surface = { supportY: spec.deckTopBase + state.liftOffset, deckCenter: V.add(spec.deckCenterBase, V.scale(spec.upAxis, state.liftOffset)),
    targetLevel: state.targetLevel, arrived: state.liftTargetOffset !== null && Math.abs(state.liftOffset - state.liftTargetOffset) <= 1e-3,
    workState: state.workState, updatedAt: ctx.now };
}
