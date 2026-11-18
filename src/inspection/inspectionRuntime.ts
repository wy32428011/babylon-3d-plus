import {
  clearDeploymentAssetManifest,
  installDeploymentAssetManifest,
  isLocalEditorAssetUrl,
  resolveRuntimeAssetUrl,
} from '../runtime/assets/editorAssetUrl';
import { fetchRuntimeAsset } from '../runtime/assets/runtimeAssetFetch';
import { readUtf8ResponseText } from '../shared/text/strictUtf8';
import { resolveInspectionModelVersionUrl } from './inspectionModelVersionAsset';
import {
  parseDeploymentAssetManifest,
  parseDigitalTwinAllowedParentOrigins,
  parseDigitalTwinProjectRuntimeConfig,
  parsePlayerRuntimeConfig,
} from '../player/runtimeConfig';

export type InspectionRuntimeContext = {
  projectId?: string;
  allowedParentOrigins: string[];
  resolveAssetUrl: (sourceUrl: string) => string;
  resolveModelVersionUrl: (fileUrl: string) => string;
  dispose: () => void;
};

/** 与场景页一样严格读取部署文件，但每个详情 iframe 独立建立资源映射。 */
export async function initializeInspectionRuntime(signal: AbortSignal): Promise<InspectionRuntimeContext> {
  async function readJson(url: URL): Promise<unknown> {
    const response = await fetchRuntimeAsset(url.href, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`读取 ${url.pathname} 失败：HTTP ${response.status}。`);
    return JSON.parse(await readUtf8ResponseText(response, `文件 ${url.pathname}`)) as unknown;
  }

  const baseConfig = parsePlayerRuntimeConfig(await readJson(new URL('./runtime-config.json', document.baseURI)));
  let allowedParentOrigins: string[] = [];
  if (baseConfig.digitalTwin) {
    const response = await fetch(new URL(baseConfig.digitalTwin.runtimeConfigEndpoint, document.baseURI), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ projectId: baseConfig.digitalTwin.projectId }),
      signal,
    });
    if (!response.ok) throw new Error(`读取项目运行配置失败：HTTP ${response.status}。`);
    const project = parseDigitalTwinProjectRuntimeConfig(JSON.parse(
      await readUtf8ResponseText(response, '项目运行配置响应'),
    ) as unknown);
    if (project.projectId !== baseConfig.digitalTwin.projectId) throw new Error('项目运行配置与部署项目不匹配。');
    if (!project.runtimeEnabled) throw new Error('该数字孪生项目当前已在数据中台停用。');
    allowedParentOrigins = parseDigitalTwinAllowedParentOrigins(project.config);
  }

  const assetBaseUrl = new URL(baseConfig.paths.assetBase, document.baseURI);
  const manifest = await readJson(new URL(baseConfig.paths.assetManifest, document.baseURI));
  const mappings = parseDeploymentAssetManifest(manifest, assetBaseUrl);
  signal.throwIfAborted();
  installDeploymentAssetManifest(mappings);
  const allowedKeys = new Set(Object.keys(mappings).map(manifestKey));
  let disposed = false;

  return {
    projectId: baseConfig.digitalTwin?.projectId,
    allowedParentOrigins,
    resolveModelVersionUrl(fileUrl) {
      if (disposed) throw new Error('详情页资源上下文已关闭。');
      const platformOrigin = new URL(baseConfig.digitalTwin?.runtimeConfigEndpoint ?? document.baseURI, document.baseURI).origin;
      return resolveInspectionModelVersionUrl(fileUrl, platformOrigin);
    },
    resolveAssetUrl(sourceUrl) {
      if (disposed) throw new Error('详情页资源上下文已关闭。');
      if (!isLocalEditorAssetUrl(sourceUrl) || !allowedKeys.has(manifestKey(sourceUrl))) {
        throw new Error('高精度模型不在当前部署资源清单中。');
      }
      const resolved = resolveRuntimeAssetUrl(sourceUrl);
      const url = new URL(resolved, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('高精度模型的部署地址无效。');
      }
      return url.href;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearDeploymentAssetManifest();
    },
  };
}

function manifestKey(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}
