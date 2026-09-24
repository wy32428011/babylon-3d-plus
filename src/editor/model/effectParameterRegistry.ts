import type { EffectParameterDefinition } from './effectConfiguration';
import { getSpatialEffectParameters } from './spatialEffectParameters';
import { getLegacyEffectParameters } from './legacyEffectParameters';
import { getModelEffectParameters } from './modelEffectParameters';
import { getEnvironmentEffectParameters } from './environmentEffectParameters';
import { getAlarmEffectParameters } from './alarmEffectParameters';

export function getEffectParameterDefinitions(kind: string): readonly EffectParameterDefinition[] {
  return [...getSpatialEffectParameters(kind), ...getLegacyEffectParameters(kind), ...getModelEffectParameters(kind), ...getEnvironmentEffectParameters(kind), ...getAlarmEffectParameters(kind)];
}

export function effectRequiresTarget(kind: string): boolean { return getModelEffectParameters(kind).length > 0 || kind === 'target-follow'; }
