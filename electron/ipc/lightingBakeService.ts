import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { LightingBakeAsset, LightingBakeEngineStatus, LightingBakeInput, LightingBakeProgress, SceneLightingBakeSnapshot } from '../shared/sceneLightingBakeContract.js';
import { matchLightingBakeSurfaceSources, safeLightingBakeChildPath } from './lightingBakeValidation.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SOURCE_TEXTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.hdr', '.exr']);
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
};

/** 路径由本机配置或安装目录发现，场景文档不能提供可执行文件。 */
export async function findLightingBakeEngine(userDataDirectory: string): Promise<LightingBakeEngineStatus> {
  const candidates: string[] = [];
  if (process.env.BABYLON_BLENDER_PATH) candidates.push(process.env.BABYLON_BLENDER_PATH);
  try {
    const config = JSON.parse(await fs.readFile(path.join(userDataDirectory, 'lighting-bake-engine.json'), 'utf8')) as { blenderPath?: unknown };
    if (typeof config.blenderPath === 'string') candidates.push(config.blenderPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) return { available: false, message: '本机 lighting-bake-engine.json 配置不可读取或格式错误。' };
  }
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation');
    try {
      const names = (await fs.readdir(base)).filter(name => /^Blender \d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of names) candidates.push(path.join(base, name, 'blender.exe'));
    } catch { /* 未安装时由状态接口给出说明。 */ }
  } else candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender');
  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate) || !/^blender(?:\.exe)?$/i.test(path.basename(candidate))) continue;
    try { if (!(await fs.stat(candidate)).isFile()) continue; } catch { continue; }
    let status = engineVersionCache.get(candidate);
    if (!status) {
      status = new Promise(resolve => {
        let output = '', finished = false;
        const child = spawn(candidate, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const finish = (result: LightingBakeEngineStatus) => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { child.kill(); finish({ available: false, message: 'Blender 版本检测超时。' }); }, 10_000);
        child.stdout.on('data', chunk => { if (output.length < 4096) output += String(chunk); });
        child.stderr.resume();
        child.on('error', () => finish({ available: false, message: '无法启动本机 Blender。' }));
        child.on('close', code => {
          const version = /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(output)?.[1];
          finish(code === 0 && version && Number(version.split('.')[0]) >= 4
            ? { available: true, path: candidate, version }
            : { available: false, message: '光照烘焙需要 Blender 4 或更新版本。' });
        });
      });
      engineVersionCache.set(candidate, status);
    }
    const result = await status;
    if (result.available) return result;
    engineVersionCache.delete(candidate);
  }
  return { available: false, message: '未找到可用 Blender。请安装 Blender 4+，或在本机 lighting-bake-engine.json 设置 blenderPath。' };
}

function assertActive(options: LightingBakeServiceOptions): void {
  if (options.signal.aborted) throw new Error('光照烘焙已取消。');
  if (!options.isProjectCurrent()) throw new Error('项目已经切换，已停止原项目的光照烘焙。');
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertPng(bytes: Buffer, maxPixels: number): void {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > maxPixels) {
    throw new Error('烘焙 PNG 纹理无效或超过纹理内存预算。');
  }
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
  const request = structuredClone(options.input) as LightingBakeInput & { environment: { textureFile?: string } };
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
      bytes = await fs.readFile(actual);
      if (extension === '.png') assertPng(bytes, budget / 4);
    }
    preparedBytes += bytes.length;
    if (preparedBytes > budget) throw new Error('烘焙输入纹理总量超过预算。');
    const name = `source-texture-${sources.size}${extension}`;
    await fs.writeFile(safeLightingBakeChildPath(directory, name), bytes, { flag: 'wx' });
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

/** 只启动受控脚本；取消只作用于该任务直接创建的子进程。 */
export async function runLightingBakeProcess(options: LightingBakeServiceOptions, directory: string, script: string): Promise<void> {
  assertActive(options);
  await new Promise<void>((resolve, reject) => {
    const log = createWriteStream(path.join(directory, 'cycles.log'), { flags: 'wx' });
    let errorMessage = '', settled = false, terminationError: Error | null = null;
    const child = spawn(options.enginePath, ['--background', '--factory-startup', '--disable-autoexec',
      '--python-exit-code', '1', '--python', script, '--', '--input', path.join(directory, 'input.json')],
    { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
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
        if (line.startsWith('LIGHTING_BAKE_ERROR ')) errorMessage = line.slice(20);
        if (!line.startsWith('LIGHTING_BAKE_PROGRESS ')) continue;
        try {
          const value = JSON.parse(line.slice('LIGHTING_BAKE_PROGRESS '.length)) as { phase: string; completed: number; total: number; message: string };
          if (Number.isFinite(value.completed) && Number.isFinite(value.total) && typeof value.message === 'string') {
            const ratio = Math.max(0, Math.min(1, value.completed / Math.max(1, value.total)));
            const progress = value.phase === 'unwrap' ? ratio * 0.15 : value.phase === 'probes' ? 0.75 + ratio * 0.2 : value.phase === 'completed' ? 0.96 : 0.15 + ratio * 0.6;
            options.onProgress({ jobId: options.input.jobId, phase: 'baking', progress, message: value.message });
          }
        } catch { /* 其余 Cycles 输出只进入日志，不执行其中内容。 */ }
      }
      };
    };
    child.stdout.on('data', createConsumer()); child.stderr.on('data', createConsumer());
    child.on('error', error => finish(new Error(`Blender 启动失败：${error.message}`)));
    child.on('close', code => finish(terminationError ?? (code === 0 ? undefined : new Error(errorMessage || `Blender 烘焙失败（退出码 ${code}），请查看任务日志。`))));
  });
}

type EngineResult = {
  version: number; signature: string; engineVersion: string;
  atlases: Array<{ file: string; width: number; height: number; rgbmRange: number }>;
  meshes: Array<{ key: string; entityId: string; nodeKey: string; geometryFile: string; atlasIndex: number }>;
  probesFile: string; statistics: SceneLightingBakeSnapshot['statistics'];
};

async function validateAndPromote(options: LightingBakeServiceOptions, staging: string, assetsRoot: string): Promise<SceneLightingBakeSnapshot> {
  const result = JSON.parse(await fs.readFile(path.join(staging, 'result.json'), 'utf8')) as EngineResult;
  if (result.version !== 1 || result.signature !== options.input.signature || !Array.isArray(result.atlases)
    || !Array.isArray(result.meshes)) throw new Error('烘焙结果与场景输入不匹配。');
  const sourceMeshes = matchLightingBakeSurfaceSources(options.input.meshes, result.meshes);
  const textureBytes = result.atlases.length * options.input.settings.atlasSize ** 2 * 4;
  if (textureBytes > options.input.settings.maxTextureMiB * 1048576) throw new Error('光照图集超过当前纹理预算，候选结果未提交。');
  const folderName = `${options.input.jobId}-${randomUUID()}`;
  const pending = path.join(assetsRoot, `.pending-${folderName}`), destination = path.join(assetsRoot, folderName);
  await fs.mkdir(pending);
  const assets: LightingBakeAsset[] = [];
  const copyOutput = async (name: string, kind: LightingBakeAsset['kind'], id: string, rgbmRange?: number) => {
    const source = safeLightingBakeChildPath(staging, name);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('烘焙产物不是有效文件。');
    const bytes = await fs.readFile(source);
    if (kind === 'lightmap') assertPng(bytes, options.input.settings.atlasSize ** 2);
    else {
      const data = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (data.version !== 1) throw new Error('烘焙产物版本不正确。');
      if (kind === 'geometry') {
        for (const field of ['positions', 'normals', 'indices', 'uvs', 'bakeUvs']) if (!Array.isArray(data[field]) || (data[field] as unknown[]).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('烘焙几何数据不完整。');
        const length = (data.positions as number[]).length;
        if (length % 3 || (data.normals as number[]).length !== length || (data.bakeUvs as number[]).length !== length / 3 * 2) throw new Error('烘焙几何的坐标长度不一致。');
      } else if (data.encoding !== 'ambient-cube' || !Array.isArray(data.probes) || !data.probes.length
        || data.probes.some(probe => !Array.isArray(probe.position) || probe.position.length !== 3 || !Array.isArray(probe.irradiance) || probe.irradiance.length !== 18
          || [...probe.position, ...probe.irradiance].some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('间接光探针数据不完整。');
    }
    await fs.writeFile(safeLightingBakeChildPath(pending, name), bytes, { flag: 'wx' });
    assets.push({ id, kind, url: options.encodeAssetUrl(path.join(destination, name)), byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...(rgbmRange !== undefined ? { rgbmRange } : {}) });
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
      await copyOutput(mesh.geometryFile, 'geometry', `geometry-${index}`);
      surfaces.push({ key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, geometryAssetId: `geometry-${index}`, lightmapAssetId: `lightmap-${mesh.atlasIndex}` });
    }
    await copyOutput(result.probesFile, 'probes', 'probes');
    for (const key of ['meshCount', 'triangleCount', 'atlasCount', 'probeCount', 'textureBytes', 'durationMs'] as const) if (!Number.isFinite(result.statistics[key]) || result.statistics[key] < 0) throw new Error('烘焙统计数据不正确。');
    if (result.statistics.atlasCount !== result.atlases.length || result.statistics.textureBytes !== textureBytes) throw new Error('烘焙统计与实际图集不一致。');
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
  const project = await fs.realpath(options.projectRoot);
  const tasks = await ensureProjectDirectory(project, ['.babylon-editor', 'lighting-bake-jobs']);
  const assets = await ensureProjectDirectory(project, ['Assets', 'LightingBakes']);
  const staging = await fs.mkdtemp(path.join(tasks, `${options.input.jobId}-`));
  const script = path.join(staging, 'cycles_bake.py');
  try {
    options.onProgress({ jobId: options.input.jobId, phase: 'preparing', progress: 0, message: '正在准备材质、纹理和静态几何' });
    await fs.copyFile(fileURLToPath(new URL('../lighting-bake/cycles_bake.py', import.meta.url)), script);
    await prepareInput(options, staging);
    await runLightingBakeProcess(options, staging, script);
    assertActive(options);
    options.onProgress({ jobId: options.input.jobId, phase: 'applying', progress: 0.97, message: '正在验证并保存独立光照资源' });
    const result = await validateAndPromote(options, staging, assets);
    await fs.writeFile(path.join(staging, 'task.json'), JSON.stringify({ jobId: options.input.jobId, status: 'completed', signature: result.signature, createdAt: result.createdAt }));
    return result;
  } catch (error) {
    await fs.writeFile(path.join(staging, 'task.json'), JSON.stringify({ jobId: options.input.jobId, status: options.signal.aborted ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}
