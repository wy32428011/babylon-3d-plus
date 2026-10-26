import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LightingBakeEngineConfiguration } from '../shared/lightingBakeEngineConfiguration.js';
import type { LightingBakeEngineStatus } from '../shared/sceneLightingBakeContract.js';

type ConfigurationFile = { text: string | null; fields: Record<string, unknown>; configuredPath: string | null; error?: string };
type ConfigurationOptions = {
  userDataDirectory: string;
  detectEnginePath: (candidate: string, refresh: boolean) => Promise<LightingBakeEngineStatus>;
  getEnvironmentPath?: () => string | undefined;
  installationCandidates?: () => Promise<string[]>;
  replaceConfigurationFile?: (temporary: string, destination: string) => Promise<void>;
};
const CONFIGURATION_FILE_NAME = 'lighting-bake-engine.json';
const CONFIGURATION_ERROR = '本机 lighting-bake-engine.json 配置不可读取或格式错误，请先修复配置文件，再保存引擎设置。';
const NOT_FOUND_MESSAGE = '未找到可用 Blender。请安装 Blender 4+，并在光照与烘焙管理器中配置本机引擎。';
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

/** 只接受用户明确选择的 Blender 可执行文件，不允许命令、参数或相对路径。 */
export function validateLightingBakeEnginePath(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.length > 4096 || candidate.includes('\0')) throw new Error('Blender 路径格式不正确。');
  const normalized = candidate.trim();
  if (!path.isAbsolute(normalized) || !/^blender(?:\.exe)?$/i.test(path.basename(normalized))) throw new Error('请选择 Blender 的完整可执行文件路径（blender.exe 或 blender）。');
  return normalized;
}

async function readConfigurationFile(configPath: string): Promise<ConfigurationFile> {
  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) return { text: null, fields: {}, configuredPath: null, error: CONFIGURATION_ERROR };
    const text = await fs.readFile(configPath, 'utf8'), fields: unknown = JSON.parse(text);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { text, fields: {}, configuredPath: null, error: CONFIGURATION_ERROR };
    const value = (fields as Record<string, unknown>).blenderPath;
    if (value !== undefined && value !== null && typeof value !== 'string') return { text, fields: {}, configuredPath: null, error: CONFIGURATION_ERROR };
    return { text, fields: fields as Record<string, unknown>, configuredPath: typeof value === 'string' ? value.trim() || null : null };
  } catch (error) {
    return isMissing(error) ? { text: null, fields: {}, configuredPath: null } : { text: null, fields: {}, configuredPath: null, error: CONFIGURATION_ERROR };
  }
}

async function installationCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/usr/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender'];
  const bases = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')];
  const local = process.env.LOCALAPPDATA;
  // 保留系统安装的优先级；每用户安装也可能使用官方便携包的 blender-x.y.z-windows-x64 目录名。
  if (local && path.isAbsolute(local)) bases.push(path.join(local, 'Programs', 'Blender Foundation'));
  const result: string[] = [];
  for (const [index, base] of bases.entries()) {
    try {
      const names = (await fs.readdir(base, { withFileTypes: true }))
        .filter(entry => (index === 0 && /^Blender \d/.test(entry.name))
          || (entry.isDirectory() && !entry.isSymbolicLink()
            && (/^Blender \d/i.test(entry.name) || /^blender-\d+\.\d+(?:\.\d+)?-windows-x64$/i.test(entry.name))))
        .map(entry => entry.name)
        .sort((a, b) => (b.match(/\d+(?:\.\d+)*/)?.[0] ?? '').localeCompare(a.match(/\d+(?:\.\d+)*/)?.[0] ?? '', undefined, { numeric: true })
          || b.localeCompare(a, undefined, { numeric: true }));
      result.push(...names.map(name => path.join(base, name, 'blender.exe')));
    } catch { /* 单个安装根缺失或不可读时继续其它已知根；最终仍由原路径/版本检测判定可用性。 */ }
  }
  return result;
}

/** 配置写入与完整烘焙生命周期共用预约，防止检测、落盘和新任务交错。 */
export function createLightingBakeEngineConfigurationService(options: ConfigurationOptions) {
  const configPath = path.join(options.userDataDirectory, CONFIGURATION_FILE_NAME);
  const getEnvironmentPath = options.getEnvironmentPath ?? (() => process.env.BABYLON_BLENDER_PATH);
  const getInstallationCandidates = options.installationCandidates ?? installationCandidates;
  let saving = false, activeJobs = 0;
  const busy = () => saving || activeJobs > 0;

  async function getConfiguration(): Promise<LightingBakeEngineConfiguration> {
    const file = await readConfigurationFile(configPath), environmentPath = getEnvironmentPath()?.trim() || null;
    const base = { configuredPath: file.configuredPath, configPath, environmentPath, ...(file.error ? { configurationError: file.error } : {}) };
    const checked = new Set<string>();
    const candidates: Array<[string | null, LightingBakeEngineConfiguration['source']]> = [[environmentPath, 'environment'], [file.configuredPath, 'configuration']];
    for (const [candidate, source] of candidates) {
      if (!candidate || checked.has(candidate)) continue;
      checked.add(candidate);
      const engine = await options.detectEnginePath(candidate, false);
      if (engine.available) return { ...base, source, engine, busy: busy() };
    }
    for (const candidate of await getInstallationCandidates()) {
      if (checked.has(candidate)) continue;
      checked.add(candidate);
      const engine = await options.detectEnginePath(candidate, false);
      if (engine.available) return { ...base, source: 'installation', engine, busy: busy() };
    }
    return { ...base, source: null, engine: { available: false, message: file.error ?? NOT_FOUND_MESSAGE }, busy: busy() };
  }

  async function writeConfiguration(file: ConfigurationFile, candidate: string | null): Promise<void> {
    if (candidate === null && file.text === null) return;
    const fields = { ...file.fields };
    if (candidate === null) delete fields.blenderPath; else fields.blenderPath = candidate;
    const temporary = path.join(options.userDataDirectory, `.lighting-bake-engine-${randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      await fs.mkdir(options.userDataDirectory, { recursive: true });
      const handle = await fs.open(temporary, 'wx', 0o600); ownsTemporary = true;
      try { await handle.writeFile(`${JSON.stringify(fields, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // 外部编辑器在检测期间修改配置时，保留对方内容，要求用户重新读取后再保存。
      const current = await readConfigurationFile(configPath);
      if (current.error || current.text !== file.text) throw new Error('本机配置在检测期间已被修改，请重新打开配置后再保存。');
      await (options.replaceConfigurationFile ?? fs.rename)(temporary, configPath);
      ownsTemporary = false;
    } catch (error) {
      throw new Error(`无法保存本机引擎配置：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      // 只清理本次通过 wx 创建的单个临时文件，绝不清理未知残留或旧配置。
      if (ownsTemporary) await fs.unlink(temporary).catch(error => { if (!isMissing(error)) throw new Error('无法清理本次引擎配置临时文件。', { cause: error }); });
    }
  }

  async function saveConfiguration(raw: unknown): Promise<LightingBakeEngineConfiguration> {
    if (saving) throw new Error('正在保存本机引擎配置，请稍后重试。');
    if (activeJobs) throw new Error('光照烘焙正在运行或清理，请完成或取消后再保存本机引擎配置。');
    if (raw !== null && typeof raw !== 'string') throw new Error('Blender 路径必须是字符串，恢复自动查找时请使用空值。');
    const candidate = typeof raw === 'string' && raw.trim() ? validateLightingBakeEnginePath(raw) : null;
    saving = true;
    try {
      const file = await readConfigurationFile(configPath);
      if (file.error) throw new Error(file.error);
      if (candidate !== null) {
        const engine = await options.detectEnginePath(candidate, true);
        if (!engine.available || engine.path !== candidate) throw new Error(engine.message ?? '所选 Blender 路径检测失败，原配置已保留。');
      }
      await writeConfiguration(file, candidate);
      const result = await getConfiguration();
      return { ...result, busy: activeJobs > 0 };
    } finally { saving = false; }
  }

  async function withBakeJob<T>(run: () => Promise<T>): Promise<T> {
    if (saving) throw new Error('正在保存本机引擎配置，请保存完成后重试烘焙。');
    activeJobs++;
    try { return await run(); } finally { activeJobs--; }
  }

  return { getConfiguration, saveConfiguration, withBakeJob, detectPath: (candidate: unknown) => options.detectEnginePath(validateLightingBakeEnginePath(candidate), true) };
}
