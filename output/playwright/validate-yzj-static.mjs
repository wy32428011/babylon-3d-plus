import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = path.resolve(process.cwd());
const modelRoot = path.resolve(process.env.BABYLON_MODEL_ROOT ?? "C:/Users/WY/Desktop/models");
const sourcePackage = path.join(modelRoot, "YZJ");
const assetPackage = path.join(modelRoot, "Assets", "Models", "YZJ");
const fixturePackage = path.join(projectRoot, "output", "playwright", "yzj-assets");
const files = {
  sourceScript: path.join(sourcePackage, "yzj.model.ts"),
  assetScript: path.join(assetPackage, "yzj.model.ts"),
  fixtureScript: path.join(fixturePackage, "yzj.model.ts"),
  fixtureScriptText: path.join(fixturePackage, "yzj.model.txt"),
  sourceMeta: path.join(sourcePackage, "meta.json"),
  assetMeta: path.join(assetPackage, "meta.json"),
  fixtureMeta: path.join(fixturePackage, "meta.json"),
  sceneRuntime: path.join(projectRoot, "src", "runtime", "babylon", "SceneRuntime.ts"),
  externalScriptRuntime: path.join(projectRoot, "src", "runtime", "babylon", "ExternalModelScriptRuntime.ts"),
  modelTextureAssetUrl: path.join(projectRoot, "src", "runtime", "assets", "modelTextureAssetUrl.ts"),
  imageAssets: path.join(projectRoot, "src", "assets", "imageAssets.ts"),
  textureReferences: path.join(projectRoot, "src", "editor", "model", "textureReferences.ts"),
  assetDatabase: path.join(projectRoot, "src", "editor", "assets", "AssetDatabase.ts"),
  projectPanel: path.join(projectRoot, "src", "editor", "panels", "ProjectPanel.tsx"),
  modelParametersInspector: path.join(projectRoot, "src", "editor", "panels", "ModelParametersInspector.tsx"),
  modelParameters: path.join(projectRoot, "src", "editor", "model", "modelParameters.ts"),
  directionArrowPng: path.join(projectRoot, "src", "assets", "images", "direction-arrow-glow.png"),
  sourceGlb: path.join(sourcePackage, "YZJ.glb"),
  assetGlb: path.join(assetPackage, "YZJ.glb"),
  fixtureGlb: path.join(fixturePackage, "YZJ.glb"),
};

const EXPECTED_GLB_HASH = "5c400bb95afa24a035662e30ba21bca76cf5f7723fa6aceabe23aaee3c951ccb";
const DIRECTION_ARROW_REFERENCE = "editor-image://builtin/direction-arrow-glow";
const IMAGE_ASSET_DRAG_MIME_TYPE = "application/x-babylon-editor-image-asset";
const EXPECTED_PARAMETER_KEYS = [
  "length", "width", "height", "bodyColor", "rollerFramePosition", "rollerFrameLength", "motorPosition", "rollerDensity",
  "showLegA", "showLegB", "showMotor", "rollerSkin", "directionArrowImage",
];
const NUMBER_PARAMETER_KEYS = ["length", "width", "height", "rollerFramePosition", "rollerFrameLength", "motorPosition", "rollerDensity"];
const BOOLEAN_PARAMETER_KEYS = ["showLegA", "showLegB", "showMotor", "rollerSkin"];

/** 计算文件 SHA256，用于验证源包、项目副本和视觉夹具完全一致。 */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 返回模型参数定义，缺失时返回 undefined。 */
function findModelParameter(meta, key) {
  return meta.modelParameters?.parameters?.find((field) => field.key === key);
}

/** 返回参数脚本字段定义，缺失时返回 undefined。 */
function findScriptParameterField(meta, key) {
  return meta.parameterScripts?.flatMap((script) => script.fields ?? []).find((field) => field.key === key);
}

/** 返回参数脚本 values 中保存的参数定义，缺失时返回 undefined。 */
function findScriptParameterValue(meta, key) {
  for (const script of meta.parameterScripts ?? []) {
    const value = script.values?.[key];
    if (value) return value;
  }
  return undefined;
}

/** 使用 JSON 序列化比较多份参数契约。 */
function isSameJsonValue(values) {
  return new Set(values.map((item) => JSON.stringify(item))).size === 1;
}

/** 校验 number 参数在 fields、values 和 modelParameters 中保持一致。 */
function validateNumberParameterContract(meta, key) {
  const field = findScriptParameterField(meta, key);
  const value = findScriptParameterValue(meta, key);
  const modelParameter = findModelParameter(meta, key);
  if (!field || !value || !modelParameter) return ["number parameter contract missing: " + key];
  const contracts = [
    { source: "parameterScripts.fields", type: field.type, defaultValue: field.defaultValue, min: field.configuration?.min, max: field.configuration?.max, step: field.configuration?.step },
    { source: "parameterScripts.values", type: value.type, defaultValue: value.value, min: value.configuration?.min, max: value.configuration?.max, step: value.configuration?.step },
    { source: "modelParameters.parameters", type: modelParameter.type, defaultValue: modelParameter.defaultValue, min: modelParameter.min, max: modelParameter.max, step: modelParameter.step },
  ];
  return ["type", "defaultValue", "min", "max", "step"].flatMap((property) => {
    const values = contracts.map((contract) => contract[property]);
    if (isSameJsonValue(values)) return [];
    return ["number parameter contract mismatch: " + key + "." + property + " => " + contracts.map((contract) => contract.source + "=" + contract[property]).join(", ")];
  });
}

/** 校验 boolean 参数在三套契约中使用同一类型和默认值。 */
function validateBooleanParameterContract(meta, key) {
  const field = findScriptParameterField(meta, key);
  const value = findScriptParameterValue(meta, key);
  const modelParameter = findModelParameter(meta, key);
  if (!field || !value || !modelParameter) return ["boolean parameter contract missing: " + key];
  const failures = [];
  if (field.type !== "boolean" || value.type !== "boolean" || modelParameter.type !== "boolean") failures.push("boolean parameter type mismatch: " + key);
  if (field.configuration?.type !== "boolean" || value.configuration?.type !== "boolean") failures.push("boolean parameter configuration mismatch: " + key);
  if (!isSameJsonValue([field.defaultValue, value.value, modelParameter.defaultValue])) failures.push("boolean parameter default mismatch: " + key);
  return failures;
}

/** 校验入/出料侧与 MQTT 前/后端枚举的默认值及四侧选项。 */
function validateSideParameterContract(meta, key) {
  const field = findScriptParameterField(meta, key);
  const value = findScriptParameterValue(meta, key);
  const modelParameter = findModelParameter(meta, key);
  if (!field || !value || !modelParameter) return ["side parameter contract missing: " + key];
  const failures = [];
  if (field.type !== "string" || value.type !== "string" || modelParameter.type !== "enum") failures.push("side parameter type mismatch: " + key);
  if (field.configuration?.type !== "string" || value.configuration?.type !== "string") failures.push("side parameter configuration mismatch: " + key);
  if (!isSameJsonValue([field.defaultValue, value.value, modelParameter.defaultValue])) failures.push("side parameter default mismatch: " + key);
  if (!isSameJsonValue([field.configuration?.options, value.configuration?.options, modelParameter.options])) failures.push("side parameter options mismatch: " + key);
  return failures;
}

/** 校验方向箭头贴图在脚本字段中保持 string，在模型参数中使用 texture。 */
function validateDirectionArrowTextureContract(meta) {
  const field = findScriptParameterField(meta, "directionArrowImage");
  const value = findScriptParameterValue(meta, "directionArrowImage");
  const modelParameter = findModelParameter(meta, "directionArrowImage");
  if (!field || !value || !modelParameter) return ["direction arrow texture contract missing"];

  const failures = [];
  if (field.type !== "string" || value.type !== "string" || modelParameter.type !== "texture") failures.push("direction arrow texture type mismatch");
  if (field.configuration?.type !== "string" || value.configuration?.type !== "string") failures.push("direction arrow texture script configuration mismatch");
  if (!isSameJsonValue([field.defaultValue, value.value, modelParameter.defaultValue])) failures.push("direction arrow texture default mismatch");
  if (modelParameter.defaultValue !== DIRECTION_ARROW_REFERENCE) failures.push("direction arrow texture logical reference mismatch");
  return failures;
}

/** 把 TypeScript 转译诊断转换为稳定单行文本。 */
function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}


/** 在 TypeScript AST 中查找指定名称的方法声明。 */
function findMethodDeclaration(sourceFile, methodName) {
  let matchedMethod;
  const visit = (node) => {
    if (!matchedMethod && ts.isMethodDeclaration(node) && node.name?.getText(sourceFile) === methodName) {
      matchedMethod = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matchedMethod;
}

/** 判断方法体内是否真实调用指定的 this 方法，并可约束参数文本。 */
function hasThisMethodCall(sourceFile, method, calledMethodName, expectedArguments) {
  let matched = false;
  const visit = (node) => {
    if (matched) return;
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.expression.name.text === calledMethodName) {
      const actualArguments = node.arguments.map((argument) => argument.getText(sourceFile));
      if (!expectedArguments || JSON.stringify(actualArguments) === JSON.stringify(expectedArguments)) matched = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(method);
  return matched;
}

/** 检查主体方法没有把 lengthRatio 重新接入节点整体缩放路径。 */
function hasForbiddenBodyLengthScale(sourceFile, method) {
  let matched = false;
  const visit = (node) => {
    if (matched) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const argumentsText = node.arguments.map((argument) => argument.getText(sourceFile));
      if (/^scale/i.test(methodName) && argumentsText[0] === "body" && argumentsText.slice(1).includes("lengthRatio")) matched = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(method);
  return matched;
}

/** 编译不依赖外部状态的数值方法，以真实执行结果验证锚点语义。 */
function compilePureNumberMethod(sourceFile, method) {
  if (!method?.body) return undefined;
  const parameterNames = method.parameters.map((parameter) => parameter.name.getText(sourceFile));
  if (parameterNames.some((name) => !/^[A-Za-z_$][\w$]*$/.test(name))) return undefined;
  const bodyText = method.body.statements.map((statement) => statement.getText(sourceFile)).join("\n");
  return Function(...parameterNames, `"use strict";\n${bodyText}`);
}

/** 用 AST 调用链与数值样例共同验证“固定左侧、只向右侧承担长度差”的实现。 */
function validateSingleDirectionContract(sourceFile) {
  const contractFailures = [];
  const applyBodyMethod = findMethodDeclaration(sourceFile, "applyBodyParameters");
  const stretchMeshMethod = findMethodDeclaration(sourceFile, "stretchMeshVerticesByLocalX");
  const mapperMethod = findMethodDeclaration(sourceFile, "mapVisualLeftAnchoredLengthX");

  if (!applyBodyMethod) contractFailures.push("single-direction contract missing applyBodyParameters method");
  else {
    if (!hasThisMethodCall(sourceFile, applyBodyMethod, "stretchBodyLength", ["body", "lengthRatio"])) {
      contractFailures.push("applyBodyParameters does not route chainLength through stretchBodyLength");
    }
    if (hasForbiddenBodyLengthScale(sourceFile, applyBodyMethod)) {
      contractFailures.push("applyBodyParameters routes lengthRatio into whole-node scaling");
    }
  }
  if (!stretchMeshMethod || !hasThisMethodCall(sourceFile, stretchMeshMethod, "mapVisualLeftAnchoredLengthX")) {
    contractFailures.push("stretchMeshVerticesByLocalX does not use the left-anchored mapper");
  }

  const mapper = compilePureNumberMethod(sourceFile, mapperMethod);
  if (!mapper) {
    contractFailures.push("left-anchored mapper cannot be compiled for semantic validation");
    return contractFailures;
  }

  const epsilon = 1e-9;
  const middleStart = -1;
  const middleEnd = 1;
  const extension = 2;
  const middleScale = 2;
  const sourceMinimum = -1.25;
  const sourceMaximum = 1.25;
  const targetMinimum = mapper(sourceMinimum, middleStart, middleEnd, middleScale, extension);
  const targetMaximum = mapper(sourceMaximum, middleStart, middleEnd, middleScale, extension);
  const targetInterior = mapper(0, middleStart, middleEnd, middleScale, extension);

  if (Math.abs(targetMaximum - sourceMaximum) > epsilon) {
    contractFailures.push("left-anchored mapper moves the fixed visual-left endpoint");
  }
  if (Math.abs((sourceMinimum - targetMinimum) - extension) > epsilon) {
    contractFailures.push("left-anchored mapper does not place the full extension on one side");
  }
  if (Math.abs((targetMaximum - targetMinimum) - ((sourceMaximum - sourceMinimum) + extension)) > epsilon) {
    contractFailures.push("left-anchored mapper does not produce the requested target length");
  }
  if (Math.abs(targetInterior - (-1)) > epsilon) {
    contractFailures.push("left-anchored mapper middle segment is not continuous");
  }
  return contractFailures;
}

/** 直接执行纯端点方法，验证新包前后端路径、旧包 fallback 与非法配置 fail-closed。 */
function validateMqttEndpointMappingContract(sceneRuntimeSourceFile) {
  const failures = [];
  const createSidesMethod = findMethodDeclaration(sceneRuntimeSourceFile, "createWarehouseConveyorSides");
  const resolvePathMethod = findMethodDeclaration(sceneRuntimeSourceFile, "resolveWarehouseConveyorPath");
  const createSides = compilePureNumberMethod(sceneRuntimeSourceFile, createSidesMethod);
  const resolvePath = compilePureNumberMethod(sceneRuntimeSourceFile, resolvePathMethod);
  if (!createSides || !resolvePath) return ["MQTT endpoint mapping methods cannot be compiled"];

  const sideContext = {
    isWarehouseTransferSide(value) {
      return value === "left" || value === "right" || value === "front" || value === "rear";
    },
  };
  const legacySides = createSides.call(sideContext, "left", "right", null, null);
  const explicitSides = createSides.call(sideContext, "left", "right", "right", "left");
  const partialSides = createSides.call(sideContext, "left", "right", "right", null);
  const duplicateSides = createSides.call(sideContext, "left", "right", "left", "left");
  const invalidSides = createSides.call(sideContext, "left", "right", "north", "left");
  if (!legacySides || legacySides.hasExplicitMqttEndpoints !== false || legacySides.mqttFront !== null || legacySides.mqttBack !== null) {
    failures.push("legacy YZJ package does not preserve infeed/outfeed fallback");
  }
  if (!explicitSides || explicitSides.hasExplicitMqttEndpoints !== true || explicitSides.mqttFront !== "right" || explicitSides.mqttBack !== "left") {
    failures.push("explicit MQTT endpoint mapping is not preserved");
  }
  if (partialSides !== null || duplicateSides !== null || invalidSides !== null) {
    failures.push("partial, duplicate, or invalid MQTT endpoint mapping does not fail closed");
  }

  const infeed = { id: "infeed" };
  const outfeed = { id: "outfeed" };
  const mqttFront = { id: "front" };
  const mqttBack = { id: "back" };
  const explicitAnchors = { infeed, outfeed, mqttFront, mqttBack, hasExplicitMqttEndpoints: true };
  const legacyAnchors = { infeed, outfeed, mqttFront: null, mqttBack: null, hasExplicitMqttEndpoints: false };
  const inboundPath = resolvePath(explicitAnchors, "front-to-back");
  const outboundPath = resolvePath(explicitAnchors, "back-to-front");
  const legacyPath = resolvePath(legacyAnchors, "back-to-front");
  if (inboundPath.start !== mqttFront || inboundPath.end !== mqttBack) failures.push("inbound path is not MQTT front to back");
  if (outboundPath.start !== mqttBack || outboundPath.end !== mqttFront) failures.push("outbound path is not MQTT back to front");
  if (legacyPath.start !== infeed || legacyPath.end !== outfeed) failures.push("legacy path no longer uses infeed to outfeed");
  return failures;
}

/** 读取 PNG IHDR，确认内置方向箭头是 512x512 RGBA 资产。 */
function readPngHeader(path) {
  const buffer = readFileSync(path);
  const signature = buffer.subarray(0, 8).toString("hex");
  return {
    signature,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

const scriptText = readFileSync(files.sourceScript, "utf8");
const sceneRuntimeText = readFileSync(files.sceneRuntime, "utf8");
const externalScriptRuntimeText = readFileSync(files.externalScriptRuntime, "utf8");
const modelTextureAssetUrlText = readFileSync(files.modelTextureAssetUrl, "utf8");
const imageAssetsText = readFileSync(files.imageAssets, "utf8");
const textureReferencesText = readFileSync(files.textureReferences, "utf8");
const assetDatabaseText = readFileSync(files.assetDatabase, "utf8");
const projectPanelText = readFileSync(files.projectPanel, "utf8");
const modelParametersInspectorText = readFileSync(files.modelParametersInspector, "utf8");
const modelParametersText = readFileSync(files.modelParameters, "utf8");
const sourceMeta = JSON.parse(readFileSync(files.sourceMeta, "utf8"));
const assetMeta = JSON.parse(readFileSync(files.assetMeta, "utf8"));
const fixtureMeta = JSON.parse(readFileSync(files.fixtureMeta, "utf8"));
const allMeta = [sourceMeta, assetMeta, fixtureMeta];
const sourceFile = ts.createSourceFile(files.sourceScript, scriptText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sceneRuntimeSourceFile = ts.createSourceFile(files.sceneRuntime, sceneRuntimeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const transpileResult = ts.transpileModule(scriptText, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, experimentalDecorators: true, useDefineForClassFields: false },
  reportDiagnostics: true,
});
const transpileErrors = (transpileResult.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  .map(formatDiagnostic);

const parameterKeys = sourceMeta.modelParameters?.parameters?.map((item) => item.key) ?? [];
const failures = [];
const scriptHashes = [files.sourceScript, files.assetScript, files.fixtureScript, files.fixtureScriptText].map(sha256);
const metaHashes = [files.sourceMeta, files.assetMeta, files.fixtureMeta].map(sha256);
const glbHashes = [files.sourceGlb, files.assetGlb, files.fixtureGlb].map(sha256);
const directionArrowPngHash = sha256(files.directionArrowPng);
const pngHeader = readPngHeader(files.directionArrowPng);

if (new Set(scriptHashes).size !== 1) failures.push("script copies are not byte-identical");
if (new Set(metaHashes).size !== 1) failures.push("meta.json copies are not byte-identical");
if (new Set(glbHashes).size !== 1 || glbHashes[0] !== EXPECTED_GLB_HASH) failures.push("YZJ.glb hash changed or copies differ");
if (transpileErrors.length > 0) failures.push("TypeScript transpile errors: " + transpileErrors.join(" | "));
if (JSON.stringify(parameterKeys) !== JSON.stringify(EXPECTED_PARAMETER_KEYS)) failures.push("parameter order mismatch: " + parameterKeys.join(","));
for (const key of NUMBER_PARAMETER_KEYS) failures.push(...validateNumberParameterContract(sourceMeta, key));
for (const key of BOOLEAN_PARAMETER_KEYS) failures.push(...validateBooleanParameterContract(sourceMeta, key));
failures.push(...validateDirectionArrowTextureContract(sourceMeta));
failures.push(...validateSingleDirectionContract(sourceFile));
failures.push(...validateMqttEndpointMappingContract(sceneRuntimeSourceFile));

for (const meta of allMeta) {
  for (const key of NUMBER_PARAMETER_KEYS) failures.push(...validateNumberParameterContract(meta, key));
  for (const key of BOOLEAN_PARAMETER_KEYS) failures.push(...validateBooleanParameterContract(meta, key));
  failures.push(...validateDirectionArrowTextureContract(meta));
}

const requiredScriptTokens = [
  "mapVisualLeftAnchoredLengthX",
  "if (x >= middleEnd) { return x; }",
  "if (x <= middleStart) { return x - extension; }",
  "return middleEnd + (x - middleEnd) * middleScale;",
  "resolvePlatformPosition",
  "this.applyRollerParameters(values, frameLength.ratio, heightOffset, framePosition, width.value)",
  "resolveDimensionParameter",
  "resolveRollerFrameOffset",
  "getMeshComponents",
  "isLegAComponent",
  "isLegBComponent",
  "isMotorComponent",
  "isRollerSkinComponent",
  "applyBodyColor",
  "this.scaleNodeWithAxisAnchors(roller, platformLengthRatio",
  'this.addNodeAxisOffset(platform, "x", platformPosition)',
  "metadata?.logisticsFlow",
  "motionSourceNodeName",
  "frontSide",
  "backSide",
  "showDirectionArrow",
  "directionArrowImage",
  DIRECTION_ARROW_REFERENCE,
  "MeshBuilder.CreatePlane",
  "Mesh.DOUBLESIDE",
  "arrow.parent = platform",
  "arrow.isPickable = false",
  "arrow.renderingGroupId = 2",
  "arrow.alphaIndex = Number.MAX_SAFE_INTEGER",
  "directionArrowVisual: true",
  "material.useAlphaFromDiffuseTexture = true",
  "material.disableDepthWrite = true",
  "material.depthFunction = Constants.ALWAYS",
  "onBeforeRenderObservable",
  "% 1800",
  "0.55 + wave * 0.37",
  "1 + wave * 0.03",
  "movement === 2 || movement < 0",
  "telemetry.fields",
  "mesh?.metadata?.directionArrowVisual === true",
  "disposeDirectionArrowResources",
  "this.directionArrowMesh.dispose(false, true)",
];
for (const token of requiredScriptTokens) {
  if (!scriptText.includes(token)) failures.push("script missing required implementation token: " + token);
}
if (scriptText.includes("mapSymmetricLengthX")) failures.push("legacy symmetric length mapper remains");
if (scriptText.includes("this.applyRollerParameters(values, lengthRatio")) failures.push("roller is still driven by chainLength");
if (/readRuntimeMovementX[\s\S]*?telemetry\.rotation/.test(scriptText)) failures.push("direction arrow incorrectly falls back to rotation when movement_x is absent");

const arrowMetadataMatch = scriptText.match(/arrow\.metadata\s*=\s*\{([^}]*)\}/);
if (!arrowMetadataMatch) {
  failures.push("direction arrow metadata assignment missing");
} else {
  const arrowMetadataKeys = [...arrowMetadataMatch[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]).sort();
  if (JSON.stringify(arrowMetadataKeys) !== JSON.stringify(["directionArrowVisual", "generatedByParametricRuntime"])) {
    failures.push("direction arrow metadata contains unexpected keys: " + arrowMetadataKeys.join(","));
  }
}

for (const token of ["findConfiguredConveyorMotionNodes", "readParametricMotionSourceNodeName", "node.metadata.motionSourceNodeName"]) {
  if (!sceneRuntimeText.includes(token)) failures.push("SceneRuntime missing parametric roller motion support: " + token);
}
for (const token of ["updateRuntimeContext", "runtimeMode", "runtimeTelemetry", "resolveModelTextureAssetUrl", "this.callLifecycle(instance, 'onUpdate')"]) {
  if (!externalScriptRuntimeText.includes(token)) failures.push("ExternalModelScriptRuntime missing context/texture token: " + token);
}
for (const token of ["updateAllExternalScriptRuntimeContexts('runtime', null)", "updateAllExternalScriptRuntimeContexts('edit', null)", "snapshot ? this.createExternalScriptTelemetrySnapshot(snapshot) : null"]) {
  if (!sceneRuntimeText.includes(token)) failures.push("SceneRuntime missing runtime context lifecycle token: " + token);
}
for (const token of ["resolveBuiltInImageSourceUrl", "resolveRelativeEditorAssetUrl", "assetRevision="]) {
  if (!modelTextureAssetUrlText.includes(token)) failures.push("shared model texture resolver missing token: " + token);
}
if (!imageAssetsText.includes(DIRECTION_ARROW_REFERENCE) || !imageAssetsText.includes("direction-arrow-glow.png")) failures.push("built-in direction arrow image registration missing");
if (!textureReferencesText.includes("isRegisteredEditorImageReference") || !textureReferencesText.includes("isModelPackageRelativeTexturePath")) failures.push("texture reference whitelist missing");
if (!assetDatabaseText.includes(IMAGE_ASSET_DRAG_MIME_TYPE) || !assetDatabaseText.includes("findBuiltInImageAssetByReference")) failures.push("image drag payload contract missing or not registry-validated");
if (!projectPanelText.includes("encodeImageAssetDragPayload") || !projectPanelText.includes("isBuiltInImageProjectLibraryItem")) failures.push("Project image card drag wiring missing");
if (!modelParametersInspectorText.includes("decodeImageAssetDragPayload") || !modelParametersInspectorText.includes("updateSelectedModelParameterValue(definition.key, payload.reference)")) failures.push("Inspector texture drop wiring missing");
if (!modelParametersText.includes("isAllowedTextureReference")) failures.push("texture parameter sanitizer does not use shared whitelist");
if (pngHeader.signature !== "89504e470d0a1a0a" || pngHeader.width !== 512 || pngHeader.height !== 512 || pngHeader.bitDepth !== 8 || pngHeader.colorType !== 6) {
  failures.push("direction arrow PNG must be 512x512 8-bit RGBA");
}

for (const key of EXPECTED_PARAMETER_KEYS) {
  if (!findModelParameter(sourceMeta, key)) failures.push("source meta missing key: " + key);
  if (!findModelParameter(assetMeta, key)) failures.push("asset meta missing key: " + key);
  if (!findModelParameter(fixtureMeta, key)) failures.push("fixture meta missing key: " + key);
}

const result = {
  ok: failures.length === 0,
  failures,
  transpileErrors,
  hashes: { script: scriptHashes[0], meta: metaHashes[0], glb: glbHashes[0], directionArrowPng: directionArrowPngHash },
  parameterKeys,
  imageParameters: Object.fromEntries(EXPECTED_PARAMETER_KEYS.map((key) => [key, findModelParameter(sourceMeta, key)])),
  directionArrowImage: findModelParameter(sourceMeta, "directionArrowImage"),
  directionVisualsEnabled: scriptText.includes("directionArrowVisual: true")
    && scriptText.includes("runtimeTelemetry")
    && allMeta.every((meta) => findModelParameter(meta, "directionArrowImage")?.defaultValue === DIRECTION_ARROW_REFERENCE),
  pngHeader,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
