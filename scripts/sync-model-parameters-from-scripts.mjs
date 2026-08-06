import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DEFAULT_MODELS_ROOT = 'F:\\3d-models\\models';
const MODEL_PARAMETER_SCHEMA = 'babylon-editor.model-parameters';
const INFO_FIELD_KEYS = new Set(['modelKey', 'deviceType', 'deviceName', 'description']);
const BUILT_IN_SLOT_BINDING_EXPORT_NAME = 'builtInSlotBinding';
const BUILT_IN_SLOT_DIMENSION_KEYS = new Set(['columns', 'layers', 'length', 'height', 'width']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function readNumber(field, configuration, key) {
  const directValue = field[key];
  const configuredValue = configuration[key];
  if (typeof directValue === 'number' && Number.isFinite(directValue)) return directValue;
  return typeof configuredValue === 'number' && Number.isFinite(configuredValue) ? configuredValue : undefined;
}

function normalizeOptions(value, defaultValue) {
  if (!Array.isArray(value) || value.length === 0) return null;

  const options = value.map((item) => {
    if (typeof item === 'string' && item.trim()) {
      const trimmed = item.trim();
      return { value: trimmed, label: trimmed };
    }

    if (!isPlainObject(item)) return null;
    const optionValue = typeof item.value === 'string' && item.value.trim() ? item.value.trim() : null;
    const optionLabel = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : optionValue;
    return optionValue && optionLabel ? { value: optionValue, label: optionLabel } : null;
  });

  if (!options.every(Boolean)) return null;
  if (!options.some((option) => option.value === defaultValue)) {
    options.unshift({ value: defaultValue, label: defaultValue });
  }
  return options;
}

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function createParameterDefinition(field) {
  if (!isPlainObject(field)) return null;

  const key = typeof field.key === 'string' && field.key.trim() ? field.key.trim() : null;
  const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim() : key;
  if (!key || !label || INFO_FIELD_KEYS.has(key)) return null;

  const configuration = isPlainObject(field.configuration) ? field.configuration : {};
  const type = typeof field.type === 'string' ? field.type : configuration.type;
  const defaultValue = field.defaultValue;
  const base = { key, label };

  if (type === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue)) {
    return {
      ...base,
      type: 'number',
      defaultValue,
      min: readNumber(field, configuration, 'min'),
      max: readNumber(field, configuration, 'max'),
      step: readNumber(field, configuration, 'step'),
    };
  }

  if (type === 'boolean' && typeof defaultValue === 'boolean') {
    return { ...base, type: 'boolean', defaultValue };
  }

  if (typeof defaultValue === 'string') {
    const options = normalizeOptions(field.options ?? configuration.options, defaultValue);
    if (options) return { ...base, type: 'enum', defaultValue, options };
    if (isHexColor(defaultValue)) return { ...base, type: 'color', defaultValue };
    if (type === 'texture' && /\.(png|jpe?g|webp)$/i.test(defaultValue)) {
      return { ...base, type: 'texture', defaultValue, allowedExtensions: ['.png', '.jpg', '.jpeg', '.webp'] };
    }
    if (type === 'string') return { ...base, type: 'string', defaultValue };
  }

  if (
    isPlainObject(defaultValue) &&
    typeof defaultValue.x === 'number' &&
    typeof defaultValue.y === 'number' &&
    typeof defaultValue.z === 'number'
  ) {
    return {
      ...base,
      type: 'vector3',
      defaultValue: { x: defaultValue.x, y: defaultValue.y, z: defaultValue.z },
      min: readNumber(field, configuration, 'min'),
      max: readNumber(field, configuration, 'max'),
      step: readNumber(field, configuration, 'step'),
    };
  }

  return null;
}

function createModelParameters(metadata) {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return null;

  const parameters = [];
  const seenKeys = new Set();
  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script) || !Array.isArray(script.fields)) continue;
    for (const field of script.fields) {
      const definition = createParameterDefinition(field);
      if (!definition || seenKeys.has(definition.key)) continue;
      seenKeys.add(definition.key);
      parameters.push(definition);
    }
  }

  return parameters.length
    ? { schema: MODEL_PARAMETER_SCHEMA, version: 1, parameters, bindings: [] }
    : null;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)]),
  );
}

/** 把 .model.ts 中的对象字面量表达式转换为 JSON 值；含不可序列化内容时返回 undefined。 */
function expressionToJsonValue(expression) {
  if (!expression) return undefined;
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return expressionToJsonValue(expression.expression);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.expression)) {
    const value = Number(expression.expression.text);
    if (!Number.isFinite(value)) return undefined;
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const items = [];
    for (const element of expression.elements) {
      const item = expressionToJsonValue(element);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const result = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = property.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
      if (!key) return undefined;
      const item = expressionToJsonValue(property.initializer);
      if (item === undefined) return undefined;
      result[key] = item;
    }
    return result;
  }
  return undefined;
}

/** 与 src/editor/model/builtInSlotBinding.ts 的 normalizeBuiltInSlotBindingConfig 保持一致。 */
function normalizeBuiltInSlotBinding(source) {
  if (!isPlainObject(source)) return null;
  const enabledParam = typeof source.enabledParam === 'string' ? source.enabledParam.trim() : '';
  if (!enabledParam) return null;

  const dimensionMapping = {};
  if (isPlainObject(source.dimensionMapping)) {
    for (const [key, paramKey] of Object.entries(source.dimensionMapping)) {
      if (!BUILT_IN_SLOT_DIMENSION_KEYS.has(key)) continue;
      if (typeof paramKey === 'string' && paramKey.trim()) dimensionMapping[key] = paramKey.trim();
    }
  }

  return {
    enabledParam,
    dimensionMapping,
    columnDirection: source.columnDirection === '-x' ? '-x' : '+x',
  };
}

/** 从 .model.ts 源码提取 `export const builtInSlotBinding = {...}` 的 JSON 值；未声明返回 null，声明非法返回 undefined。 */
function extractBuiltInSlotBindingFromScript(sourceText) {
  const sourceFile = ts.createSourceFile('model.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const hasExport = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== BUILT_IN_SLOT_BINDING_EXPORT_NAME) continue;
      return expressionToJsonValue(declaration.initializer) ?? undefined;
    }
  }
  return null;
}

/** 读取模型包内声明了绑定的 .model.ts，返回同步后的 builtInSlotBinding 字段值。 */
async function readPackageBuiltInSlotBinding(packageDirectory, metadata) {
  const scriptFileNames = new Set();
  for (const section of [metadata.parameterScripts, metadata.animationScripts]) {
    if (!Array.isArray(section)) continue;
    for (const script of section) {
      if (isPlainObject(script) && typeof script.scriptFilename === 'string' && script.scriptFilename.trim()) {
        scriptFileNames.add(script.scriptFilename.trim());
      }
    }
  }

  for (const scriptFileName of scriptFileNames) {
    let sourceText;
    try {
      sourceText = await fs.readFile(path.join(packageDirectory, scriptFileName), 'utf8');
    } catch {
      continue;
    }
    const extracted = extractBuiltInSlotBindingFromScript(sourceText);
    if (extracted === null) continue;
    const normalized = extracted === undefined ? null : normalizeBuiltInSlotBinding(extracted);
    if (!normalized) return { status: 'invalid', scriptFileName };
    return { status: 'declared', value: normalized, scriptFileName };
  }
  return { status: 'none' };
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

  return {
    root: rootArg ?? DEFAULT_MODELS_ROOT,
    write: args.has('--write'),
  };
}

async function getPackageDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

async function main() {
  const { root, write } = parseArgs();
  const packageDirectories = await getPackageDirectories(root);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const summary = [];

  for (const packageDirectory of packageDirectories) {
    const metadataPath = path.join(packageDirectory, 'meta.json');
    let metadata;
    let originalContent;

    try {
      originalContent = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(originalContent);
    } catch (error) {
      summary.push({ package: path.basename(packageDirectory), status: 'skip', reason: `meta.json 读取失败：${error.message}` });
      continue;
    }

    const modelParameters = createModelParameters(metadata);
    const bindingResult = await readPackageBuiltInSlotBinding(packageDirectory, metadata);

    if (bindingResult.status === 'invalid') {
      summary.push({
        package: path.basename(packageDirectory),
        status: 'skip',
        reason: `${bindingResult.scriptFileName} 中 export const builtInSlotBinding 声明非法`,
      });
      continue;
    }

    if (!modelParameters) {
      summary.push({ package: path.basename(packageDirectory), status: 'skip', reason: '没有可转换的 parameterScripts 字段' });
      continue;
    }

    const nextMetadata = { ...metadata, modelParameters: stripUndefined(modelParameters) };
    // builtInSlotBinding 以 .model.ts 导出常量为单一源头：已声明则写回，未声明则移除 meta.json 陈旧字段。
    if (bindingResult.status === 'declared') nextMetadata.builtInSlotBinding = bindingResult.value;
    else delete nextMetadata.builtInSlotBinding;
    const nextContent = `${JSON.stringify(nextMetadata, null, 2)}\n`;
    const changed = nextContent !== originalContent;

    if (write && changed) {
      await fs.copyFile(metadataPath, path.join(packageDirectory, `meta.json.bak-${timestamp}`));
      await fs.writeFile(metadataPath, nextContent, 'utf8');
    }

    summary.push({
      package: path.basename(packageDirectory),
      status: changed ? (write ? 'updated' : 'pending') : 'unchanged',
      parameters: modelParameters.parameters.length,
      builtInSlotBinding: bindingResult.status,
    });
  }

  console.log(JSON.stringify({ root, write, summary }, null, 2));
}

await main();
