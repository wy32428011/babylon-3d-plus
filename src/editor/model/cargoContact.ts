export type CargoContactSupport = {
  id: string;
  alias: string;
  nodes: string[];
};

export type CargoContactSelection = {
  supportId: string;
};

export const CARGO_CONTACT_NODE_NAME_MAX_LENGTH = 256;
const CARGO_CONTACT_ID_MAX_LENGTH = 128;
const CARGO_CONTACT_ALIAS_MAX_LENGTH = 256;
const CARGO_CONTACT_MAX_SUPPORTS = 64;
const CARGO_CONTACT_MAX_NODES_PER_SUPPORT = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 清理模型包声明的支撑位集合；ID 必须唯一，每项至少包含一个有效节点名。 */
export function normalizeCargoContactSupports(value: unknown): CargoContactSupport[] | null {
  if (!Array.isArray(value) || value.length > CARGO_CONTACT_MAX_SUPPORTS) return null;
  const supports: CargoContactSupport[] = [];
  const supportIds = new Set<string>();
  for (const item of value) {
    if (!isPlainObject(item) || !Array.isArray(item.nodes) || item.nodes.length === 0
      || item.nodes.length > CARGO_CONTACT_MAX_NODES_PER_SUPPORT) return null;
    const id = normalizeText(item.id, CARGO_CONTACT_ID_MAX_LENGTH);
    const alias = normalizeText(item.alias, CARGO_CONTACT_ALIAS_MAX_LENGTH);
    if (!id || !alias || supportIds.has(id)) return null;
    const nodes = [...new Set(item.nodes.map(node => normalizeText(node, CARGO_CONTACT_NODE_NAME_MAX_LENGTH)).filter(Boolean))];
    if (nodes.length === 0) return null;
    supportIds.add(id);
    supports.push({ id, alias, nodes });
  }
  return supports;
}

export function normalizeCargoContactSelection(value: unknown): CargoContactSelection | null {
  if (!isPlainObject(value)) return null;
  const supportId = normalizeText(value.supportId, CARGO_CONTACT_ID_MAX_LENGTH);
  return supportId ? { supportId } : null;
}
