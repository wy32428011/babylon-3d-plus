type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** 入口场景只需同步其引用环境；无法识别的旧格式返回undefined保留兼容行为。 */
export function getRequiredEnvironmentResourceIds(sceneFile: unknown): string[] | undefined {
  if (!record(sceneFile)) return undefined;
  const scene = record(sceneFile.scene) ? sceneFile.scene : sceneFile;
  const settings = record(scene.sceneSettings) ? scene.sceneSettings : null;
  if (!settings?.environment) return [];
  if (!record(settings.environment)) return undefined;
  const environment = settings.environment;
  if (typeof environment.dataPlatformResourceId === 'string' && /^[1-9]\d{0,63}$/.test(environment.dataPlatformResourceId)) {
    return [environment.dataPlatformResourceId];
  }
  // 只识别已定义的受管缓存布局，不用文件名或显示名猜测远端身份。
  for (const value of [environment.activeVariantUrl, environment.packagePath]) {
    if (typeof value !== 'string') continue;
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { continue; }
    const match = decoded.replace(/\\/g, '/').match(/\.babylon-editor\/data-platform-cache\/environments\/[a-f0-9]{64}\/([1-9]\d{0,63})\/\d+(?:\/|$)/i);
    if (match) return [match[1]];
  }
  return undefined;
}
