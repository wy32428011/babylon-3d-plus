type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);

export function rawSceneOpening(value: unknown): RecordValue | null {
  const scene = record(value) && record(value.scene) ? value.scene : value;
  const opening = record(scene) && record(scene.sceneSettings) ? scene.sceneSettings.openingAnimation : undefined;
  return record(opening) ? opening : null;
}

/** 恢复档案仅保留工程内相对资源位置，不让本机路径进入 SOURCE。原场景对象不变。 */
function portableRecovery(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableRecovery);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, portableRecovery(child)]));
  if (typeof value !== 'string') return value;
  let local = value;
  if (local.startsWith('editor-asset://local/')) {
    try { local = decodeURIComponent(new URL(local).pathname.slice(1)); } catch { return '[开场资源待重新导入]'; }
  } else if (!/^(?:file:|[a-z]:[\\/]|\\\\|\/)/i.test(local)) return value;
  const normalized = local.replace(/\\/g, '/');
  const match = /(?:^|\/)(Assets\/Opening(?:Packages|Assets)\/[^?#]*)$/i.exec(normalized);
  return match && !match[1].split('/').includes('..') ? match[1] : '[开场资源待重新导入]';
}

export type OpeningPublishPlan<T, S> = { scene: S; opening: T | null; warnings: string[] };

/** 开场是可选展示。只隔离其解析异常，业务资源和取消仍由主发布流程处理。 */
export async function createOpeningPublishPlan<T, S>(input: S, options: {
  mode: 'source' | 'dist'; signal: AbortSignal;
  resolve(scene: S): Promise<T | null>;
  validateViewer?(scene: S): Promise<void>;
}): Promise<OpeningPublishPlan<T, S>> {
  const abort = () => { if (options.signal.aborted) throw Object.assign(new Error('发布已取消。'), { name: 'AbortError' }); };
  abort();
  const originalOpening = rawSceneOpening(input);
  if (!originalOpening || !record(input)) return { scene: input, opening: null, warnings: [] };
  const originalBody = record(input.scene) ? input.scene : input;
  // 仅复制开场命名空间。模型/天空盒/烘焙的预检 WeakSet 和引用必须保持有效。
  const copiedBody = { ...originalBody, sceneSettings: { ...originalBody.sceneSettings as RecordValue,
    openingAnimation: structuredClone(originalOpening) } };
  const scene = (record(input.scene) ? { ...input, scene: copiedBody } : copiedBody) as S;
  const body = record(scene) && record(scene.scene) ? scene.scene : scene;
  const settings = record(body) && record(body.sceneSettings) ? body.sceneSettings : null;
  const raw = rawSceneOpening(scene);
  const plan: OpeningPublishPlan<T, S> = { scene, opening: null, warnings: [] };
  if (!raw || !settings) return plan;
  const omit = (reason?: string) => {
    if (options.mode === 'dist') delete settings.openingAnimation;
    else if (reason) settings.openingAnimation = { ...portableRecovery(raw) as RecordValue, enabled: false, unavailableReason: reason };
    if (reason) plan.warnings.push(`三维场景继续发布；本次开场未包含：${reason}`);
  };
  if (raw.template !== 'package') {
    if (options.mode === 'dist') omit(raw.enabled === true ? '旧内置开场尚未迁移为已导入的开场包。' : undefined);
    else settings.openingAnimation = portableRecovery(raw);
    return plan;
  }
  if (options.mode === 'dist' && raw.enabled !== true) { omit(); return plan; }
  try {
    if (raw.enabled === true) await options.validateViewer?.(scene);
    abort();
    plan.opening = await options.resolve(scene);
    if (!plan.opening) throw new Error('开场包没有可用资源。');
    delete raw.unavailableReason;
  } catch (error) {
    abort();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const reason = record(error) && typeof error.code === 'string' ? `开场资源文件不可用（${error.code}）。`
      : error instanceof Error ? error.message : '开场包不可用。';
    omit(reason);
  }
  abort();
  return plan;
}
