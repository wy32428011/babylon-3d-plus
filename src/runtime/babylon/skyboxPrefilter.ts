import type { AbstractEngine } from '@babylonjs/core';

/** Babylon 的预过滤等待只响应编译成功；通过公开错误事件让失败及时结算。 */
export async function waitForSkyboxPrefilter(engine: Pick<AbstractEngine, 'onEffectErrorObservable'>,
  prefilter: () => Promise<void>): Promise<void> {
  let rejectCompilation!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectCompilation = reject; });
  const observer = engine.onEffectErrorObservable.add(({ effect, errors }) => {
    const name = effect.name;
    if (typeof name === 'string' || name.vertex !== 'hdrFiltering' || name.fragment !== 'hdrFiltering') return;
    rejectCompilation(new Error(`天空盒预过滤着色器编译失败：${errors}`));
    effect.dispose();
  });
  try { await Promise.race([prefilter(), failed]); }
  finally { engine.onEffectErrorObservable.remove(observer); }
}
