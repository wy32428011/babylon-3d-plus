import { collectSceneSkyboxReferences } from '../shared/sceneResourceTraversal.ts';
import { SKYBOX_ENVIRONMENT_RECIPE } from '../shared/sceneSkyboxContract.ts';
import { CURRENT_SCENE_FILE_VERSION } from '../shared/sceneFileVersion.ts';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { normalizeSceneLightingConfig } from '../shared/sceneLightingConfig.ts';
import { getRequestedLightingLightmapEncoding, getRequestedLightingLightmapMipLevels, getLightingLightmapBaseEncoding, LIGHTING_LIGHTMAP_MIP_RECIPE } from '../shared/sceneLightingTextureCodec.ts';
import { isLightingLightmapMipEncoding } from '../shared/sceneLightingLightmapMips.ts';

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
  sceneFileVersions?: number[];
  skybox?: { resourceVersions: number[]; runtimeFormats: string[]; presentation: 'infinite'; recipes: string[] };
  entryFiles: FileIntegrity[];
  openingAnimation: { template: string; assets: (FileIntegrity & { id: string })[] };
  openingPackages?: { runtimeApiVersion: number; renderers: string[]; isolatedPlayback?: boolean };
  lightingCodecs?: { configVersions: number[]; lightmapEncodings: string[]; mipRecipes?: string[] };
  shadowModes?: string[];
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
  if (value.lightingCodecs !== undefined && (!isRecord(value.lightingCodecs)
    || !Array.isArray(value.lightingCodecs.configVersions) || !value.lightingCodecs.configVersions.every(version => Number.isSafeInteger(version) && version >= 2)
    || !Array.isArray(value.lightingCodecs.lightmapEncodings) || !value.lightingCodecs.lightmapEncodings.every(encoding => typeof encoding === 'string' && /^[a-z0-9-]{1,64}$/.test(encoding))
    || value.lightingCodecs.mipRecipes !== undefined && (!Array.isArray(value.lightingCodecs.mipRecipes) || !value.lightingCodecs.mipRecipes.every(recipe => typeof recipe === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(recipe))))) throw invalidManifest();
  if (value.sceneFileVersions !== undefined && (!Array.isArray(value.sceneFileVersions)
    || !value.sceneFileVersions.every(version => Number.isSafeInteger(version) && version > 0))) throw invalidManifest();
  if (value.shadowModes !== undefined && (!Array.isArray(value.shadowModes)
    || !value.shadowModes.every(mode => typeof mode === 'string' && /^[a-z0-9-]{1,64}$/.test(mode)))) throw invalidManifest();
  if (value.skybox !== undefined && (!isRecord(value.skybox) || value.skybox.presentation !== 'infinite'
    || !Array.isArray(value.skybox.resourceVersions) || !value.skybox.resourceVersions.every(version => Number.isSafeInteger(version) && version > 0)
    || !Array.isArray(value.skybox.runtimeFormats) || !value.skybox.runtimeFormats.every(format => typeof format === 'string')
    || !Array.isArray(value.skybox.recipes) || !value.skybox.recipes.every(recipe => typeof recipe === 'string'))) throw invalidManifest();
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
    sceneFileVersions: [1, 2, 3, 4, 5, 6, CURRENT_SCENE_FILE_VERSION],
    skybox: { resourceVersions: [1], runtimeFormats: ['env'], presentation: 'infinite', recipes: [SKYBOX_ENVIRONMENT_RECIPE] },
    entryFiles: entryFiles.map(integrity),
    openingAnimation: {
      template: OPENING_TEMPLATE,
      assets: openingAssets.map(asset => ({ id: asset.id, ...integrity(asset) })),
    },
    openingPackages: { runtimeApiVersion: 1, renderers: ['reference-huishan', 'timeline', 'prismatic-genesis'], isolatedPlayback: true },
    lightingCodecs: { configVersions: [2, 3], lightmapEncodings: ['rgbm', 'rgbm-gamma', 'rgbm-linear-mips-v1', 'rgbm-gamma-mips-v1'], mipRecipes: [LIGHTING_LIGHTMAP_MIP_RECIPE] },
    shadowModes: ['automatic-v1'],
  });
}

/** 新光照格式与开场分别要求真实模板能力；旧 v2 普通场景仍兼容旧模板。 */
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
  const openingEnabled = opening?.enabled === true;
  const lighting = settings && isRecord(settings.lighting) ? normalizeSceneLightingConfig(settings.lighting) : null;
  const needsLightingCodecs = lighting?.version === 3;
  const needsAutomaticShadows = lighting?.shadows.managementMode === 'automatic';
  const needsSkybox = collectSceneSkyboxReferences(scene).length > 0;
  const sceneVersion = isRecord(sceneFile) && typeof sceneFile.version === 'number' ? sceneFile.version : 0;
  const needsSceneVersion = sceneVersion >= 7;
  if (!coreOnly && !openingEnabled && !needsLightingCodecs && !needsAutomaticShadows && !needsSkybox && !needsSceneVersion) return;
  if (!coreOnly && openingEnabled && opening && opening.template !== undefined && opening.template !== OPENING_TEMPLATE && opening.template !== 'globe-huishan' && opening.template !== 'package') {
    throw new Error(`Viewer 模板不支持场景配置的开场动画。${REBUILD_HINT}`);
  }
  const filesByPath = new Map(templateFiles.map(file => [file.destinationRelativePath, file]));
  const manifestFile = filesByPath.get(VIEWER_TEMPLATE_CAPABILITIES_PATH);
  if (!manifestFile && coreOnly) return;
  if (!manifestFile) throw new Error(`Viewer 模板尚不支持当前${needsSkybox || needsSceneVersion ? '场景版本或天空环境' : needsAutomaticShadows ? '全场景自动阴影' : needsLightingCodecs ? '光照配置或贴图编码' : '开场动画'}。${REBUILD_HINT}`);
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
  if (needsSceneVersion && !manifest.sceneFileVersions?.includes(sceneVersion)) {
    throw new Error(`Viewer 模板不支持场景文件 v${sceneVersion}。${REBUILD_HINT}`);
  }
  if (needsAutomaticShadows && !manifest.shadowModes?.includes('automatic-v1')) {
    throw new Error(`Viewer 模板不支持全场景自动阴影。${REBUILD_HINT}`);
  }
  if (needsSkybox && (!manifest.skybox?.resourceVersions.includes(1) || !manifest.skybox.runtimeFormats.includes('env')
    || manifest.skybox.presentation !== 'infinite' || !manifest.skybox.recipes.includes(SKYBOX_ENVIRONMENT_RECIPE))) {
    throw new Error(`Viewer 模板不支持原生无限远天空或当前 ENV 生成配方。${REBUILD_HINT}`);
  }
  if (needsLightingCodecs && lighting) {
    const base = getRequestedLightingLightmapEncoding(lighting.bake.lightmapEncoding), mipLevels = getRequestedLightingLightmapMipLevels(lighting.bake.lightmapMipLevels);
    const required = [mipLevels ? base === 'rgbm-gamma' ? 'rgbm-gamma-mips-v1' : 'rgbm-linear-mips-v1' : base,
      ...(lighting.result?.assets.filter(asset => asset.kind === 'lightmap').map(asset => isLightingLightmapMipEncoding(asset.encoding) ? asset.encoding : getLightingLightmapBaseEncoding(asset.encoding)) ?? [])];
    if (!manifest.lightingCodecs?.configVersions.includes(lighting.version)
      || required.some(encoding => !manifest.lightingCodecs?.lightmapEncodings.includes(encoding))) {
      throw new Error(`Viewer 模板不支持当前光照配置或贴图编码。${REBUILD_HINT}`);
    }
    if ((mipLevels || lighting.result?.assets.some(asset => isLightingLightmapMipEncoding(asset.encoding))) && !manifest.lightingCodecs.mipRecipes?.includes(LIGHTING_LIGHTMAP_MIP_RECIPE)) throw new Error(`Viewer 模板不支持当前光照mip生产recipe。${REBUILD_HINT}`);
  }
  if (!coreOnly && openingEnabled && opening?.template === 'package') {
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
  for (const expected of [...manifest.entryFiles, ...(!coreOnly && openingEnabled && opening?.template !== 'package' ? manifest.openingAnimation.assets : [])]) {
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
  // 内置天空盒随编辑器分发，发布包只复制场景实际引用的那份资源。
  const runtimeFiles = files.filter(file => !file.destinationRelativePath.startsWith('builtin-skyboxes/')
    && !file.destinationRelativePath.startsWith('builtin-skybox-environments/'));
  const source = runtimeFiles.find(file => file.destinationRelativePath === VIEWER_TEMPLATE_CAPABILITIES_PATH);
  if (!source) return runtimeFiles;
  assertNotAborted(signal);
  const manifest = parseCapabilities(JSON.parse(await fs.readFile(source.sourcePath, { encoding: 'utf8', signal })));
  const excluded = new Set([VIEWER_TEMPLATE_CAPABILITIES_PATH, ...manifest.openingAnimation.assets.map(asset => asset.path)]);
  return runtimeFiles.filter(file => !excluded.has(file.destinationRelativePath));
}
