import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

export const VIEWER_TEMPLATE_CAPABILITIES_PATH = 'viewer-capabilities.json';
const OPENING_TEMPLATE = 'reference-huishan';
const MAX_MANIFEST_BYTES = 64 * 1024;
const REBUILD_HINT = '请更新编辑器安装版后重新发布；开发环境请先运行 npm run build:viewer。';

type TemplateFile = {
  sourcePath: string;
  destinationRelativePath: string;
  size: number;
  expectedSize?: number;
  expectedSha256?: string;
  integrityLabel?: string;
};
type FileIntegrity = { path: string; size: number; sha256: string };
type BuildFile = { path: string; content: string | Uint8Array };
type OpeningBuildAsset = BuildFile & { id: string };
type ViewerTemplateCapabilities = {
  version: 1;
  entryFiles: FileIntegrity[];
  openingAnimation: { template: string; assets: (FileIntegrity & { id: string })[] };
  openingPackages?: { runtimeApiVersion: number; renderers: string[]; isolatedPlayback?: boolean };
};

function invalidManifest(): Error {
  return new Error(`Viewer 模板开场动画能力清单无效或不完整。${REBUILD_HINT}`);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('导出已取消。'), { name: 'AbortError' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIntegrity(value: unknown): value is FileIntegrity {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path
    || value.path.includes('\\') || value.path.includes(':') || value.path.startsWith('/')
    || value.path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}

function validOpeningAsset(value: unknown): value is FileIntegrity & { id: string } {
  return isRecord(value) && typeof value.id === 'string' && /^asset-(?:10|[1-9])$/.test(value.id)
    && validIntegrity(value) && /^assets\/.+\.webp$/.test(value.path);
}

function parseCapabilities(value: unknown): ViewerTemplateCapabilities {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entryFiles)
    || !value.entryFiles.every(validIntegrity) || !value.entryFiles.some(file => file.path === 'index.html')
    || !value.entryFiles.some(file => /^assets\/.+\.js$/.test(file.path))
    || !isRecord(value.openingAnimation) || value.openingAnimation.template !== OPENING_TEMPLATE
    || !Array.isArray(value.openingAnimation.assets) || value.openingAnimation.assets.length !== 10) {
    throw invalidManifest();
  }
  const assets = value.openingAnimation.assets;
  if (!assets.every(validOpeningAsset)
    || new Set(assets.map(asset => asset.id)).size !== 10
    || new Set([...value.entryFiles, ...assets].map(file => file.path)).size !== value.entryFiles.length + 10) {
    throw invalidManifest();
  }
  return value as ViewerTemplateCapabilities;
}

/** 构建时声明模板能力，并把入口与素材绑定到同一批构建输出。 */
export function createViewerTemplateCapabilities(
  entryFiles: readonly BuildFile[],
  openingAssets: readonly OpeningBuildAsset[],
): ViewerTemplateCapabilities {
  const integrity = (file: BuildFile): FileIntegrity => ({
    path: file.path,
    size: typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength,
    sha256: createHash('sha256').update(file.content).digest('hex'),
  });
  return parseCapabilities({
    version: 1,
    entryFiles: entryFiles.map(integrity),
    openingAnimation: {
      template: OPENING_TEMPLATE,
      assets: openingAssets.map(asset => ({ id: asset.id, ...integrity(asset) })),
    },
    openingPackages: { runtimeApiVersion: 1, renderers: ['reference-huishan', 'timeline'], isolatedPlayback: true },
  });
}

/** 只对启用开场的场景要求新能力；普通旧场景仍可沿用旧模板。 */
async function checkTemplate(
  sceneContent: string | null,
  templateFiles: readonly TemplateFile[],
  signal: AbortSignal,
  coreOnly: boolean,
): Promise<void> {
  assertNotAborted(signal);
  let sceneFile: unknown;
  try {
    sceneFile = sceneContent === null ? {} : JSON.parse(sceneContent);
  } catch {
    throw new Error('导出场景不是有效 JSON。');
  }
  const scene = isRecord(sceneFile) && isRecord(sceneFile.scene) ? sceneFile.scene : null;
  const settings = scene && isRecord(scene.sceneSettings) ? scene.sceneSettings : null;
  const opening = settings && isRecord(settings.openingAnimation) ? settings.openingAnimation : null;
  if (!coreOnly && (!opening || opening.enabled !== true)) return;
  if (!coreOnly && opening && opening.template !== undefined && opening.template !== OPENING_TEMPLATE && opening.template !== 'globe-huishan' && opening.template !== 'package') {
    throw new Error(`Viewer 模板不支持场景配置的开场动画。${REBUILD_HINT}`);
  }
  const filesByPath = new Map(templateFiles.map(file => [file.destinationRelativePath, file]));
  const manifestFile = filesByPath.get(VIEWER_TEMPLATE_CAPABILITIES_PATH);
  if (!manifestFile && coreOnly) return;
  if (!manifestFile) throw new Error(`Viewer 模板尚不支持当前开场动画。${REBUILD_HINT}`);
  if (manifestFile.size <= 0 || manifestFile.size > MAX_MANIFEST_BYTES) throw invalidManifest();
  let manifest: ViewerTemplateCapabilities;
  try {
    const content = await fs.readFile(manifestFile.sourcePath, { signal });
    if (content.byteLength > MAX_MANIFEST_BYTES) throw invalidManifest();
    manifest = parseCapabilities(JSON.parse(content.toString('utf8')));
    manifestFile.expectedSize = content.byteLength;
    manifestFile.expectedSha256 = createHash('sha256').update(content).digest('hex');
    manifestFile.integrityLabel = 'Viewer 开场动画能力清单';
  } catch {
    assertNotAborted(signal);
    throw invalidManifest();
  }
  if (!coreOnly && opening?.template === 'package') {
    const binding = isRecord(opening.package) ? opening.package : null;
    const definition = binding && isRecord(binding.definition) ? binding.definition : null;
    const requested = definition && isRecord(definition.manifest) ? definition.manifest : null;
    const support = manifest.openingPackages;
    if (!requested || !support || support.runtimeApiVersion !== 1 || requested.runtimeApiVersion !== support.runtimeApiVersion
      || !Array.isArray(support.renderers) || !support.renderers.includes(String(requested.renderer))) {
      throw new Error(`Viewer 模板不支持此开场插件包的协议或渲染器。${REBUILD_HINT}`);
    }
    if (support.isolatedPlayback !== true) throw new Error(`Viewer 模板不具备开场业务隔离能力，本次不启用开场。${REBUILD_HINT}`);
  }
  for (const expected of [...manifest.entryFiles, ...(!coreOnly && opening?.template !== 'package' ? manifest.openingAnimation.assets : [])]) {
    assertNotAborted(signal);
    const file = filesByPath.get(expected.path);
    if (!file) throw new Error(`Viewer 模板缺少开场动画资源：${expected.path}。${REBUILD_HINT}`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(file.sourcePath, { signal })) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    } catch {
      assertNotAborted(signal);
      throw new Error(`Viewer 模板开场动画资源读取失败：${expected.path}。${REBUILD_HINT}`);
    }
    if (bytes !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new Error(`Viewer 模板开场动画资源不一致：${expected.path}。${REBUILD_HINT}`);
    }
    // 复制时再次校验，避免检查后文件变化造成入口和素材混用。
    file.expectedSize = expected.size;
    file.expectedSha256 = expected.sha256;
    file.integrityLabel = `Viewer 开场动画资源 ${expected.path}`;
  }
}

/** 业务 Viewer 的代码完整性始终严格检查；不能随可选开场一起降级。 */
export function assertViewerCoreIntegrity(files: readonly TemplateFile[], signal: AbortSignal): Promise<void> {
  return checkTemplate(null, files, signal, true);
}
export function assertViewerTemplateSupportsScene(scene: string, files: readonly TemplateFile[], signal: AbortSignal): Promise<void> {
  return checkTemplate(scene, files, signal, false);
}

/** DIST 仅使用已绑定包内素材；模板能力清单与旧内置参考图片是构建期资源。 */
export async function selectRuntimeTemplateFiles<T extends TemplateFile>(files: readonly T[], signal: AbortSignal): Promise<T[]> {
  const source = files.find(file => file.destinationRelativePath === VIEWER_TEMPLATE_CAPABILITIES_PATH);
  if (!source) return [...files];
  assertNotAborted(signal);
  const manifest = parseCapabilities(JSON.parse(await fs.readFile(source.sourcePath, { encoding: 'utf8', signal })));
  const excluded = new Set([VIEWER_TEMPLATE_CAPABILITIES_PATH, ...manifest.openingAnimation.assets.map(asset => asset.path)]);
  return files.filter(file => !excluded.has(file.destinationRelativePath));
}
