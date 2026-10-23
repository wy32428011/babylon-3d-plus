import type { LightingBakeAsset, LightingBakeSurface } from '../../../electron/shared/sceneLightingBakeContract.ts';

export type LightingRuntimeDiagnostic = { message: string; kind: 'resource' | 'runtime'; assetId?: string; entityId?: string; nodeKey?: string };

/** 资源身份取自已验证清单，禁止由本地化消息反向猜测。 */
export class LightingResourceError extends Error {
  readonly diagnostic: LightingRuntimeDiagnostic;
  readonly assetKind: LightingBakeAsset['kind'];
  constructor(cause: unknown, asset: LightingBakeAsset, surface?: Pick<LightingBakeSurface, 'entityId' | 'nodeKey'>) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'LightingResourceError'; this.assetKind = asset.kind;
    this.diagnostic = { kind: 'resource', message: this.message, assetId: asset.id,
      ...(surface ? { entityId: surface.entityId, nodeKey: surface.nodeKey } : {}) };
  }
}
export function getLightingRuntimeDiagnostic(error: unknown): LightingRuntimeDiagnostic {
  return error instanceof LightingResourceError ? { ...error.diagnostic }
    : { kind: 'runtime', message: error instanceof Error ? error.message : String(error) };
}
