import type { SceneDocument } from '../model/SceneDocument';
import type { ModelAssetTemplate, ModelGeneratorTarget } from '../model/components';

/** 部署工程支持的输出形式。 */
export type DeploymentExportOutputType = 'directory' | 'zip';

/** 渲染进程使用的部署导出生命周期。 */
export type DeploymentExportStatus =
  | 'idle'
  | 'preparing'
  | 'exporting'
  | 'success'
  | 'error'
  | 'canceled';

/** 对当前场景资源引用的轻量摘要，不读取文件内容，避免打开弹窗时产生额外 I/O。 */
export type DeploymentSceneSummary = {
  entityCount: number;
  resourceCount: number;
  modelCount: number;
  environmentCount: number;
  cadCount: number;
  scriptCount: number;
};

/** 归一化后的导出进度，隔离 Electron IPC 字段与 React 展示逻辑。 */
export type DeploymentExportViewProgress = {
  stage: string;
  percent: number;
  message: string;
  currentFile: string | null;
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number | null;
  warnings: string[];
};

/** 归一化后的导出结果。 */
export type DeploymentExportViewResult = {
  outputPath: string;
  fileCount: number;
  totalBytes: number;
  externalAssetCount: number;
  warnings: string[];
};

/** 每次开始导出时保留的轻量上下文，场景正文不会进入 React state。 */
export type DeploymentExportSnapshot = {
  projectName: string;
  outputType: DeploymentExportOutputType;
  summary: DeploymentSceneSummary;
};

const DEPLOYMENT_STAGE_LABELS: Record<string, string> = {
  idle: '等待开始',
  preparing: '准备导出',
  validating: '校验场景',
  'selecting-destination': '选择输出位置',
  preflight: '资源预检',
  collecting: '收集资源',
  'collecting-assets': '收集资源',
  'scanning-assets': '扫描资源',
  'copying-runtime': '复制 Viewer',
  'copying-template': '复制 Viewer',
  'copy-template': '复制 Viewer',
  'copying-viewer': '复制 Viewer',
  'writing-scene': '写入场景',
  'copying-assets': '复制资源',
  'copy-assets': '复制资源',
  'writing-manifest': '生成清单',
  'writing-metadata': '生成清单',
  'write-metadata': '生成清单',
  archiving: '生成 ZIP',
  archive: '生成 ZIP',
  compressing: '生成 ZIP',
  publishing: '发布结果',
  publish: '发布结果',
  finalizing: '完成收尾',
  completed: '导出完成',
  success: '导出完成',
  canceled: '已取消',
  error: '导出失败',
};

/** 将资源路径归一化为稳定集合键，路径缺失时回退到可访问 URL。 */
function createResourceKey(kind: string, sourcePath?: string, sourceUrl?: string): string | null {
  const value = sourcePath?.trim() || sourceUrl?.trim();
  return value ? `${kind}:${value}` : null;
}

/** 把模型模板及其外置脚本登记到场景资源摘要。 */
function registerModelAsset(
  modelAsset: ModelAssetTemplate,
  modelResources: Set<string>,
  scriptResources: Set<string>,
): void {
  const modelKey = createResourceKey('model', modelAsset.sourcePath, modelAsset.sourceUrl);
  if (modelKey) modelResources.add(modelKey);

  for (const scriptAsset of modelAsset.scriptAssets ?? []) {
    const scriptKey = createResourceKey('script', scriptAsset.path, scriptAsset.sourceUrl);
    if (scriptKey) scriptResources.add(scriptKey);
  }
}

/** 把模型生成器目标中的模型模板登记到场景资源摘要。 */
function registerGeneratorTarget(
  target: ModelGeneratorTarget | null,
  modelResources: Set<string>,
  scriptResources: Set<string>,
): void {
  if (target?.kind !== 'model') return;
  registerModelAsset(target.modelAsset, modelResources, scriptResources);
}

/** 统计场景实体及各类唯一资源引用，供导出前确认和结果核对。 */
export function createDeploymentSceneSummary(scene: SceneDocument): DeploymentSceneSummary {
  const modelResources = new Set<string>();
  const environmentResources = new Set<string>();
  const cadResources = new Set<string>();
  const scriptResources = new Set<string>();

  for (const entity of Object.values(scene.entities)) {
    const modelAsset = entity.components.modelAsset;
    if (modelAsset) registerModelAsset(modelAsset, modelResources, scriptResources);

    const cadReference = entity.components.cadReference;
    if (cadReference) {
      const cadKey = createResourceKey('cad', cadReference.sourcePath, cadReference.sourceUrl);
      if (cadKey) cadResources.add(cadKey);
    }

    const modelGenerator = entity.components.modelGenerator;
    if (modelGenerator) {
      registerGeneratorTarget(modelGenerator.defaultTarget, modelResources, scriptResources);
      for (const rule of modelGenerator.rules) {
        registerGeneratorTarget(rule.target, modelResources, scriptResources);
      }
    }
  }

  for (const variant of scene.sceneSettings.environment?.variants ?? []) {
    const environmentKey = createResourceKey('environment', variant.sourcePath, variant.sourceUrl);
    if (environmentKey) environmentResources.add(environmentKey);
  }

  return {
    entityCount: Object.keys(scene.entities).length,
    resourceCount:
      modelResources.size + environmentResources.size + cadResources.size + scriptResources.size,
    modelCount: modelResources.size,
    environmentCount: environmentResources.size,
    cadCount: cadResources.size,
    scriptCount: scriptResources.size,
  };
}

/** 将场景名称转换为导出工程的默认名称，不在前端擅自追加目录后缀。 */
export function createDefaultDeploymentProjectName(sceneName: string): string {
  const trimmedName = sceneName.trim();
  return trimmedName || 'Untitled Scene';
}

/** 校验工程名称，提前拦截 Windows 文件名不支持的字符和尾部空白。 */
export function getDeploymentProjectNameError(projectName: string): string | null {
  const normalizedName = projectName.trim();
  if (!normalizedName) return '请输入工程名称。';
  if (normalizedName.length > 120) return '工程名称不能超过 120 个字符。';
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(normalizedName)) {
    return '工程名称不能包含 < > : " / \\ | ? * 等文件名非法字符。';
  }
  if (/[. ]$/u.test(normalizedName)) return '工程名称不能以空格或句点结尾。';
  return null;
}

/** 将 IPC 阶段代码转换为中文阶段名称，同时兼容 worker 后续新增阶段。 */
export function getDeploymentStageLabel(stage: string, status?: DeploymentExportStatus): string {
  const normalizedStage = stage.trim().toLowerCase();
  if (normalizedStage && DEPLOYMENT_STAGE_LABELS[normalizedStage]) {
    return DEPLOYMENT_STAGE_LABELS[normalizedStage];
  }
  if (stage.trim()) return stage.trim();
  return status ? DEPLOYMENT_STAGE_LABELS[status] ?? status : DEPLOYMENT_STAGE_LABELS.idle;
}

/** 以易读单位格式化字节数，避免大文件统计显示成长整数。 */
export function formatDeploymentByteCount(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 组合当前文件、文件计数和字节计数，供 Toolbar 的紧凑任务条复用。 */
export function createDeploymentToolbarDetail(progress: DeploymentExportViewProgress): string {
  if (progress.currentFile) return progress.currentFile;
  if (progress.totalFiles > 0) {
    return `${progress.completedFiles}/${progress.totalFiles} 个文件 · ${formatDeploymentByteCount(progress.completedBytes)}`;
  }
  return progress.message || getDeploymentStageLabel(progress.stage, 'exporting');
}
