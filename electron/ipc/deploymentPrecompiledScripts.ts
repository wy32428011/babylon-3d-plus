import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  resolveDeploymentDestination,
  throwIfDeploymentExportAborted,
  toLocalPathKey,
  type DeploymentCopiedFile,
} from './deploymentExportFileSystem.js';

/** 预检阶段绑定原始 TS 字节的派生运行产物；源码仍按普通资源独立复制与校验。 */
export type PrecompiledDeploymentScript = {
  sourcePath: string;
  sourceFileSha256: string;
  destinationRelativePath: string;
  logicalUrl: string;
  content: string;
};

/** 仅为已通过最终复制完整性校验的 TS 写入 sidecar，并返回可并入资产清单的真实字节信息。 */
export async function writePrecompiledDeploymentScripts(
  stagingRoot: string,
  scripts: readonly PrecompiledDeploymentScript[],
  copiedAssets: readonly DeploymentCopiedFile[],
  signal: AbortSignal,
): Promise<DeploymentCopiedFile[]> {
  throwIfDeploymentExportAborted(signal);
  if (scripts.length === 0) return [];
  const sources = new Map<string, DeploymentCopiedFile[]>();
  const occupiedDestinations = new Set<string>();
  const occupiedUrls = new Set<string>();
  for (const file of copiedAssets) {
    const key = toLocalPathKey(file.sourcePath);
    const entries = sources.get(key) ?? [];
    entries.push(file);
    sources.set(key, entries);
    occupiedDestinations.add(toLocalPathKey(resolveDeploymentDestination(stagingRoot, file.destinationRelativePath)));
    if (file.logicalUrl) occupiedUrls.add(file.logicalUrl);
  }

  const plans = new Map<string, { script: PrecompiledDeploymentScript; source: DeploymentCopiedFile; destination: string }>();
  const plannedUrls = new Set<string>();
  // 先检查整组计划，避免路径冲突或源码变化时留下部分派生产物。
  for (const script of scripts) {
    throwIfDeploymentExportAborted(signal);
    const candidates = sources.get(toLocalPathKey(script.sourcePath));
    if (!candidates?.length) throw new Error('预转译源码未列入已复制资源。');
    const source = candidates.find(file => script.destinationRelativePath === `${file.destinationRelativePath}.compiled.json`
      && typeof file.logicalUrl === 'string' && script.logicalUrl === `${file.logicalUrl}.compiled.json`);
    if (!source || !/\.ts$/i.test(source.destinationRelativePath)) throw new Error('预转译产物路径或 logicalUrl 与已复制 TS 源码不匹配。');
    if (!/^[a-f0-9]{64}$/.test(script.sourceFileSha256) || source.sha256 !== script.sourceFileSha256) {
      throw new Error('预转译源码 SHA-256 与最终复制字节不一致。');
    }
    const destination = resolveDeploymentDestination(stagingRoot, script.destinationRelativePath);
    const destinationKey = toLocalPathKey(destination);
    if (occupiedDestinations.has(destinationKey) || occupiedUrls.has(script.logicalUrl)) throw new Error('预转译产物与现有部署资源冲突。');
    const previous = plans.get(destinationKey);
    if (previous) {
      if (toLocalPathKey(previous.script.sourcePath) !== toLocalPathKey(script.sourcePath)
        || previous.script.sourceFileSha256 !== script.sourceFileSha256
        || previous.script.destinationRelativePath !== script.destinationRelativePath
        || previous.script.logicalUrl !== script.logicalUrl || previous.script.content !== script.content) {
        throw new Error('预转译产物重复但内容或来源冲突。');
      }
      continue;
    }
    if (plannedUrls.has(script.logicalUrl)) throw new Error('预转译产物 logicalUrl 冲突。');
    plannedUrls.add(script.logicalUrl);
    plans.set(destinationKey, { script, source, destination });
  }

  const written: DeploymentCopiedFile[] = [];
  for (const { script, source, destination } of plans.values()) {
    throwIfDeploymentExportAborted(signal);
    const bytes = Buffer.from(script.content, 'utf8');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx', signal });
    const stat = await fs.stat(destination);
    throwIfDeploymentExportAborted(signal);
    if (stat.size !== bytes.byteLength) throw new Error('预转译产物最终字节数与写入内容不一致。');
    written.push({
      sourcePath: destination,
      relativePath: `${source.relativePath}.compiled.json`,
      destinationRelativePath: script.destinationRelativePath,
      logicalUrl: script.logicalUrl,
      kind: 'script',
      size: bytes.byteLength,
      mtimeMs: stat.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return written;
}
