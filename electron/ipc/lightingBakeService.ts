import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { LightingBakeAsset, LightingBakeEngineStatus, LightingBakeInput, LightingBakeProgress, SceneLightingBakeSnapshot } from '../shared/sceneLightingBakeContract.js';
import { matchLightingBakeSurfaceSources, safeLightingBakeChildPath } from './lightingBakeValidation.ts';
import { inspectLightingBakeInput, assertLightingBakePreflight, type LightingBakePreflight } from '../shared/sceneLightingBakePreflight.ts';
import { decodeLightingGeometryResource } from '../shared/sceneLightingBakeGeometryBinary.ts';
import { validateLightingProbes, validateLightingPng } from '../shared/sceneLightingBakeArtifacts.ts';
import { encodeLightingBakeTransport, type LightingBakeBinaryMesh } from '../shared/sceneLightingBakeBinary.ts';
import type { LightingBakeDevice, LightingBakeDeviceSelection } from '../shared/sceneLightingBakeDevices.ts';
import { createLightingBakeTask } from './lightingBakeTaskHistory.ts';
import { createLightingBakeEngineConfigurationService, validateLightingBakeEnginePath } from './lightingBakeEngineConfiguration.ts';

const SOURCE_TEXTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.hdr', '.exr']);
const engineDeviceCache = new Map<string, Promise<LightingBakeDevice[]>>();
const engineVersionCache = new Map<string, Promise<LightingBakeEngineStatus>>();
export type LightingBakeServiceOptions = {
  input: LightingBakeInput;
  projectRoot: string;
  enginePath: string;
  signal: AbortSignal;
  isProjectCurrent: () => boolean;
  isAuthorizedAssetFile: (file: string) => boolean;
  decodeAssetUrl: (url: string) => string;
  encodeAssetUrl: (file: string) => string;
  authorizeAssetFile: (file: string) => void;
  onProgress: (progress: LightingBakeProgress) => void;
  timeoutMs?: number;
  engineVersion?: string;
  binaryGeometry?: LightingBakeBinaryMesh[];
  onEngineSpawn?: (pid: number) => void;
  onDevice?: (selection: LightingBakeDeviceSelection) => void;
  onMemory?: (bytes: number | null) => void;
  logName?: 'cycles.log' | 'cycles-cpu.log';
};

type EngineDetectionOptions = {
  refresh?: boolean;
  probeVersion?: (candidate: string) => Promise<LightingBakeEngineStatus>;
  discoverDevices?: (candidate: string) => Promise<LightingBakeDevice[]>;
};

/** 固定参数探针；可注入进程工厂与时限，在临时夹具中验证异常和取消边界。 */
export function probeLightingBakeEngineVersion(candidate: string, options: { spawnProcess?: typeof spawn; timeoutMs?: number } = {}): Promise<LightingBakeEngineStatus> {
  return new Promise(resolve => {
    let output = '', finished = false;
    const child = (options.spawnProcess ?? spawn)(candidate, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result: LightingBakeEngineStatus) => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ available: false, message: 'Blender 版本检测超时。' }); }, options.timeoutMs ?? 10_000);
    child.stdout.on('data', chunk => { if (output.length < 4096) output += String(chunk); });
    child.stderr.resume();
    child.on('error', () => finish({ available: false, message: '无法启动所选 Blender，请检查文件权限与安装是否完整。' }));
    child.on('close', code => {
      const version = /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(output)?.[1];
      finish(code === 0 && version && Number(version.split('.')[0]) >= 4
        ? { available: true, path: candidate, version }
        : { available: false, message: '光照烘焙需要 Blender 4 或更新版本。' });
    });
  });
}

/** 精确检测输入路径；手动检测和保存会同时刷新版本、设备缓存，不回退其他安装。 */
export async function detectLightingBakeEnginePath(raw: unknown, options: EngineDetectionOptions = {}): Promise<LightingBakeEngineStatus> {
  let candidate: string;
  try { candidate = validateLightingBakeEnginePath(raw); } catch (error) { return { available: false, message: error instanceof Error ? error.message : 'Blender 路径格式不正确。' }; }
  if (options.refresh) { engineVersionCache.delete(candidate); engineDeviceCache.delete(candidate); }
  try { if (!(await fs.stat(candidate)).isFile()) return { available: false, message: '所选 Blender 路径不是有效文件。' }; }
  catch { return { available: false, message: '所选 Blender 文件不存在或不可读取。' }; }
  let status = engineVersionCache.get(candidate);
  if (!status) { status = (options.probeVersion ?? probeLightingBakeEngineVersion)(candidate); engineVersionCache.set(candidate, status); }
  try {
    const result = await status;
    const current = engineVersionCache.get(candidate) === status;
    if (!result.available) { if (current) engineVersionCache.delete(candidate); return result; }
    // 旧查询可能晚于显式刷新完成，不得把旧设备或失败状态写回新一代缓存。
    if (!current) return { ...result, devices: await (options.discoverDevices ?? discoverLightingBakeDevices)(candidate) };
    let devices = engineDeviceCache.get(candidate);
    if (!devices) { devices = (options.discoverDevices ?? discoverLightingBakeDevices)(candidate); engineDeviceCache.set(candidate, devices); }
    return { ...result, devices: await devices };
  } catch {
    if (engineVersionCache.get(candidate) === status) { engineVersionCache.delete(candidate); engineDeviceCache.delete(candidate); }
    return { available: false, message: '检测所选 Blender 时发生错误，请检查安装后重试。' };
  }
}

/** 路径由本机配置或安装目录发现，场景文档不能提供可执行文件。 */
export async function findLightingBakeEngine(userDataDirectory: string): Promise<LightingBakeEngineStatus> {
  return (await createLightingBakeEngineConfigurationService({ userDataDirectory, detectEnginePath: (candidate, refresh) => detectLightingBakeEnginePath(candidate, { refresh }) }).getConfiguration()).engine;
}

/** 能力探测在独立进程内执行，绝不保存 Blender 用户偏好。 */
export async function discoverLightingBakeDevices(enginePath: string): Promise<LightingBakeDevice[]> {
  return new Promise(resolve => {
    const fallback: LightingBakeDevice[] = [{ id: 'cpu', name: 'CPU', backend: 'CPU', type: 'CPU' }];
    let output = '', settled = false;
    const child = spawn(enginePath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python',
      fileURLToPath(new URL('../lighting-bake/cycles_bake.py', import.meta.url)), '--', '--devices'], { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    const finish = (devices: LightingBakeDevice[]) => { if (settled) return; settled = true; clearTimeout(timer); resolve(devices); };
    const timer = setTimeout(() => { child.kill(); finish(fallback); }, 30_000);
    child.stdout.on('data', bytes => { if (output.length < 65536) output += String(bytes); }); child.stderr.resume();
    child.on('error', () => finish(fallback));
    child.on('close', code => {
      try {
        const line = output.split(/\r?\n/).find(line => line.startsWith('LIGHTING_BAKE_DEVICES '));
        const devices = JSON.parse(line?.slice('LIGHTING_BAKE_DEVICES '.length) ?? 'null') as LightingBakeDevice[];
        if (code !== 0 || !Array.isArray(devices) || !devices.length || devices.some(device => !device || typeof device.id !== 'string' || typeof device.name !== 'string' || typeof device.backend !== 'string' || !['CPU','GPU'].includes(device.type))) return finish(fallback);
        finish(devices);
      } catch { finish(fallback); }
    });
  });
}

function assertActive(options: LightingBakeServiceOptions): void {
  if (options.signal.aborted) throw new Error('光照烘焙已取消。');
  if (!options.isProjectCurrent()) throw new Error('项目已经切换，已停止原项目的光照烘焙。');
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertPng(bytes: Buffer, maxPixels: number): void { validateLightingPng(bytes, maxPixels); }

/** 仅检查已授权输入；不写任务、不启动引擎，也不修改旧烘焙或配置。 */
export async function inspectLightingBakeRequest(input: LightingBakeInput, access: Pick<LightingBakeServiceOptions, 'decodeAssetUrl' | 'isAuthorizedAssetFile'>): Promise<LightingBakePreflight> {
  const report = inspectLightingBakeInput(input), urls = new Set<string>();
  for (const mesh of input.meshes) for (const texture of Object.values(mesh.material.textures ?? {})) if (texture) urls.add(texture.url);
  if (input.environment.textureUrl) urls.add(input.environment.textureUrl);
  let bytes = 0;
  for (const url of urls) {
    if (url.startsWith('data:image/png;base64,')) { const data = url.slice('data:image/png;base64,'.length); bytes += data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0); }
    else {
      const original = access.decodeAssetUrl(url);
      if (!access.isAuthorizedAssetFile(original)) throw new Error('烘焙纹理尚未被当前编辑器授权。');
      const actual = await fs.realpath(original);
      if (!access.isAuthorizedAssetFile(actual)) throw new Error('烘焙纹理链接指向未授权目录。');
      const stat = await fs.stat(actual);
      if (!stat.isFile() || !SOURCE_TEXTURE_EXTENSIONS.has(path.extname(actual).toLowerCase())) throw new Error('烘焙输入纹理文件或格式无效。');
      bytes += stat.size;
    }
  }
  report.sourceTextureBytes = bytes;
  if (bytes > input.settings.maxTextureMiB * 1048576) report.issues.push({ code: 'source-texture-budget', severity: 'error', message: '输入纹理总量超过烘焙纹理预算。' });
  return report;
}

async function ensureProjectDirectory(project: string, segments: string[]): Promise<string> {
  let current = project;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (!inside(project, await fs.realpath(current))) throw new Error('烘焙目录链接超出当前工程。');
  }
  return current;
}

async function prepareInput(options: LightingBakeServiceOptions, directory: string): Promise<void> {
  const encoded = options.binaryGeometry ? { input: { ...options.input, meshes: options.input.meshes.map(mesh => {
    const metadata: Partial<typeof mesh> = { ...mesh }; for (const field of ['positions','normals','indices','uvs','uvs2','colors','tangents'] as const) delete metadata[field]; return metadata;
  }) }, geometry: options.binaryGeometry } : encodeLightingBakeTransport(options.input);
  // 几何单独保存，JSON 只包含版本化元数据；不再复制全量 number[] 树或整包字符串。
  const request = structuredClone(encoded.input) as unknown as LightingBakeInput & { environment: { textureFile?: string } };
  const geometry = options.binaryGeometry ?? encoded.geometry;
  for (const [index, item] of geometry.entries()) {
    assertActive(options);
    const file = 'geometry-input-' + index + '.bin';
    await fs.writeFile(safeLightingBakeChildPath(directory, file), new Uint8Array(item.bytes), { flag: 'wx', signal: options.signal });
    const mesh = request.meshes.find(mesh => mesh.key === item.key);
    if (!mesh) throw new Error('二进制输入几何映射缺失。');
    Object.assign(mesh, { geometryBinary: { version: 1, file, byteLength: item.bytes.byteLength, attributes: item.attributes } });
  }
  const sources = new Map<string, string>();
  const budget = request.settings.maxTextureMiB * 1024 * 1024;
  let preparedBytes = 0;
  const copyTexture = async (url: string): Promise<string> => {
    if (sources.has(url)) return sources.get(url)!;
    assertActive(options);
    let bytes: Buffer, extension: string;
    if (url.startsWith('data:image/png;base64,')) {
      if (url.length * 0.75 > budget) throw new Error('导出的纹理超过烘焙纹理预算。');
      bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      assertPng(bytes, budget / 4);
      extension = '.png';
    } else {
      const original = options.decodeAssetUrl(url);
      if (!options.isAuthorizedAssetFile(original)) throw new Error('烘焙纹理尚未被当前编辑器授权。');
      const actual = await fs.realpath(original);
      if (!options.isAuthorizedAssetFile(actual)) throw new Error('烘焙纹理链接指向未授权目录。');
      const info = await fs.stat(actual);
      if (!info.isFile() || info.size > budget) throw new Error('烘焙纹理文件无效或超过预算。');
      extension = path.extname(actual).toLowerCase();
      if (!SOURCE_TEXTURE_EXTENSIONS.has(extension)) throw new Error(`不支持的烘焙纹理格式 ${extension}，请使用渲染纹理导出的 PNG。`);
      bytes = await fs.readFile(actual, { signal: options.signal });
      if (extension === '.png') assertPng(bytes, budget / 4);
    }
    preparedBytes += bytes.length;
    if (preparedBytes > budget) throw new Error('烘焙输入纹理总量超过预算。');
    const name = `source-texture-${sources.size}${extension}`;
    await fs.writeFile(safeLightingBakeChildPath(directory, name), bytes, { flag: 'wx', signal: options.signal });
    sources.set(url, name); return name;
  };
  for (const mesh of request.meshes) {
    for (const texture of Object.values(mesh.material.textures ?? {})) {
      if (!texture) continue;
      const file = await copyTexture(texture.url);
      Object.assign(texture, { file, coordinatesIndex: texture.coordinatesIndex ?? 0,
        uScale: texture.uScale ?? 1, vScale: texture.vScale ?? 1, uOffset: texture.uOffset ?? 0,
        vOffset: texture.vOffset ?? 0, wAng: texture.wAng ?? 0, level: texture.level ?? 1 });
      // Python 只看到任务内部的文件名，不接触原始路径或资产协议。
      texture.url = '';
    }
  }
  if (request.environment.textureUrl) {
    request.environment.textureFile = await copyTexture(request.environment.textureUrl);
    delete request.environment.textureUrl;
  }
  await fs.writeFile(path.join(directory, 'input.json'), JSON.stringify(request), { flag: 'wx' });
}

/** 准备/预检共用 15% 边界；同一进程的切分总量变化也不能让进度倒退。 */
export function mapLightingBakeEngineProgress(value: { phase: string; completed: number; total: number }, previous = 0): number {
  const ratio = Math.max(0, Math.min(1, value.completed / Math.max(1, value.total)));
  const progress = value.phase === 'unwrap' ? ratio * 0.15 : value.phase === 'preflight' ? 0.15
    : value.phase === 'probes' ? 0.75 + ratio * 0.2 : value.phase === 'completed' ? 0.96 : 0.15 + ratio * 0.6;
  return Math.max(previous, progress);
}

/** 只启动受控脚本；取消只作用于该任务直接创建的子进程。 */
export async function runLightingBakeProcess(options: LightingBakeServiceOptions, directory: string, script: string): Promise<void> {
  assertActive(options);
  await new Promise<void>((resolve, reject) => {
    const log = createWriteStream(path.join(directory, options.logName ?? 'cycles.log'), { flags: 'wx' });
    let errorMessage = '', gpuFallback = false, previousProgress = 0, settled = false, terminationError: Error | null = null;
    const child = spawn(options.enginePath, ['--background', '--factory-startup', '--disable-autoexec',
      '--python-exit-code', '1', '--python', script, '--', '--input', path.join(directory, 'input.json')],
    { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    if (child.pid) options.onEngineSpawn?.(child.pid);
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: Error) => {
      if (terminationError || settled) return; terminationError = reason;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 3000);
    };
    const cancel = () => terminate(new Error('光照烘焙已取消。'));
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const timeout = setTimeout(() => terminate(new Error('光照烘焙超时，已停止该任务；原烘焙结果保持可用。')), options.timeoutMs ?? 6 * 60 * 60 * 1000);
    const projectCheck = setInterval(() => { if (!options.isProjectCurrent()) terminate(new Error('项目已切换，光照烘焙停止。')); }, 1000);
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timeout); clearInterval(projectCheck); if (forceTimer) clearTimeout(forceTimer);
      options.signal.removeEventListener('abort', cancel);
      log.end(() => { if (error) reject(error); else resolve(); });
    };
    log.on('error', error => { terminate(new Error(`无法记录烘焙日志：${error.message}`)); });
    const createConsumer = () => {
      const decoder = new StringDecoder('utf8');
      let lineBuffer = '';
      return (chunk: Buffer) => {
        if (!log.destroyed) log.write(chunk);
        lineBuffer += decoder.write(chunk);
        const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? '';
        if (lineBuffer.length > 65536) lineBuffer = lineBuffer.slice(-65536);
      for (const line of lines) {
        if (line.startsWith('LIGHTING_BAKE_GPU_FALLBACK ')) gpuFallback = true;
        if (line.startsWith('LIGHTING_BAKE_DEVICE ')) {
          try { const device = JSON.parse(line.slice('LIGHTING_BAKE_DEVICE '.length)) as LightingBakeDeviceSelection;
            if (['cpu','auto','gpu'].includes(device.requested) && ['CPU','GPU'].includes(device.actual) && typeof device.name === 'string' && typeof device.backend === 'string') options.onDevice?.(device);
          } catch { /* 只接收受控协议；其余文字保留在日志。 */ }
        }
        if (line.startsWith('LIGHTING_BAKE_MEMORY ')) {
          const bytes = Number(line.slice('LIGHTING_BAKE_MEMORY '.length)); options.onMemory?.(Number.isFinite(bytes) && bytes > 0 ? bytes : null);
        }
        if (line.startsWith('LIGHTING_BAKE_ERROR ')) errorMessage = line.slice(20);
        if (!line.startsWith('LIGHTING_BAKE_PROGRESS ')) continue;
        try {
          const value = JSON.parse(line.slice('LIGHTING_BAKE_PROGRESS '.length)) as { phase: string; completed: number; total: number; message: string };
          if (Number.isFinite(value.completed) && Number.isFinite(value.total) && typeof value.message === 'string') {
            const progress = mapLightingBakeEngineProgress(value, previousProgress);
            previousProgress = progress;
            options.onProgress({ jobId: options.input.jobId, phase: 'baking', progress, message: value.message });
          }
        } catch { /* 其余 Cycles 输出只进入日志，不执行其中内容。 */ }
      }
      };
    };
    child.stdout.on('data', createConsumer()); child.stderr.on('data', createConsumer());
    child.on('error', error => finish(new Error(`Blender 启动失败：${error.message}`)));
    child.on('close', code => { const error = new Error(errorMessage || `Blender 烘焙失败（退出码 ${code}），请查看任务日志。`); if (gpuFallback) error.name = 'LightingBakeGpuFallbackError'; finish(terminationError ?? (code === 0 ? undefined : error)); });
  });
}

type EngineResult = {
  version: number; signature: string; engineVersion: string;
  atlases: Array<{ file: string; width: number; height: number; rgbmRange: number }>;
  meshes: Array<{ key: string; entityId: string; nodeKey: string; geometryFile: string; geometryVersion?: 1 | 2; encoding?: LightingBakeAsset['encoding']; atlasIndex: number }>;
  probesFile: string; statistics: SceneLightingBakeSnapshot['statistics'];
};

async function validateAndPromote(options: LightingBakeServiceOptions, staging: string, assetsRoot: string): Promise<SceneLightingBakeSnapshot> {
  const result = JSON.parse(await fs.readFile(path.join(staging, 'result.json'), 'utf8')) as EngineResult;
  if (result.version !== 1 || result.signature !== options.input.signature || !Array.isArray(result.atlases)
    || !Array.isArray(result.meshes) || typeof result.engineVersion !== 'string' || !result.engineVersion || !result.statistics) throw new Error('烘焙结果与场景输入不匹配。');
  const sourceMeshes = matchLightingBakeSurfaceSources(options.input.meshes, result.meshes);
  const textureBytes = result.atlases.length * options.input.settings.atlasSize ** 2 * 4;
  if (textureBytes > options.input.settings.maxTextureMiB * 1048576) throw new Error('光照图集超过当前纹理预算，候选结果未提交。');
  // 正式资产与候选目录也使用短随机名称，避免烘焙完成后保存产物再次触发 Windows 长路径限制。
  const folderName = randomBytes(12).toString('hex');
  const pending = path.join(assetsRoot, `.pending-${folderName}`), destination = path.join(assetsRoot, folderName);
  await fs.mkdir(pending);
  const assets: LightingBakeAsset[] = [];
  let validatedProbeCount = 0;
  const copyOutput = async (name: string, kind: LightingBakeAsset['kind'], id: string, rgbmRange?: number, expectedGeometryVersion?: 1 | 2, encoding?: LightingBakeAsset['encoding']) => {
    if (encoding !== undefined && (kind !== 'geometry' || encoding !== 'json' && encoding !== 'binary-v1')) throw new Error('几何结果清单编码不正确。');
    const expectedExtension = kind === 'lightmap' ? '.png' : kind === 'geometry' && encoding === 'binary-v1' ? '.bin' : '.json';
    if (path.extname(name).toLowerCase() !== expectedExtension) throw new Error('烘焙产物扩展名与清单编码不一致。');
    const source = safeLightingBakeChildPath(staging, name);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('烘焙产物不是有效文件。');
    const bytes = await fs.readFile(source, { signal: options.signal });
    let geometryVersion: 1 | 2 | undefined;
    if (kind === 'lightmap') validateLightingPng(bytes, options.input.settings.atlasSize ** 2, { width: options.input.settings.atlasSize, height: options.input.settings.atlasSize });
    else {
      if (kind === 'geometry') {
        geometryVersion = decodeLightingGeometryResource(bytes, encoding).version;
        if (expectedGeometryVersion !== undefined && expectedGeometryVersion !== geometryVersion) throw new Error('几何文件与结果清单版本不一致。');
      } else validatedProbeCount = validateLightingProbes(JSON.parse(bytes.toString('utf8'))).probes.length;
    }
    await fs.writeFile(safeLightingBakeChildPath(pending, name), bytes, { flag: 'wx', signal: options.signal });
    assets.push({ id, kind, url: options.encodeAssetUrl(path.join(destination, name)), byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...(geometryVersion !== undefined ? { geometryVersion } : {}), ...(encoding !== undefined ? { encoding } : {}), ...(rgbmRange !== undefined ? { rgbmRange } : {}) });
  };
  try {
    for (const [index, atlas] of result.atlases.entries()) {
      if (!(atlas.rgbmRange > 0) || !Number.isFinite(atlas.rgbmRange) || atlas.width !== options.input.settings.atlasSize || atlas.height !== atlas.width) throw new Error('光照贴图元数据不正确。');
      await copyOutput(atlas.file, 'lightmap', `lightmap-${index}`, atlas.rgbmRange);
    }
    const surfaces: SceneLightingBakeSnapshot['surfaces'] = [];
    const seen = new Set<string>();
    for (const [index, mesh] of result.meshes.entries()) {
      const original = sourceMeshes[index];
      if (!original || seen.has(mesh.key) || original.receiver === false || original.entityId !== mesh.entityId || original.nodeKey !== mesh.nodeKey
        || !Number.isInteger(mesh.atlasIndex) || !result.atlases[mesh.atlasIndex]) throw new Error('烘焙表面映射不正确。');
      seen.add(mesh.key);
      if (mesh.geometryVersion !== undefined && mesh.geometryVersion !== 1 && mesh.geometryVersion !== 2) throw new Error('几何结果清单版本不正确。');
      await copyOutput(mesh.geometryFile, 'geometry', `geometry-${index}`, undefined, mesh.geometryVersion, mesh.encoding);
      surfaces.push({ key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, geometryAssetId: `geometry-${index}`, lightmapAssetId: `lightmap-${mesh.atlasIndex}` });
    }
    await copyOutput(result.probesFile, 'probes', 'probes');
    for (const key of ['meshCount', 'triangleCount', 'atlasCount', 'probeCount', 'textureBytes', 'durationMs'] as const) if (!Number.isFinite(result.statistics[key]) || result.statistics[key] < 0) throw new Error('烘焙统计数据不正确。');
    if (result.statistics.atlasCount !== result.atlases.length || result.statistics.textureBytes !== textureBytes || result.statistics.probeCount !== validatedProbeCount) throw new Error('烘焙统计与实际图集不一致。');
    const snapshot: SceneLightingBakeSnapshot = { version: 1, signature: options.input.signature,
      ...(options.input.geometrySignature ? { geometrySignature: options.input.geometrySignature } : {}),
      createdAt: new Date().toISOString(), engineVersion: result.engineVersion, assets, surfaces, probeAssetId: 'probes', statistics: result.statistics };
    await fs.writeFile(path.join(pending, 'manifest.json'), JSON.stringify(snapshot));
    assertActive(options);
    await fs.rename(pending, destination);
    for (const asset of assets) options.authorizeAssetFile(options.decodeAssetUrl(asset.url));
    return snapshot;
  } catch (error) {
    // pending 由本任务在经过 realpath 校验的根下创建，仅清理这一个目录。
    if (inside(assetsRoot, pending) && path.basename(pending).startsWith('.pending-')) await fs.rm(pending, { recursive: true, force: true });
    throw error;
  }
}

export async function runLightingBakeJob(options: LightingBakeServiceOptions): Promise<SceneLightingBakeSnapshot> {
  assertActive(options);
  const preflight = await inspectLightingBakeRequest(options.input, options);
  assertLightingBakePreflight(preflight);
  assertActive(options);
  const project = await fs.realpath(options.projectRoot);
  const assets = await ensureProjectDirectory(project, ['Assets', 'LightingBakes']);
  const task = await createLightingBakeTask(project, options.input, options.engineVersion ?? '', preflight);
  const staging = task.directory, script = path.join(staging, 'cycles_bake.py');
  let lastPersist = 0, lastPhase = '';
  const tracked: LightingBakeServiceOptions = { ...options,
    onDevice: device => { void task.update({ device }); options.onDevice?.(device); },
    onMemory: bytes => { const metrics = task.record.phaseMetrics; const current = metrics?.[metrics.length - 1]; if (current && bytes !== null) current.cyclesPeakRssBytes = Math.max(current.cyclesPeakRssBytes ?? 0, bytes); options.onMemory?.(bytes); },
    onEngineSpawn: pid => { void task.update({ enginePid: pid }); options.onEngineSpawn?.(pid); },
    onProgress: progress => {
      if (progress.phase !== lastPhase || Date.now() - lastPersist >= 250) {
        lastPhase = progress.phase; lastPersist = Date.now();
        const status = progress.phase === 'preparing' || progress.phase === 'applying' ? progress.phase : 'baking';
        void task.update({ status, phase: progress.phase, progress: progress.progress, message: progress.message });
      }
      options.onProgress(progress);
    } };
  try {
    tracked.onProgress({ jobId: options.input.jobId, phase: 'preparing', progress: 0, message: '正在准备材质、纹理和静态几何' });
    await fs.copyFile(fileURLToPath(new URL('../lighting-bake/cycles_bake.py', import.meta.url)), script);
    await prepareInput(tracked, staging); await task.flush();
    let inputBytes = 0;
    for (const name of await fs.readdir(staging)) if (name === 'input.json' || name.startsWith('geometry-input-') || name.startsWith('source-texture-')) inputBytes += (await fs.stat(path.join(staging, name))).size;
    await task.update({ inputBytes });
    try { await runLightingBakeProcess(tracked, staging, script); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'LightingBakeGpuFallbackError') throw error;
      assertActive(options);
      const prepared = JSON.parse(await fs.readFile(path.join(staging, 'input.json'), 'utf8')) as LightingBakeInput;
      prepared.settings.device = 'cpu'; await fs.writeFile(path.join(staging, 'input.json'), JSON.stringify(prepared));
      const reason = 'GPU 显存或设备失败，已重新启动独立 CPU 任务：' + error.message;
      await task.update({ device: { requested: options.input.settings.device ?? 'cpu', actual: 'CPU', name: 'CPU', backend: 'CPU', fallbackReason: reason }, message: reason });
      tracked.onProgress({ jobId: options.input.jobId, phase: 'baking', progress: 0.15, message: reason });
      await runLightingBakeProcess({ ...tracked, logName: 'cycles-cpu.log', onDevice: device => tracked.onDevice?.({ ...device, requested: options.input.settings.device ?? 'cpu', fallbackReason: reason }) }, staging, script);
    }
    await task.flush();
    let expandedGeometryBytes = 0;
    for (const name of await fs.readdir(staging)) if (/^geometry-\d+\.(?:json|bin)$/.test(name)) expandedGeometryBytes += (await fs.stat(path.join(staging, name))).size;
    await task.update({ expandedGeometryBytes });
    assertActive(options);
    tracked.onProgress({ jobId: options.input.jobId, phase: 'applying', progress: 0.97, message: '正在验证并保存独立光照资源' });
    const result = await validateAndPromote(tracked, staging, assets);
    await task.finish('completed', '独立光照资源已生成', result.assets.reduce((sum, asset) => sum + asset.byteLength, 0));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await task.finish(options.signal.aborted ? 'cancelled' : 'error', message); }
    catch (recordError) { throw new AggregateError([error, recordError], '烘焙失败且任务记录未能保存。', { cause: recordError }); }
    throw error;
  }
}
