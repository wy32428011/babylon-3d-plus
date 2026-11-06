import { strToU8, zipSync } from 'fflate';
import expressionSource from './expression.ts?raw';
import geometrySource from './portableGeometry.ts?raw';
import appearanceSource from './portableAppearance.ts?raw';
import { resolveParameterValues, validateProject } from './expression';
import type { AuthoringProject, AuthoringSession, BinaryAsset } from './types';
import { baseName, downloadBytes, glbReferences, objectRecord, originalParameterDefinitions, safeAssetPath, validateSessionAssets } from './io';
import { assetDataUri, findTextureAsset } from './hostBridge';
import { sha256, trustedTemplate } from './templates';

const SCRIPT_NAME = 'parametric-authoring.model.ts';
const RUNTIME_CLASS = 'ParametricModelRuntimeComponent';
const PARAMS_CLASS = 'ParametricModelParamsComponent';
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'node', 'onStart', 'onUpdate', 'onStop', 'assetCode', 'runtimeMode', 'runtimeTelemetry']);
const SCRIPT_LIMIT = 12 * 1024 * 1024;

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('导出数据不是可序列化的 JSON。');
  return serialized.replace(/\b(?:class|import|export)\b/g, word => '\\u' + word.charCodeAt(0).toString(16).padStart(4, '0') + word.slice(1)).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
}
function jsonFile(value: unknown): Uint8Array { return strToU8(json(value)); }

function ensureExportable(project: AuthoringProject): void {
  const issues = [...validateProject(project), ...resolveParameterValues(project.parameters).issues];
  const errors = issues.filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map(issue => issue.message).join('\n'));
  if (!project.source) throw new Error('没有可导出的源模型。');
  if (project.parameters.length > 64) throw new Error('正式宿主最多支持 64 个参数。');
  for (const parameter of project.parameters) {
    if (RESERVED_KEYS.has(parameter.key) || parameter.key.startsWith('__pa')) throw new Error(`参数名与运行时成员冲突：${parameter.key}`);
  }
}

/** 用 TypeScript 自身移除类型与模块边界，不通过正则删除函数体或另写表达式算法。 */
async function portableClosure(source: string, name: string): Promise<string> {
  const ts = await import('typescript');
  const sourceFile = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) throw new Error(`${name} 含有非类型 import，不能独立嵌入。`);
      edits.push({ start: statement.getStart(sourceFile), end: statement.end, text: '' });
    } else if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      throw new Error(`${name} 含不支持的转导出声明。`);
    } else if (ts.canHaveModifiers(statement)) {
      for (const modifier of ts.getModifiers(statement) ?? []) if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) edits.push({ start: modifier.getStart(sourceFile), end: modifier.end, text: '' });
    }
  }
  let local = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) local = local.slice(0, edit.start) + edit.text + local.slice(edit.end);
  const result = ts.transpileModule(local, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  const error = result.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  if (error) throw new Error(`${name} 无法生成：${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return `(() => {\n${result.outputText}\nreturn ${name};\n})()`;
}

function textureMap(session: AuthoringSession): Record<string, string> {
  const textures: Record<string, string> = Object.create(null) as Record<string, string>;
  const ids = new Set([...session.project.textureAssets.map(asset => asset.id), ...session.project.layers.flatMap(layer => layer.textureId ? [layer.textureId] : [])]);
  for (const id of ids) {
    const asset = session.assets.get(id);
    if (!asset || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)) throw new Error(`图像资产不完整或格式不支持：${id}`);
    textures[id] = assetDataUri(asset);
  }
  return textures;
}

export async function generateModelScript(project: AuthoringProject, assets: Map<string, BinaryAsset>): Promise<string> {
  const session = { project, assets };
  await validateSessionAssets(session);
  ensureExportable(project);
  const legacy = await trustedTemplate(project, assets);
  const expression = await portableClosure(expressionSource, 'createExpressionEvaluator');
  const geometry = await portableClosure(geometrySource, 'createAuthoringGeometry');
  const appearance = await portableClosure(appearanceSource, 'createAuthoringAppearance');
  const runtimeProject = structuredClone(project);
  if (runtimeProject.source) {
    runtimeProject.source.originalMeta = {};
    runtimeProject.source.originalModelJson = {};
    runtimeProject.source.scripts = [];
  }
  const textures = textureMap(session);
  const legacyTextureValues: Record<string, Record<string, string>> = {};
  for (const definition of originalParameterDefinitions(project.source!.originalMeta).filter(field => field.type === 'texture')) {
    const key = String(definition.key), parameter = project.parameters.find(item => item.key === key);
    const references = [definition.defaultValue, parameter?.defaultValue, parameter?.value, ...(Array.isArray(definition.options) ? definition.options.map(option => objectRecord(option).value) : [])];
    const mapping: Record<string, string> = Object.create(null);
    for (const reference of references) if (typeof reference === 'string' && reference) {
      const asset = findTextureAsset(session, reference);
      const uri = assetDataUri(asset);
      const extension = asset.mediaType === 'image/png' ? 'png' : asset.mediaType === 'image/jpeg' ? 'jpg' : 'webp';
      mapping[reference] = uri; mapping[`textures/${asset.sha256}.${extension}`] = uri;
    }
    legacyTextureValues[key] = mapping;
  }
  let legacySource = '';
  if (legacy) {
    const ts = await import('typescript');
    const file = ts.createSourceFile('legacy.ts', legacy, ts.ScriptTarget.Latest, true);
    const runtime = file.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === RUNTIME_CLASS);
    if (!runtime || !ts.isClassDeclaration(runtime) || !runtime.name) throw new Error('可信模板缺少运行类声明。');
    const originalKeys = new Set(originalParameterDefinitions(project.source!.originalMeta).map(field => field.key));
    const memberNames = new Set(runtime.members.flatMap(member => member.name && ts.isIdentifier(member.name) ? [member.name.text] : []));
    for (const parameter of project.parameters) if (!originalKeys.has(parameter.key) && memberNames.has(parameter.key)) throw new Error(`新参数与可信模板内部成员冲突：${parameter.key}`);
    legacySource = legacy.slice(0, runtime.name.getStart(file)) + 'LegacyRuntime' + legacy.slice(runtime.name.end);
    if (/\bexport\s+default\b/.test(legacySource)) throw new Error('可信模板含有不支持的默认导出。');
  }
  const script = `// 参数化工作台生成；原模型不可变，运行时共享相同的受限表达式、几何与外观实现。
import * as __paBabylon from '@babylonjs/core';
${legacySource}
const __paRuntime = (() => {
  const createExpressionEvaluator = ${expression};
  const createAuthoringGeometry = ${geometry};
  const createAuthoringAppearance = ${appearance};
  const evaluator = createExpressionEvaluator();
  const recipe = ${json(runtimeProject)};
  const textures = ${json(textures)};
  const legacyTextureValues = ${json(legacyTextureValues)};
  const legacyFilename = ${json(legacy ? project.source!.scripts[0].fileName : null)};
  function syncLegacy(root: any, values: any) {
    if (!legacyFilename) return;
    const scripts = Array.isArray(root.metadata?.scripts) ? root.metadata.scripts.filter((script: any) => script.__authoringLegacy !== recipe.id) : [];
    root.metadata = { ...(root.metadata || {}), scripts: [{ ...values, className: 'ParametricModelParamsComponent', scriptFilename: legacyFilename, values: { ...values }, __authoringLegacy: recipe.id }, ...scripts] };
  }
  function resolve(instance: any) {
    const result = evaluator.resolveParameterValues(recipe.parameters.map((parameter: any) => ({ ...parameter,
      value: Object.prototype.hasOwnProperty.call(instance, parameter.key) ? instance[parameter.key] : parameter.value })));
    for (const [key, mapping] of Object.entries(legacyTextureValues) as [string, Record<string, string>][]) {
      const value = result.values[key];
      if (typeof value !== 'string' || !value) continue;
      const clean = value.split('?')[0];
      const entry = Object.entries(mapping).find(([reference, uri]) => value === reference || value === uri || clean.endsWith('/' + reference) || clean.endsWith(encodeURIComponent('/' + reference)));
      if (entry) result.values[key] = entry[1];
      else result.issues.push({ code: 'TEXTURE_ASSET', severity: 'error', parameterKey: key, message: '纹理参数未包含在导出包中：' + key });
    }
    return result;
  }
  function create(instance: any, root: any, legacyUpdate?: () => void) {
    const geometry = createAuthoringGeometry(__paBabylon, root, { unitScale: recipe.source.unitScale, evaluate: evaluator.evaluateExpression });
    const appearance = createAuthoringAppearance(__paBabylon, root.getScene(), () => geometry.getContext(), {
      evaluate: evaluator.evaluateExpression,
      resolveTexture: (id: string) => { if (!Object.prototype.hasOwnProperty.call(textures, id)) throw new Error('图像资产缺失：' + id); return textures[id]; }
    });
    let requestedSignature = '', revision = 0, stopped = false, running = false;
    let pending: any = null, lastGood: any = null, failed = false;
    function report(status: string, issues: any[], token = revision) {
      if (stopped || token !== revision) return;
      root.metadata = { ...(root.metadata || {}), parametricAuthoring: { status, issues, revision: token } };
    }
    function legacy(values: any) {
      if (!legacyUpdate) return;
      const original = Object.fromEntries(recipe.parameters.map((parameter: any) => [parameter.key, instance[parameter.key]]));
      try {
        Object.assign(instance, values); syncLegacy(root, values); legacyUpdate();
        const diagnostic = Object.entries(root.metadata || {}).find(([key, value]: any) => /parametric.*(?:error|diagnostic)/i.test(key) && value && typeof value.message === 'string');
        if (diagnostic) throw new Error((diagnostic[1] as any).message);
      } finally { Object.assign(instance, original); }
    }
    async function restoreLastGood() {
      appearance.restore();
      if (!lastGood) { geometry.restore(); return; }
      if (legacyUpdate) { geometry.restore(); legacy(lastGood); geometry.rebase(); }
      const recovered = geometry.apply(recipe, lastGood);
      if (!recovered.ok) throw new Error('恢复几何失败：' + recovered.issues.map((issue: any) => issue.message).join('；'));
      const result = await appearance.apply(recipe, lastGood);
      if (!result.ok) throw new Error('恢复外观失败：' + result.issues.map((issue: any) => issue.message).join('；'));
    }
    async function drain() {
      if (running || stopped) return;
      running = true;
      try {
        while (pending && !stopped) {
          const job = pending; pending = null;
          try {
            if (legacyUpdate) { appearance.restore(); geometry.restore(); legacy(job.values); geometry.rebase(); }
            const applied = geometry.apply(recipe, job.values);
            if (!applied.ok) throw new Error(applied.issues.map((issue: any) => issue.message).join('；'));
            const result = await appearance.apply(recipe, job.values);
            if (!result.ok) throw new Error(result.issues.map((issue: any) => issue.message).join('；'));
            lastGood = { ...job.values };
            if (job.token === revision) failed = false;
            report('ready', [...job.issues, ...applied.issues, ...result.issues], job.token);
          } catch (error: any) {
            if (stopped) return;
            let message = error instanceof Error ? error.message : String(error);
            try { await restoreLastGood(); } catch (recovery: any) { message += '；' + String(recovery); }
            if (job.token === revision) failed = true;
            report('error', [{ code: 'PARAMETRIC_APPLY', severity: 'error', message }], job.token);
          }
        }
      } finally { running = false; }
    }
    function update(force = false) {
      if (stopped) return;
      const rawSignature = JSON.stringify(recipe.parameters.map((parameter: any) => Object.prototype.hasOwnProperty.call(instance, parameter.key) ? instance[parameter.key] : parameter.value));
      if (!force && rawSignature === requestedSignature) {
        if (!running && !failed && lastGood) {
          try { legacy(lastGood); appearance.refreshAnchors(); }
          catch (error: any) { failed = true; report('error', [{ code: 'ANCHOR_REFRESH', severity: 'error', message: String(error) }]); }
        }
        return;
      }
      requestedSignature = rawSignature;
      const token = ++revision;
      const resolved = resolve(instance);
      if (resolved.issues.some((issue: any) => issue.severity === 'error')) { pending = null; failed = true; report('error', resolved.issues, token); return; }
      pending = { values: resolved.values, issues: resolved.issues, token };
      report('loading', resolved.issues, token);
      void drain();
    }
    function dispose() {
      if (stopped) return;
      stopped = true; revision++;
      appearance.dispose(); geometry.dispose();
      const metadata = { ...(root.metadata || {}) }; delete metadata.parametricAuthoring;
      if (Array.isArray(metadata.scripts)) metadata.scripts = metadata.scripts.filter((script: any) => script.__authoringLegacy !== recipe.id);
      root.metadata = metadata;
    }
    return { update, dispose };
  }
  return { create, resolve, syncLegacy };
})();
${legacy ? '' : `export class ${PARAMS_CLASS} {\n${project.parameters.map(parameter => `  public ${json(parameter.key)} = ${json(parameter.defaultValue)};`).join('\n')}\n}`}
export class ${RUNTIME_CLASS}${legacy ? ' extends LegacyRuntime' : ''} {
  private __paController: ReturnType<typeof __paRuntime.create> | null = null;
  ${legacy ? '' : 'public constructor(public node: any) {}'}
  public ${legacy ? 'override ' : ''}onStart(): void {
    const resolved = __paRuntime.resolve(this);
    if (resolved.issues.some((issue: any) => issue.severity === 'error')) throw new Error(resolved.issues.map((issue: any) => issue.message).join('；'));
    Object.assign(this, resolved.values);
    __paRuntime.syncLegacy(this.node, resolved.values);
    ${legacy ? 'super.onStart();' : ''}
    this.__paController = __paRuntime.create(this, this.node${legacy ? ', () => super.onUpdate()' : ''});
    this.__paController.update(true);
  }
  public ${legacy ? 'override ' : ''}onUpdate(): void { this.__paController?.update(); }
  public ${legacy ? 'override ' : ''}onStop(): void {
    this.__paController?.dispose(); this.__paController = null;
    ${legacy ? 'super.onStop();' : ''}
  }
}
`;
  if (strToU8(script).length > SCRIPT_LIMIT) throw new Error('生成脚本连同内嵌图片超过 12 MiB；请缩小图片后导出。');
  return script;
}

function mappedParameters(project: AuthoringProject, texturePaths: Map<string, string>): Record<string, unknown>[] {
  const originals = originalParameterDefinitions(project.source!.originalMeta);
  const defaults = resolveParameterValues(project.parameters.map(parameter => ({ ...parameter, value: parameter.defaultValue })));
  if (defaults.issues.some(issue => issue.severity === 'error')) throw new Error(`参数默认值无效：${defaults.issues.map(issue => issue.message).join('；')}`);
  return project.parameters.map(parameter => {
    const original = originals.find(field => field.key === parameter.key);
    const type = original?.type === 'texture' && parameter.type === 'string' ? 'texture' : original?.type === 'enum' && parameter.type === 'string' ? 'enum' : parameter.type;
    const defaultValue = defaults.values[parameter.key];
    const value = type === 'texture' && typeof defaultValue === 'string' && defaultValue ? texturePaths.get(defaultValue) : defaultValue;
    if (type === 'texture' && defaultValue && value === undefined) throw new Error(`纹理参数默认资源缺失：${parameter.key}`);
    const result: Record<string, unknown> = { ...original, key: parameter.key, label: parameter.label, type, defaultValue: value };
    delete result.configuration;
    for (const key of ['unit', 'min', 'max', 'step'] as const) {
      if (parameter[key] !== undefined) result[key] = parameter[key]; else delete result[key];
    }
    if (parameter.type === 'number' && (parameter.unit === 'mm' || parameter.unit === 'cm')) result.unit = 'm';
    if (type === 'texture' && Array.isArray(result.options)) result.options = result.options.map(option => {
      const record = objectRecord(option), path = typeof record.value === 'string' ? texturePaths.get(record.value) : undefined;
      if (!path) throw new Error(`纹理选项资源缺失：${String(record.value)}`);
      return { ...record, value: path };
    });
    return result;
  });
}

export async function createGeneratedArtifacts(session: AuthoringSession): Promise<{
  script: string;
  meta: Record<string, unknown>;
  modelJson: Record<string, unknown>;
  files: Record<string, Uint8Array>;
}> {
  session = structuredClone(session);
  await validateSessionAssets(session);
  ensureExportable(session.project);
  const project = session.project, source = project.source!, model = session.assets.get(source.modelAssetId)!;
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const packageRoot = 'models/0001-authored/';
  const modelDirectory = packageRoot + 'files/model/';
  const modelPath = modelDirectory + safeAssetPath(baseName(source.fileName));
  const sourceDirectory = model.path.slice(0, model.path.lastIndexOf('/') + 1);
  const byPath = new Map([...session.assets.values()].map(asset => [asset.path, asset]));
  files[modelPath] = new Uint8Array(model.bytes);
  for (const reference of glbReferences(model.bytes)) {
    const dependency = byPath.get(sourceDirectory + reference);
    if (!dependency) throw new Error(`源模型依赖丢失：${reference}`);
    files[modelDirectory + reference] = new Uint8Array(dependency.bytes);
  }
  const texturePaths = new Map<string, string>();
  const copyTexture = (asset: BinaryAsset): string => {
    const extension = asset.mediaType === 'image/png' ? 'png' : asset.mediaType === 'image/jpeg' ? 'jpg' : asset.mediaType === 'image/webp' ? 'webp' : null;
    if (!extension) throw new Error(`不支持的图片格式：${asset.mediaType}`);
    const relative = `textures/${asset.sha256}.${extension}`;
    files[modelDirectory + relative] = new Uint8Array(asset.bytes);
    return relative;
  };
  for (const descriptor of project.textureAssets) copyTexture(session.assets.get(descriptor.id)!);
  for (const layer of project.layers) if (layer.textureId) copyTexture(session.assets.get(layer.textureId)!);
  for (const definition of originalParameterDefinitions(source.originalMeta).filter(field => field.type === 'texture')) {
    const parameter = project.parameters.find(item => item.key === definition.key);
    const references = [definition.defaultValue, parameter?.defaultValue, parameter?.value, ...(Array.isArray(definition.options) ? definition.options.map(option => objectRecord(option).value) : [])];
    for (const reference of references) if (typeof reference === 'string' && reference) texturePaths.set(reference, copyTexture(findTextureAsset(session, reference)));
  }
  // 保留未编辑且当前工作台不能表达的原字段（如 vector3），避免元数据降级。
  const definitions = mappedParameters(project, texturePaths);
  const keys = new Set(definitions.map(item => item.key));
  for (const original of originalParameterDefinitions(source.originalMeta)) if (!keys.has(original.key) && !['number', 'boolean', 'color', 'string', 'enum', 'texture'].includes(String(original.type))) definitions.push(structuredClone(original));
  const resolved = resolveParameterValues(project.parameters);
  const values: Record<string, unknown> = { ...objectRecord(source.originalMeta.parameterValues), ...resolved.values };
  for (const definition of definitions) if (definition.type === 'texture' && typeof values[String(definition.key)] === 'string' && values[String(definition.key)]) values[String(definition.key)] = texturePaths.get(String(values[String(definition.key)]));
  const fields: Record<string, unknown>[] = definitions.map(definition => ({ ...definition, configuration: { ...objectRecord(definition.configuration), type: definition.type,
    ...(definition.min !== undefined ? { min: definition.min } : {}), ...(definition.max !== undefined ? { max: definition.max } : {}),
    ...(definition.step !== undefined ? { step: definition.step } : {}), ...(definition.unit !== undefined ? { unit: definition.unit } : {}),
  } }));
  const updateScripts = (input: unknown, className: string): Record<string, unknown>[] => {
    const originals = Array.isArray(input) ? input.map(objectRecord) : [];
    // 未知脚本仅作为 originals 附件保留；活动声明只指向这次生成的唯一运行组件。
    return (originals.length ? originals : [{}]).map(original => {
      const oldFields = Array.isArray(original.fields) ? original.fields.map(objectRecord) : [];
      return { ...original, modelFilename: baseName(modelPath), scriptFilename: SCRIPT_NAME, className,
        fields: fields.map(field => ({ ...oldFields.find(old => old.key === field.key), ...field })), values: { ...objectRecord(original.values), ...values } };
    });
  };
  const originalConfig = objectRecord(source.originalMeta.modelParameters);
  const meta: Record<string, unknown> = {
    ...structuredClone(source.originalMeta), lengthUnit: source.unit,
    // 工作台只执行 portable 规则；旧声明式绑定保存在原资产与 recipe 中，不在宿主二次叠加。
    modelParameters: { ...originalConfig, schema: 'babylon-editor.model-parameters', version: 1, parameters: definitions, bindings: [], rules: [] },
    parameterValues: values, parameterScripts: updateScripts(source.originalMeta.parameterScripts, PARAMS_CLASS), animationScripts: updateScripts(source.originalMeta.animationScripts, RUNTIME_CLASS),
  };
  if (source.originalMeta.parameterConfig) meta.parameterConfig = { ...objectRecord(source.originalMeta.parameterConfig), schema: 'babylon-editor.model-parameters', version: 1, parameters: definitions, bindings: [], rules: [] };
  const script = await generateModelScript(project, session.assets);
  const scriptPath = `${packageRoot}files/scripts/${SCRIPT_NAME}`, metaPath = `${packageRoot}files/meta/meta.json`;
  files[scriptPath] = strToU8(script);
  const modelJson: Record<string, unknown> = {
    ...structuredClone(source.originalModelJson), modelName: project.name, modelType: 'glb', lengthUnit: source.unit,
    fileName: baseName(modelPath), filePath: modelPath, metaFileName: 'meta.json', metaFilePath: metaPath,
    scriptFileName: SCRIPT_NAME, scriptFiles: [{ fileName: SCRIPT_NAME, filePath: scriptPath, sortOrder: 1 }],
  };
  // URL 属于旧服务实例，不应让宿主优先读取失效地址或机器绝对路径。
  for (const key of ['fileUrl', 'metaFileUrl', 'scriptFileUrl', 'thumbnailUrl', 'thumbnailFilePath', 'thumbnailFileName']) delete modelJson[key];
  if (source.thumbnailAssetId) {
    const thumbnail = session.assets.get(source.thumbnailAssetId)!;
    const thumbnailPath = `${packageRoot}files/thumbnail/${safeAssetPath(thumbnail.fileName)}`;
    files[thumbnailPath] = new Uint8Array(thumbnail.bytes);
    modelJson.thumbnailFilePath = thumbnailPath; modelJson.thumbnailFileName = thumbnail.fileName;
    // meta.thumbnail 以主 GLB 目录为基准，和纹理参数相同。
    const relative = `thumbnails/${safeAssetPath(thumbnail.fileName)}`;
    files[modelDirectory + relative] = new Uint8Array(thumbnail.bytes); meta.thumbnail = relative;
  } else delete meta.thumbnail;
  files[metaPath] = jsonFile(meta);
  files[packageRoot + 'model.json'] = jsonFile(modelJson);
  files[packageRoot + 'authoring-recipe.json'] = jsonFile(project);
  files['manifest.json'] = jsonFile({ version: 1, exportedAt: new Date().toISOString(), models: [{ modelName: project.name, modelCode: modelJson.modelCode ?? source.id, folder: packageRoot, modelJson: packageRoot + 'model.json' }] });
  const preserved: Array<{ id: string; sourcePath: string; path: string; sha256: string }> = [];
  let index = 0;
  for (const asset of session.assets.values()) {
    const path = `${packageRoot}originals/${String(++index).padStart(5, '0')}/${safeAssetPath(asset.fileName)}`;
    files[path] = new Uint8Array(asset.bytes);
    preserved.push({ id: asset.id, sourcePath: asset.path, path, sha256: asset.sha256 });
  }
  files[packageRoot + 'originals/assets.json'] = jsonFile({ assets: preserved });
  const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, bytes] of Object.entries(files)) hashes[path] = await sha256(bytes);
  files['integrity.json'] = jsonFile({ schema: 'zending.model-integrity', version: 1, files: hashes });
  return { script, meta, modelJson, files };
}

export async function exportModelPackage(session: AuthoringSession): Promise<void> {
  const artifacts = await createGeneratedArtifacts(session);
  if (Object.values(artifacts.files).reduce((sum, bytes) => sum + bytes.length, 0) > 512 * 1024 * 1024) throw new Error('模型包解压尺寸超过 512 MiB 上限。');
  const bytes = zipSync(artifacts.files, { level: 6 });
  if (bytes.length > 256 * 1024 * 1024) throw new Error('模型 ZIP 超过 256 MiB 上限，请缩小资产。');
  downloadBytes(bytes, `${session.project.name}.model.zip`, 'application/zip');
}
