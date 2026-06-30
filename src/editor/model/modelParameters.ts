import type { Vector3Data } from './math';

export type ModelParameterType = 'number' | 'color' | 'boolean' | 'enum' | 'vector3' | 'texture';

export type ModelParameterPrimitiveValue = number | string | boolean;
export type ModelParameterVector3Value = Vector3Data;
export type ModelParameterValue = ModelParameterPrimitiveValue | ModelParameterVector3Value;
export type ModelParameterValues = Record<string, ModelParameterValue>;

export type ModelParameterOption = {
  value: string;
  label: string;
};

type BaseModelParameterDefinition = {
  key: string;
  label: string;
  unit?: string;
};

export type ModelNumberParameterDefinition = BaseModelParameterDefinition & {
  type: 'number';
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
};

export type ModelColorParameterDefinition = BaseModelParameterDefinition & {
  type: 'color';
  defaultValue: string;
};

export type ModelBooleanParameterDefinition = BaseModelParameterDefinition & {
  type: 'boolean';
  defaultValue: boolean;
};

export type ModelEnumParameterDefinition = BaseModelParameterDefinition & {
  type: 'enum';
  defaultValue: string;
  options: ModelParameterOption[];
};

export type ModelVector3ParameterDefinition = BaseModelParameterDefinition & {
  type: 'vector3';
  defaultValue: Vector3Data;
  min?: number;
  max?: number;
  step?: number;
};

export type ModelTextureParameterDefinition = BaseModelParameterDefinition & {
  type: 'texture';
  defaultValue: string;
  options?: ModelParameterOption[];
  allowedExtensions?: string[];
};

export type ModelParameterDefinition =
  | ModelNumberParameterDefinition
  | ModelColorParameterDefinition
  | ModelBooleanParameterDefinition
  | ModelEnumParameterDefinition
  | ModelVector3ParameterDefinition
  | ModelTextureParameterDefinition;

export type ModelExpression =
  | number
  | string
  | boolean
  | Vector3Data
  | { param: string }
  | { vector3: [ModelExpression, ModelExpression, ModelExpression] }
  | {
      op:
        | 'add'
        | 'sub'
        | 'mul'
        | 'div'
        | 'min'
        | 'max'
        | 'clamp'
        | 'lerp'
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'and'
        | 'or'
        | 'not'
        | 'if';
      args: ModelExpression[];
    };

export type ModelParameterTarget =
  | { kind: 'node'; name: string }
  | { kind: 'mesh'; name: string }
  | { kind: 'material'; name: string };

export type ModelParameterBindableProperty =
  | 'visible'
  | 'position'
  | 'rotation'
  | 'scaling'
  | 'baseColor'
  | 'emissiveColor'
  | 'alpha'
  | 'baseTexture';

export type ModelParameterBinding = {
  target: ModelParameterTarget;
  property: ModelParameterBindableProperty;
  value: ModelExpression;
};

export type ModelParameterRule = {
  when: ModelExpression;
  set: ModelParameterBinding[];
};

export type ModelParameterConfig = {
  schema: 'babylon-editor.model-parameters';
  version: 1;
  parameters: ModelParameterDefinition[];
  bindings: ModelParameterBinding[];
  rules?: ModelParameterRule[];
};

const MODEL_PARAMETER_SCHEMA = 'babylon-editor.model-parameters';
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const SAFE_TEXTURE_EXTENSION_PATTERN = /\.(png|jpe?g|webp)$/i;
const FORBIDDEN_TEXTURE_PREFIX_PATTERN = /^(?:[a-z]+:|\/|\\)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isVector3Data(value: unknown): value is Vector3Data {
  return (
    isPlainObject(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    typeof value.z === 'number' &&
    Number.isFinite(value.z)
  );
}

function cloneVector3(value: Vector3Data): Vector3Data {
  return { x: value.x, y: value.y, z: value.z };
}

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let nextValue = value;
  if (min !== undefined) nextValue = Math.max(min, nextValue);
  if (max !== undefined) nextValue = Math.min(max, nextValue);
  return nextValue;
}

function isSafeTexturePath(value: string, allowedExtensions?: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || FORBIDDEN_TEXTURE_PREFIX_PATTERN.test(trimmed)) return false;

  const extensions = allowedExtensions?.length ? allowedExtensions : ['.png', '.jpg', '.jpeg', '.webp'];
  if (!extensions.some((extension) => trimmed.toLowerCase().endsWith(extension.toLowerCase()))) return false;

  return SAFE_TEXTURE_EXTENSION_PATTERN.test(trimmed);
}

export function sanitizeModelParameterValue(
  definition: ModelParameterDefinition,
  value: unknown,
): ModelParameterValue {
  if (definition.type === 'number') {
    const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : definition.defaultValue;
    return clampNumber(numberValue, definition.min, definition.max);
  }

  if (definition.type === 'color') {
    return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : definition.defaultValue;
  }

  if (definition.type === 'boolean') {
    return typeof value === 'boolean' ? value : definition.defaultValue;
  }

  if (definition.type === 'enum') {
    return typeof value === 'string' && definition.options.some((option) => option.value === value)
      ? value
      : definition.defaultValue;
  }

  if (definition.type === 'vector3') {
    const vector = isVector3Data(value) ? value : definition.defaultValue;
    return {
      x: clampNumber(vector.x, definition.min, definition.max),
      y: clampNumber(vector.y, definition.min, definition.max),
      z: clampNumber(vector.z, definition.min, definition.max),
    };
  }

  if (typeof value === 'string' && isSafeTexturePath(value, definition.allowedExtensions)) {
    return value.trim().replace(/\\/g, '/');
  }

  return definition.defaultValue;
}

export function createDefaultModelParameterValues(config: ModelParameterConfig): ModelParameterValues {
  return config.parameters.reduce<ModelParameterValues>((values, definition) => {
    values[definition.key] = sanitizeModelParameterValue(definition, definition.defaultValue);
    return values;
  }, {});
}

export function sanitizeModelParameterValues(
  config: ModelParameterConfig,
  values: unknown,
): ModelParameterValues {
  const sourceValues = isPlainObject(values) ? values : {};

  return config.parameters.reduce<ModelParameterValues>((nextValues, definition) => {
    nextValues[definition.key] = sanitizeModelParameterValue(definition, sourceValues[definition.key]);
    return nextValues;
  }, {});
}

export function cloneModelParameterValues(values: ModelParameterValues): ModelParameterValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, isVector3Data(value) ? cloneVector3(value) : value]),
  );
}

export function areModelParameterValuesEqual(left: ModelParameterValues, right: ModelParameterValues): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (isVector3Data(leftValue) && isVector3Data(rightValue)) {
      return leftValue.x === rightValue.x && leftValue.y === rightValue.y && leftValue.z === rightValue.z;
    }

    return leftValue === rightValue;
  });
}

export function findModelParameterDefinition(
  config: ModelParameterConfig | undefined,
  key: string,
): ModelParameterDefinition | null {
  return config?.parameters.find((definition) => definition.key === key) ?? null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeOptions(value: unknown): ModelParameterOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;

  const options = value.map((item) => {
    if (!isPlainObject(item)) return null;
    const optionValue = readString(item, 'value');
    const optionLabel = readString(item, 'label') ?? optionValue;
    return optionValue ? { value: optionValue, label: optionLabel } : null;
  });

  return options.every(Boolean) ? options as ModelParameterOption[] : null;
}

function normalizeExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const extensions = value.filter((item): item is string => typeof item === 'string' && /^\.[a-z0-9]+$/i.test(item));
  return extensions.length === value.length ? extensions : undefined;
}

function normalizeParameterDefinition(value: unknown): ModelParameterDefinition | null {
  if (!isPlainObject(value)) return null;

  const key = readString(value, 'key');
  const label = readString(value, 'label') ?? key;
  const type = value.type;
  if (!key || !label) return null;

  const base = { key, label, unit: readString(value, 'unit') ?? undefined };
  const min = readFiniteNumber(value, 'min');
  const max = readFiniteNumber(value, 'max');
  const step = readFiniteNumber(value, 'step');

  if (type === 'number') {
    const defaultValue = readFiniteNumber(value, 'defaultValue');
    if (defaultValue === undefined) return null;
    return { ...base, type, defaultValue, min, max, step };
  }

  if (type === 'color') {
    const defaultValue = readString(value, 'defaultValue');
    if (!defaultValue || !HEX_COLOR_PATTERN.test(defaultValue)) return null;
    return { ...base, type, defaultValue };
  }

  if (type === 'boolean') {
    return typeof value.defaultValue === 'boolean' ? { ...base, type, defaultValue: value.defaultValue } : null;
  }

  if (type === 'enum') {
    const options = normalizeOptions(value.options);
    const defaultValue = readString(value, 'defaultValue');
    if (!options || !defaultValue || !options.some((option) => option.value === defaultValue)) return null;
    return { ...base, type, defaultValue, options };
  }

  if (type === 'vector3') {
    if (!isVector3Data(value.defaultValue)) return null;
    return { ...base, type, defaultValue: cloneVector3(value.defaultValue), min, max, step };
  }

  if (type === 'texture') {
    const allowedExtensions = normalizeExtensions(value.allowedExtensions);
    const defaultValue = readString(value, 'defaultValue');
    const options = value.options === undefined ? undefined : normalizeOptions(value.options) ?? undefined;
    if (!defaultValue || !isSafeTexturePath(defaultValue, allowedExtensions)) return null;
    if (value.options !== undefined && !options) return null;
    if (options?.some((option) => !isSafeTexturePath(option.value, allowedExtensions))) return null;
    return { ...base, type, defaultValue: defaultValue.replace(/\\/g, '/'), options, allowedExtensions };
  }

  return null;
}

const SUPPORTED_TARGET_KINDS = new Set(['node', 'mesh', 'material']);
const SUPPORTED_BINDING_PROPERTIES = new Set<ModelParameterBindableProperty>([
  'visible',
  'position',
  'rotation',
  'scaling',
  'baseColor',
  'emissiveColor',
  'alpha',
  'baseTexture',
]);
const SUPPORTED_EXPRESSION_OPERATORS = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'min',
  'max',
  'clamp',
  'lerp',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'and',
  'or',
  'not',
  'if',
]);

function isModelExpression(value: unknown, depth = 0, nodeCount = { value: 0 }): value is ModelExpression {
  nodeCount.value += 1;
  if (depth > 12 || nodeCount.value > 128) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (isVector3Data(value)) return true;
  if (!isPlainObject(value)) return false;

  if ('param' in value) return typeof value.param === 'string' && value.param.trim().length > 0;

  if ('vector3' in value) {
    return Array.isArray(value.vector3) &&
      value.vector3.length === 3 &&
      value.vector3.every((item) => isModelExpression(item, depth + 1, nodeCount));
  }

  if ('op' in value) {
    return typeof value.op === 'string' &&
      SUPPORTED_EXPRESSION_OPERATORS.has(value.op) &&
      Array.isArray(value.args) &&
      value.args.every((item) => isModelExpression(item, depth + 1, nodeCount));
  }

  return false;
}

function normalizeTarget(value: unknown): ModelParameterTarget | null {
  if (!isPlainObject(value)) return null;
  const kind = readString(value, 'kind');
  const name = readString(value, 'name');
  if (!kind || !name || !SUPPORTED_TARGET_KINDS.has(kind)) return null;
  return { kind: kind as ModelParameterTarget['kind'], name };
}

function normalizeBinding(value: unknown): ModelParameterBinding | null {
  if (!isPlainObject(value)) return null;
  const target = normalizeTarget(value.target);
  const property = value.property;
  if (!target || !SUPPORTED_BINDING_PROPERTIES.has(property as ModelParameterBindableProperty)) return null;
  if (!isModelExpression(value.value)) return null;
  return { target, property: property as ModelParameterBindableProperty, value: value.value };
}

function normalizeRule(value: unknown): ModelParameterRule | null {
  if (!isPlainObject(value) || !isModelExpression(value.when) || !Array.isArray(value.set)) return null;
  const set = value.set.map(normalizeBinding);
  return set.every(Boolean) ? { when: value.when, set: set as ModelParameterBinding[] } : null;
}

export function normalizeModelParameterConfig(value: unknown): ModelParameterConfig | null {
  if (!isPlainObject(value) || value.schema !== MODEL_PARAMETER_SCHEMA || value.version !== 1) return null;
  if (!Array.isArray(value.parameters) || !Array.isArray(value.bindings)) return null;
  if (value.parameters.length > 64 || value.bindings.length > 256) return null;

  const parameters = value.parameters.map(normalizeParameterDefinition);
  if (!parameters.every(Boolean)) return null;

  const normalizedParameters = parameters as ModelParameterDefinition[];
  const parameterKeys = new Set<string>();
  for (const parameter of normalizedParameters) {
    if (parameterKeys.has(parameter.key)) return null;
    parameterKeys.add(parameter.key);
  }

  const bindings = value.bindings.map(normalizeBinding);
  if (!bindings.every(Boolean)) return null;

  const rulesSource = Array.isArray(value.rules) ? value.rules : [];
  if (rulesSource.length > 128) return null;
  const rules = rulesSource.map(normalizeRule);
  if (!rules.every(Boolean)) return null;

  return {
    schema: MODEL_PARAMETER_SCHEMA,
    version: 1,
    parameters: normalizedParameters,
    bindings: bindings as ModelParameterBinding[],
    ...(rules.length > 0 ? { rules: rules as ModelParameterRule[] } : {}),
  };
}
