import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { freemem } from 'node:os';
import path from 'node:path';
import { createLightingBakeTask } from './lightingBakeTaskHistory.ts';
import { validateLightingBakeInput, safeLightingBakeChildPath } from './lightingBakeValidation.ts';
import { decodeLightingBakeTransport } from '../shared/sceneLightingBakeBinary.ts';
import { inspectLightingBakeInput, assertLightingBakePreflight, type LightingBakePreflight } from '../shared/sceneLightingBakePreflight.ts';
import { planLightingProbeVolumes } from '../shared/sceneLightingProbeVolumes.ts';
import { validateLightingPng } from '../shared/sceneLightingBakeArtifacts.ts';
import { getRequestedLightingLightmapMipLevels, getLightingLightmapTextureBytes, LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT } from '../shared/sceneLightingTextureCodec.ts';
import { assertLightingWorkingBytes, lightingBakeResourceBudget, LIGHTING_BAKE_MAX_ASSET_BYTES, type LightingBakeResourceBudget } from '../shared/sceneLightingBakeResources.ts';
import type { LightingBakeHeader, LightingBakePreparedInput, LightingBakeStreamCommand, LightingBakeStreamReply } from '../shared/sceneLightingBakeStream.ts';
import type { LightingBakeServiceOptions } from './lightingBakeService.ts';

type Asset = { id: string; file: string; kind: 'geometry' | 'texture'; size: number; received: number; sha256: string;
  hash: ReturnType<typeof createHash>; handle?: FileHandle; sealed: boolean; used: boolean; decodedBytes?: number };
type Task = Awaited<ReturnType<typeof createLightingBakeTask>>;
type Access = Pick<LightingBakeServiceOptions, 'isAuthorizedAssetFile' | 'decodeAssetUrl' | 'encodeAssetUrl'>;

/** 一个会话同时只写一个4MiB块，磁盘确认后才返回；主进程不累积整场景数值数组。 */
export class LightingBakeUpload {
  readonly input: LightingBakePreparedInput;
  readonly budget: LightingBakeResourceBudget;
  readonly task: Task;
  private readonly assets = new Map<string, Asset>();
  private readonly keys = new Set<string>();
  private readonly reports: LightingBakePreflight[] = [];
  private readonly diskMeshes: object[] = [];
  private bytes = 0;
  private metadataBytes = 0;
  private environmentBytes = 0;
  private busy = false;
  private closed = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private lastActivity = Date.now();
  private constructor(header: LightingBakeHeader, task: Task, private readonly access: Access, private readonly signal: AbortSignal,
    private readonly current: () => boolean) {
    this.input = { ...header, meshes: [] }; this.task = task; this.budget = lightingBakeResourceBudget(freemem());
  }
  static async create(project: string, raw: Extract<LightingBakeStreamCommand, { kind: 'begin' }>, engineVersion: string,
    access: Access, signal: AbortSignal, current: () => boolean): Promise<LightingBakeUpload> {
    const validated = validateLightingBakeInput({ ...raw.header, meshes: [] }, { headerOnly: true });
    if (!raw.preflight || raw.preflight.signature !== validated.signature || !Array.isArray(raw.preflight.issues)
      || JSON.stringify(raw).length > 1024 * 1024) throw new Error('轻量预检与任务不匹配。');
    const { meshes: _meshes, ...header } = validated;
    const task = await createLightingBakeTask(project, header, engineVersion, raw.preflight);
    const upload = new LightingBakeUpload(header, task, access, signal, current);
    await task.update({ phase: 'capture', message: '正在有界捕获几何和材质；尚未启动Blender' });
    return upload;
  }
  get expired(): boolean { return Date.now() - this.lastActivity > 120_000; }
  private check(): void {
    this.signal.throwIfAborted();
    if (this.closed || !this.current()) throw new Error('烘焙捕获会话已结束或工程已切换。');
    if (freemem() < this.budget.reserveBytes) throw new Error('系统可用内存低于烘焙安全余量，已停止继续准备。');
  }
  async command(command: Exclude<LightingBakeStreamCommand, { kind: 'begin' | 'abort' }>): Promise<LightingBakeStreamReply> {
    this.check();
    if (this.busy) throw new Error('烘焙块尚未确认，拒绝并发传输。');
    this.busy = true; this.lastActivity = Date.now();
    const operation = this.execute(command); this.inFlight = operation;
    try { return await operation; } finally { this.busy = false; this.lastActivity = Date.now(); }
  }
  private async execute(command: Exclude<LightingBakeStreamCommand, { kind: 'begin' | 'abort' }>): Promise<LightingBakeStreamReply> {
    if (command.kind === 'asset') {
      if (!['geometry', 'texture'].includes(command.assetKind) || !/^[a-f0-9]{64}$/.test(command.sha256)) throw new Error('烘焙附件类型或摘要无效。');
      assertLightingWorkingBytes(command.byteLength, Math.min(LIGHTING_BAKE_MAX_ASSET_BYTES, this.budget.workingBytes / 3), '单个烘焙附件');
      if (!command.byteLength || this.assets.size >= 100_000 || this.bytes + command.byteLength > this.budget.maxInputBytes) throw new Error('烘焙附件超过任务总预算。');
      const previous = [...this.assets.values()].find(asset => asset.sealed && asset.kind === command.assetKind && asset.sha256 === command.sha256 && asset.size === command.byteLength);
      if (previous) return { assetId: previous.id, sealed: true, ...(previous.kind === 'texture' ? { textureUrl: `lighting-upload://${this.input.jobId}/${previous.id}` } : {}) };
      if ([...this.assets.values()].some(asset => !asset.sealed)) throw new Error('上一个附件尚未完成。');
      const id = `asset-${this.assets.size}`;
      const file = command.assetKind === 'geometry' ? `geometry-input-${this.assets.size}.bin` : `source-texture-${this.assets.size}.png`;
      const handle = await fs.open(safeLightingBakeChildPath(this.task.directory, file), 'wx');
      this.assets.set(id, { id, file, kind: command.assetKind, size: command.byteLength, received: 0, sha256: command.sha256, hash: createHash('sha256'), handle, sealed: false, used: false });
      this.bytes += command.byteLength;
      return { assetId: id };
    }
    if (command.kind === 'chunk') {
      const asset = this.assets.get(command.assetId);
      if (!asset || asset.sealed || !asset.handle || !(command.bytes instanceof Uint8Array) || !command.bytes.byteLength
        || command.bytes.byteLength > this.budget.chunkBytes || command.offset !== asset.received || command.bytes.byteLength > asset.size - asset.received) throw new Error('烘焙数据块顺序、长度或归属无效。');
      let written = 0;
      while (written < command.bytes.byteLength) {
        this.check();
        const result = await asset.handle.write(command.bytes, written, command.bytes.byteLength - written, asset.received + written);
        if (!result.bytesWritten) throw new Error('烘焙暂存写入未推进。');
        written += result.bytesWritten;
      }
      asset.hash.update(command.bytes); asset.received += written;
      return {};
    }
    if (command.kind === 'seal') {
      const asset = this.assets.get(command.assetId);
      if (!asset) throw new Error('烘焙附件不存在。');
      if (!asset.sealed) {
        if (asset.received !== asset.size || asset.hash.digest('hex') !== asset.sha256) throw new Error('烘焙附件长度或摘要不匹配。');
        await asset.handle?.close(); asset.handle = undefined;
        if (asset.kind === 'texture') {
          const dimensions = validateLightingPng(await fs.readFile(safeLightingBakeChildPath(this.task.directory, asset.file)), this.budget.workingBytes / 48);
          asset.decodedBytes = dimensions.width * dimensions.height * 4;
        }
        asset.sealed = true;
      }
      return { assetId: asset.id, ...(asset.kind === 'texture' ? { textureUrl: `lighting-upload://${this.input.jobId}/${asset.id}` } : {}) };
    }
    if (command.kind === 'mesh') {
      const asset = this.assets.get(command.assetId);
      if (!asset?.sealed || asset.kind !== 'geometry' || !command.mesh || this.keys.has(command.mesh.key) || this.keys.size >= 100_000) throw new Error('几何附件或表面身份无效。');
      const metadataSize = JSON.stringify(command.mesh).length * 2;
      if (metadataSize > 65536 || this.metadataBytes + metadataSize > 32 * 1048576) throw new Error('表面元数据超过有界预算。');
      const metadata = structuredClone(command.mesh); this.metadataBytes += metadataSize;
      for (const texture of Object.values(metadata.material?.textures ?? {})) {
        if (!texture) continue;
        const id = texture.url.startsWith(`lighting-upload://${this.input.jobId}/`) ? texture.url.slice(`lighting-upload://${this.input.jobId}/`.length) : '';
        const source = this.assets.get(id);
        if (!source?.sealed || source.kind !== 'texture') throw new Error('纹理不属于当前已完成的捕获会话。');
        source.used = true;
        texture.url = this.access.encodeAssetUrl(path.join(this.task.directory, source.file));
      }
      const buffer = await fs.readFile(safeLightingBakeChildPath(this.task.directory, asset.file));
      // Buffer池可能有偏移；一项预算已预留副本，离开此作用域后不保存数值视图。
      const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      const decoded = decodeLightingBakeTransport({ version: 2, input: { ...this.input, meshes: [metadata] },
        geometry: [{ key: metadata.key, bytes, attributes: command.attributes }] }, { views: true });
      const valid = validateLightingBakeInput(decoded, { typedGeometry: true, allowNonreceiver: true });
      this.check();
      this.reports.push(inspectLightingBakeInput(valid)); this.keys.add(metadata.key); asset.used = true;
      this.input.meshes.push(metadata);
      const disk = structuredClone(metadata) as typeof metadata & { geometryBinary: object };
      for (const texture of Object.values(disk.material.textures ?? {})) if (texture) {
        const file = [...this.assets.values()].find(value => value.kind === 'texture' && this.access.encodeAssetUrl(path.join(this.task.directory, value.file)) === texture.url)?.file;
        if (!file) throw new Error('已校验纹理映射缺失。');
        Object.assign(texture, { file }); texture.url = '';
      }
      disk.geometryBinary = { version: 1, file: asset.file, byteLength: asset.size, attributes: command.attributes };
      this.diskMeshes.push(disk);
      await this.task.update({ phase: 'capture', inputBytes: this.bytes, message: `已捕获 ${this.keys.size} 个表面；最近对象：${metadata.name}` });
      return {};
    }
    if (command.kind === 'finish') {
      if (!this.input.meshes.length || !this.input.meshes.some(mesh => mesh.receiver !== false) || command.signature !== this.input.signature
        || typeof command.geometrySignature !== 'string' || !/^geometry-v1-[a-f0-9]+$/.test(command.geometrySignature)
        || [...this.assets.values()].some(asset => !asset.sealed || !asset.used)) throw new Error('烘焙捕获不完整或签名已变化。');
      this.input.geometrySignature = command.geometrySignature;
      if (command.captureMetrics) {
        validateLightingBakeInput({ ...this.input, meshes: [], captureMetrics: command.captureMetrics }, { headerOnly: true });
        this.input.captureMetrics = command.captureMetrics;
      }
      let preflight = this.preflight(); assertLightingBakePreflight(preflight);
      const disk = { ...this.input, meshes: this.diskMeshes, settings: { ...this.input.settings }, environment: { ...this.input.environment } };
      if (getRequestedLightingLightmapMipLevels(disk.settings.lightmapMipLevels)) Object.assign(disk.settings, { lightmapMipWorkingBytesLimit: LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT });
      if (disk.environment.textureUrl) {
        const original = this.access.decodeAssetUrl(disk.environment.textureUrl);
        if (!this.access.isAuthorizedAssetFile(original)) throw new Error('环境纹理未授权。');
        const actual = await fs.realpath(original), stat = await fs.stat(actual), ext = path.extname(actual).toLowerCase();
        if (!this.access.isAuthorizedAssetFile(actual) || !stat.isFile() || !['.hdr', '.exr'].includes(ext)) throw new Error('环境纹理路径或格式无效。');
        assertLightingWorkingBytes(stat.size, this.input.settings.maxTextureMiB * 1048576 - preflight.sourceTextureBytes!, '环境原图');
        if (this.bytes + stat.size > this.budget.maxInputBytes) throw new Error('环境原图与已捕获附件超过任务总预算。');
        const file = `source-texture-${this.assets.size}${ext}`;
        await fs.copyFile(actual, safeLightingBakeChildPath(this.task.directory, file));
        this.check(); Object.assign(disk.environment, { textureFile: file }); delete disk.environment.textureUrl;
        this.environmentBytes = stat.size;
      }
      preflight = this.preflight(); assertLightingBakePreflight(preflight);
      await fs.writeFile(path.join(this.task.directory, 'input.json'), JSON.stringify(disk), { flag: 'wx', signal: this.signal });
      await this.task.update({ preflight, captureMetrics: command.captureMetrics, phase: 'preparing', message: '有界捕获完成，输入已逐项校验' });
      return {};
    }
    throw new Error('不支持的烘焙捕获命令。');
  }
  preflight(): LightingBakePreflight {
    const first = this.reports[0];
    if (!first) throw new Error('捕获没有几何输入。');
    const result: LightingBakePreflight = { ...first, issues: first.issues.filter(issue => issue.code === 'mip-working-budget'), sourceTextureBytes: 0 };
    delete result.suggestedProbeSpacing;
    for (const key of ['meshCount', 'receiverCount', 'triangleCount', 'vertexCount', 'receiverArea', 'geometryBytes', 'binaryGeometryBytes', 'estimatedInputBytes', 'estimatedDerivedNumericBytes'] as const)
      result[key] = this.reports.reduce((sum, report) => sum + (report[key] ?? 0), 0);
    const low: [number, number, number] = [Infinity, Infinity, Infinity], high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const report of this.reports) for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], report.bounds.min[axis]); high[axis] = Math.max(high[axis], report.bounds.max[axis]); }
    const settings = this.input.settings, probes = planLightingProbeVolumes(settings.probeVolumes, settings.probeSpacing, { min: low, max: high });
    result.bounds = probes.bounds; result.probeCount = probes.count; result.probeCountExact = probes.countExact;
    result.minAtlasCount = Math.max(1, Math.ceil(result.receiverArea * settings.texelsPerMeter ** 2 / settings.atlasSize ** 2));
    result.minTextureBytes = result.minAtlasCount * getLightingLightmapTextureBytes(settings.atlasSize, settings.atlasSize, getRequestedLightingLightmapMipLevels(settings.lightmapMipLevels));
    const textures = [...this.assets.values()].filter(asset => asset.kind === 'texture');
    result.sourceTextureCount = textures.length + (this.environmentBytes ? 1 : 0); result.sourceTextureBytes = textures.reduce((sum, asset) => sum + asset.size, this.environmentBytes);
    result.sourceTextureDecodedBytes = textures.reduce((sum, asset) => sum + (asset.decodedBytes ?? 0), 0);
    result.resourceBudget = this.budget;
    result.backendEstimateBytes = result.geometryBytes * 4 + result.sourceTextureDecodedBytes * 2 + settings.atlasSize ** 2 * 64;
    if (getRequestedLightingLightmapMipLevels(settings.lightmapMipLevels)) {
      result.mipWorkingEstimateBytes = settings.atlasSize ** 2 * 160 + this.reports.reduce((sum, report) => sum + Math.max(0, (report.mipWorkingEstimateBytes ?? 0) - settings.atlasSize ** 2 * 160), 0);
      if (result.mipWorkingEstimateBytes > LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT && !result.issues.some(issue => issue.code === 'mip-working-budget')) result.issues.push({ code: 'mip-working-estimate', severity: 'warning', message: '接收三角形集中到单张图集的Mip临时工作估计超过2GiB；排版后仍逐图集严格复验。' });
    }
    if (this.environmentBytes) result.issues.push({ code: 'environment-memory-unknown', severity: 'warning', message: 'HDR/EXR原图文件字节已计入输入预算；解码后的驻留量未知，后端估计不含该部分，运行时仍监测进程峰值与系统余量。' });
    if (result.probeCount > 4096) result.issues.push({ code: 'probe-limit', severity: 'error', message: '探针超过4096上限。' });
    if (result.minTextureBytes > settings.maxTextureMiB * 1048576 || result.sourceTextureBytes > settings.maxTextureMiB * 1048576) result.issues.push({ code: 'texture-budget', severity: 'error', message: '真实捕获输入或图集面积下界超过纹理预算。' });
    if (result.backendEstimateBytes > lightingBakeResourceBudget(freemem()).backendBytes) result.issues.push({ code: 'backend-memory', severity: 'error', message: '后端输入工作集估计超过系统可用内存预算。' });
    return result;
  }
  async abort(message: string): Promise<void> {
    if (this.closed) return; this.closed = true;
    await this.inFlight.catch(() => undefined);
    const errors: unknown[] = [];
    for (const asset of this.assets.values()) if (asset.handle) { try { await asset.handle.close(); } catch (error) { errors.push(error); } asset.handle = undefined; }
    await this.task.finish(this.signal.aborted ? 'cancelled' : 'error', message);
    if (errors.length) throw new AggregateError(errors, '烘焙暂存句柄关闭失败。');
  }
}
