import { validateSkyboxSourceFile } from './skyboxAssetStore.ts';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectSkyboxEnvironmentBytes, normalizeSkyboxEnvironmentResource, skyboxEnvironmentMatchesSource,
  type SkyboxEnvironmentResource } from '../shared/sceneSkyboxContract.ts';
import { decodeAssetUrl } from './assetRegistry.ts';

export type VerifiedSkyboxEnvironment = { resource: SkyboxEnvironmentResource; sourcePath: string };

/** 旧场景可能把受控 URL 同时写入两个位置字段；不接受远端地址作为本地授权。 */
export function resolveSkyboxLocalPath(sourcePath: unknown, sourceUrl: unknown, decodeUrl = decodeAssetUrl): string {
  if (typeof sourcePath === 'string' && path.isAbsolute(sourcePath)) return sourcePath;
  for (const value of [sourcePath, sourceUrl]) {
    if (typeof value !== 'string' || !value.startsWith('editor-asset://local/')) continue;
    const file = decodeUrl(value);
    if (path.isAbsolute(file)) return file;
  }
  return '';
}

/** 发布和 SOURCE 只接受已授权、与源身份匹配的完整 ENV；绝不现场执行 GPU 转换。 */
export async function verifySkyboxEnvironmentFile(skybox: Record<string, unknown>, signal: AbortSignal,
  isAuthorized: (file: string) => boolean): Promise<VerifiedSkyboxEnvironment> {
  signal.throwIfAborted();
  if (!skybox.environment) throw new Error('天空 ENV 尚未准备，请在新版编辑器中完成资源准备后再发布。');
  const resource = normalizeSkyboxEnvironmentResource(skybox.environment);
  if ((skybox.format !== 'hdr' && skybox.format !== 'exr') || typeof skybox.resolution !== 'number'
    || !skyboxEnvironmentMatchesSource({ resolution: skybox.resolution, assetRevision: typeof skybox.assetRevision === 'string' ? skybox.assetRevision : undefined }, resource)) {
    throw new Error('天空 ENV 与场景源修订或分辨率不一致。');
  }
  const sourcePath = resolveSkyboxLocalPath(resource.sourcePath, resource.sourceUrl);
  if (!path.isAbsolute(sourcePath) || !isAuthorized(sourcePath)) throw new Error('天空 ENV 文件未获得当前工程授权。');
  const before = await fs.lstat(sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== resource.byteLength || !isAuthorized(await fs.realpath(sourcePath))) {
    throw new Error('天空 ENV 路径或大小与产物描述不一致。');
  }
  const hash = createHash('sha256'), chunks: Buffer[] = [];
  let size = 0;
  const stream = createReadStream(sourcePath);
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > resource.byteLength) throw new Error('天空 ENV 文件在读取期间增长。');
      hash.update(chunk); chunks.push(chunk);
    }
  } finally { stream.destroy(); }
  const after = await fs.lstat(sourcePath);
  if (size !== resource.byteLength || hash.digest('hex') !== resource.sha256 || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('天空 ENV 完整性校验失败。');
  inspectSkyboxEnvironmentBytes(Buffer.concat(chunks, size), resource.faceSize);
  if (skybox.sourceAvailable !== false) {
    const original = resolveSkyboxLocalPath(skybox.sourcePath, skybox.sourceUrl);
    if (!path.isAbsolute(original) || !isAuthorized(original) || !isAuthorized(await fs.realpath(original))) throw new Error('天空原图未获得当前工程授权。');
    const inspection = await validateSkyboxSourceFile(original);
    if (inspection.format !== skybox.format) throw new Error('天空源格式与文件内容不一致。');
    const sourceStat = await fs.lstat(original);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 512 * 1024 * 1024) throw new Error('天空原图不是安全的有界普通文件。');
    const sourceHash = createHash('sha256'); let sourceBytes = 0;
    const sourceStream = createReadStream(original);
    try {
      for await (const chunk of sourceStream) {
        signal.throwIfAborted(); sourceBytes += chunk.length;
        if (sourceBytes > sourceStat.size) throw new Error('天空原图读取期间发生变化。');
        sourceHash.update(chunk);
      }
    } finally { sourceStream.destroy(); }
    const checked = await fs.lstat(original);
    if (sourceBytes !== sourceStat.size || sourceStat.ino !== checked.ino || sourceStat.mtimeMs !== checked.mtimeMs
      || sourceHash.digest('hex') !== resource.sourceSha256) throw new Error('天空 ENV 对应的原图内容已变化，请重新准备。');
  }
  signal.throwIfAborted();
  return { resource, sourcePath };
}
