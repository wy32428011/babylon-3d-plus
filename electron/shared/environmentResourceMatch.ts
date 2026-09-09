export type EnvironmentResourceReference = {
  resourceId?: string;
  displayName?: string;
};

const RESOURCE_ID_PATTERN = /^[1-9]\d{0,63}$/;
const MAX_DISPLAY_NAME_LENGTH = 512;

function isValidResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && RESOURCE_ID_PATTERN.test(value);
}

/** 校验场景传来的环境身份；已提供的非法字段不能被另一合法字段掩盖。 */
export function normalizeEnvironmentResourceReference(value: unknown): EnvironmentResourceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('环境资源引用必须是对象。');
  }
  const input = value as Record<string, unknown>;
  const reference: EnvironmentResourceReference = {};
  if (input.resourceId !== undefined) {
    if (!isValidResourceId(input.resourceId)) throw new Error('环境资源引用的 ID 必须是 1 至 64 位正整数字符串。');
    reference.resourceId = input.resourceId;
  }
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string') throw new Error('环境资源引用的名称必须是字符串。');
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error('环境资源引用的名称不能为空且不能超过 512 个字符。');
    }
    reference.displayName = displayName;
  }
  if (!reference.resourceId && !reference.displayName) throw new Error('环境资源引用必须包含有效 ID 或名称。');
  return reference;
}

function normalizeDisplayName(value: string | undefined): string {
  return (value ?? '').trim().replace(/\.(?:glb|gltf)$/i, '').trim().toLowerCase();
}

/** 优先使用唯一稳定 ID，迁移后才按唯一名称兜底；歧义必须显式处理。 */
export function findMatchingEnvironmentResource<T>(
  resources: readonly T[],
  reference: EnvironmentResourceReference,
  describe: (resource: T) => { resourceId: string; displayName: string },
): T | null {
  const resourceId = isValidResourceId(reference.resourceId) ? reference.resourceId : undefined;
  const displayName = normalizeDisplayName(reference.displayName);
  if (!resourceId && !displayName) return null;
  let idMatch: T | null = null;
  let nameMatch: T | null = null;
  let idCount = 0;
  let nameCount = 0;
  for (const resource of resources) {
    const description = describe(resource);
    if (resourceId && description.resourceId === resourceId) {
      idMatch = resource;
      idCount += 1;
    }
    if (displayName && normalizeDisplayName(description.displayName) === displayName) {
      nameMatch = resource;
      nameCount += 1;
    }
  }
  if (idCount > 1) throw new Error('环境资源 ID 匹配存在歧义，请检查数据中台中的重复资源。');
  if (idCount === 1) return idMatch;
  if (nameCount > 1) throw new Error('环境资源名称匹配存在歧义，请明确指定唯一资源 ID。');
  return nameMatch;
}
