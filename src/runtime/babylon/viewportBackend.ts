import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { ModelAssetTemplate, ModelGeneratorTarget } from '../../editor/model/components';

export type ViewportBackend = 'webgl' | 'webgpu';
export type ViewportBackendDecision = {
  requested: ViewportBackend;
  backend: ViewportBackend;
  reasons: readonly string[];
};

/** 后端选择只作用于本次视口，不写回场景或改变任何画质默认值。 */
export function readRequestedViewportBackend(search = globalThis.location?.search ?? ''): ViewportBackend {
  return new URLSearchParams(search).get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
}

/** 只放行可明确识别的原生 glTF 资产；未知包内脚本不能靠加载后报错来判兼容。 */
function isNativeModel(model: ModelAssetTemplate): boolean {
  return !model.scriptAssets?.length
    && !model.parameterScriptMetadata?.length
    && !model.animationScriptMetadata?.length
    && !model.sourceSnapshot?.composition
    && /\.(?:glb|gltf)(?:$|[?#])/i.test(model.sourcePath || model.sourceUrl);
}

/** Editor 与 Player 共用创建前判定，包含当前未显示但之后可能激活的效果和生成模板。 */
export function resolveViewportBackend(
  document: SceneDocument,
  requested = readRequestedViewportBackend(),
): ViewportBackendDecision {
  if (requested === 'webgl') return { requested, backend: 'webgl', reasons: [] };
  const reasons = new Set<string>();
  const lighting = document.sceneSettings.lighting;
  // 当前 EnvironmentAndSkyboxController 将已启用的阴影统一接入 hybrid 缓存。
  if (lighting.shadows.enabled) reasons.add('混合阴影缓存需要 WebGL');
  if (lighting.bake.enabled && lighting.result) reasons.add('烘焙光照插件及有限 Mip 贴图需要 WebGL');
  if (document.sceneSettings.modelEntrance?.enabled) reasons.add('模型入场材质插件尚未纳入 WebGPU 兼容范围');
  const inspectTarget = (target: ModelGeneratorTarget | null): void => {
    if (target?.kind === 'composition') reasons.add('组合生成模板需要保留完整 WebGL 运行时');
    if (target?.kind === 'model' && !isNativeModel(target.modelAsset)) reasons.add('模型生成模板包含脚本或未确认的资产格式');
  };
  for (const id of document.entityIds) {
    const entity = document.entities[id];
    if (!entity) continue;
    const components = entity.components;
    if (entity.composition) reasons.add('组合资源需要保留完整 WebGL 运行时');
    if (components.poiEffect) reasons.add('POI 特效包含 WebGL 自定义材质路径');
    if (components.alarmManager) reasons.add('告警可能延迟激活自定义材质效果');
    if (components.chartMarker) reasons.add('图表立标尚未纳入 WebGPU 兼容范围');
    if (components.modelAsset && !isNativeModel(components.modelAsset)) reasons.add('模型包含脚本或未确认的资产格式');
    if (components.modelArray) reasons.add('旧版隐藏模型阵列尚未纳入 WebGPU 兼容范围');
    if (components.modelGenerator) {
      inspectTarget(components.modelGenerator.defaultTarget);
      for (const rule of components.modelGenerator.rules) inspectTarget(rule.target);
    }
  }
  return { requested, backend: reasons.size ? 'webgl' : 'webgpu', reasons: [...reasons] };
}
