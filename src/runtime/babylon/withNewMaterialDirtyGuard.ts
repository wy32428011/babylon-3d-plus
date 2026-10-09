import type { Scene } from '@babylonjs/core';

/** 仅包围未挂载的新材质同步初始化；禁止原材质更新和异步回调进入此保护范围。 */
export function withNewMaterialDirtyGuard<T>(scene: Scene, initialize: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  const blocked = scene.blockMaterialDirtyMechanism;
  // Babylon 9.12.0 的公开 setter 在恢复 false 时刷新全场景，内部方法仅恢复开关。
  scene._forceBlockMaterialDirtyMechanism(true);
  try { return initialize(); }
  finally { scene._forceBlockMaterialDirtyMechanism(blocked); }
}
