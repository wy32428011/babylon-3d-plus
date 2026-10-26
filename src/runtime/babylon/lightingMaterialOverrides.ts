import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import type { AbstractMesh, BaseTexture } from '@babylonjs/core';
import { lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';

const scalarFields = ['alpha', 'alphaMode', 'transparencyMode', 'backFaceCulling', 'disableLighting', 'wireframe',
  'pointsCloud', 'pointSize', 'zOffset', 'zOffsetUnits', 'metallic', 'roughness', 'microSurface', 'specularPower',
  'alphaCutOff', 'useAlphaFromAlbedoTexture', 'useAlphaFromDiffuseTexture', 'useEmissiveAsIllumination', 'linkEmissiveWithDiffuse'] as const;
const colorFields = ['diffuseColor', 'albedoColor', 'emissiveColor', 'specularColor', 'ambientColor', 'reflectionColor'] as const;
const textureFields = ['albedoTexture', 'diffuseTexture', 'metallicTexture', 'microSurfaceTexture', 'bumpTexture',
  'emissiveTexture', 'ambientTexture', 'opacityTexture', 'reflectionTexture', 'refractionTexture', 'lightmapTexture'] as const;
const textureScalarFields = ['level', 'coordinatesIndex', 'coordinatesMode', 'uOffset', 'vOffset', 'uScale', 'vScale', 'uAng', 'vAng', 'wAng', 'wrapU', 'wrapV'] as const;
type Values = Record<string, unknown>;
type Snapshot = { values: Values; colors: Map<string, number[] | null>; textures: Map<string, BaseTexture | null | undefined>;
  textureStates: Map<BaseTexture, Values>; activeTextures: unknown[]; children: (Material | null)[] | null; signature: string };
type Entry = { clone: Material; original: Material | null; source: Snapshot; initial: Snapshot; owner: string; active: boolean;
  ignored: ReadonlySet<BaseTexture>; targets?: ReadonlySet<object>; owned: Map<string, unknown>; businessOwned: Map<string, unknown>; forwarded: Map<string, unknown> };
const entries = new WeakMap<Material, Entry>();
const children = new WeakMap<Material, Set<Entry>>();
const noTextures = new Set<BaseTexture>();

/** 只承认原生InstancedMesh材质getter的真实sourceMesh委托，不按名称/metadata猜carrier。 */
export function getLightingMaterialSourceOwner(mesh: AbstractMesh): AbstractMesh { return mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh; }

function snapshotSignature(value: Snapshot): string {
  return lightingContentHash([value.values, [...value.colors], [...value.textures].map(([field, texture]) =>
    [field, texture?.uniqueId ?? null, texture ? value.textureStates.get(texture) : null]), value.activeTextures,
  value.children?.map(child => child?.uniqueId ?? null)]);
}

function snapshot(material: Material | null, ignored: ReadonlySet<BaseTexture> = noTextures): Snapshot {
  const value = material as unknown as Values | null, values: Values = {};
  const colors = new Map<string, number[] | null>(), textures = new Map<string, BaseTexture | null | undefined>();
  for (const field of scalarFields) values[field] = value?.[field];
  for (const field of colorFields) {
    const color = value?.[field] as { r?: unknown; g?: unknown; b?: unknown } | undefined;
    colors.set(field, color && typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number' ? [color.r, color.g, color.b] : null);
  }
  for (const field of textureFields) textures.set(field, value?.[field] as BaseTexture | null | undefined);
  const subMaterials = material instanceof MultiMaterial ? [...material.subMaterials] : null;
  const active = (material?.getActiveTextures() ?? []).filter(texture => !ignored.has(texture));
  const textureStates = new Map<BaseTexture, Values>();
  for (const texture of new Set([...active, ...[...textures.values()].filter((value): value is BaseTexture => Boolean(value))])) {
    const row = texture as unknown as Values;
    textureStates.set(texture, Object.fromEntries(textureScalarFields.map(field => [field, row[field]])));
  }
  const current: Snapshot = { values, colors, textures, textureStates,
    activeTextures: active.map(texture => [texture.uniqueId, textureStates.get(texture)]), children: subMaterials, signature: '' };
  current.signature = snapshotSignature(current); return current;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sourceUnchanged(entry: Entry, key: string, current: unknown, baseline: unknown): boolean {
  return Object.is(current, baseline) || entry.forwarded.has(key) && Object.is(current, entry.forwarded.get(key));
}
function stable(entry: Entry): boolean {
  if (snapshot(entry.original, entry.ignored).signature !== entry.source.signature || entry.businessOwned.size) return false;
  const current = snapshot(entry.clone, entry.ignored);
  for (const [field, expected] of entry.owned) {
    if (!Object.is(current.values[field], expected)) return false;
    current.values[field] = entry.initial.values[field];
  }
  return snapshotSignature(current) === entry.initial.signature;
}

function audit(material: Material | null, visited = new Set<Material>()): string[] {
  if (!material || visited.has(material)) return [];
  visited.add(material);
  const dirty: string[] = [];
  for (const entry of children.get(material) ?? []) if (entry.active) {
    if (!stable(entry)) dirty.push(`${entry.owner}:${entry.clone.uniqueId}:${snapshot(entry.original, entry.ignored).signature}:${snapshot(entry.clone, entry.ignored).signature}`);
    dirty.push(...audit(entry.clone, visited));
  }
  if (material instanceof MultiMaterial) for (const child of material.subMaterials) dirty.push(...audit(child, visited));
  return dirty;
}

/** 精确沿当前有效自有链查源；非租约对象和未知替换原样返回。 */
export function resolveLightingMaterialOverride(material: Material | null, target?: object): { material: Material | null; stable: boolean; targetValid: boolean; dirty: readonly string[] } {
  const visited = new Set<Material>(); let current = material;
  while (current && entries.get(current)?.active) {
    if (visited.has(current)) throw new Error('光照显示材质来源形成循环。'); visited.add(current);
    const entry = entries.get(current)!;
    if (target && !entry.targets?.has(target)) return { material: current, stable: false, targetValid: false, dirty: [`${entry.owner}:${current.uniqueId}:unknown-target`] };
    current = entry.original;
  }
  const dirty = audit(current);
  // null 没有 WeakMap 索引，仍须检查直接的受控默认材质。
  if (material && current === null) { const entry = entries.get(material); if (entry?.active && !stable(entry)) dirty.push(`${entry.owner}:${entry.clone.uniqueId}:changed-default`); }
  return { material: current, stable: dirty.length === 0, targetValid: true, dirty };
}

export function isLightingMaterialOverrideOf(material: Material | null, expected: Material | null, target?: object): boolean {
  const visited = new Set<Material>();
  for (let current = material; current && !visited.has(current); current = entries.get(current)?.active ? entries.get(current)!.original : null) {
    const entry = entries.get(current);
    if (target && entry?.active && !entry.targets?.has(target)) return false;
    if (current === expected) return true; visited.add(current);
  }
  return material === expected;
}

/** 动态来源只读其直接租约链；不能对每个实例遍历整个物理root的后代。 */
export function resolveLightingMaterialDirect(material: Material | null, target?: object): { material: Material | null; stable: boolean; targetValid: boolean } {
  let current = material, unchanged = true; const visited = new Set<Material>();
  while (current && entries.get(current)?.active) {
    if (visited.has(current)) throw new Error('光照显示材质来源形成循环。'); visited.add(current);
    const entry = entries.get(current)!;
    if (target && !entry.targets?.has(target)) return { material: current, stable: false, targetValid: false };
    unchanged &&= stable(entry); current = entry.original;
  }
  return { material: current, stable: unchanged, targetValid: true };
}

/** 每material本轮缓存的物理值签名；包含真实UV/采样值，不把显示wrapper ID当物理修改。 */
export function lightingPhysicalMaterialValueSignature(material: Material | null): string { return snapshot(material).signature; }

/** 未租约的旧指纹表达式保持不变；受控 identity 变化只有双侧均未被业务改动才等价。 */
export function lightingMaterialOverrideFingerprint(material: Material | null, target?: object): string {
  const resolved = resolveLightingMaterialOverride(material, target), logical = resolved.material;
  const materials = logical instanceof MultiMaterial ? logical.subMaterials : [logical];
  const signature = lightingContentHash(materials.map(value => {
    if (!(value instanceof PBRMaterial) && !(value instanceof StandardMaterial)) return value?.uniqueId ?? null;
    const base = value instanceof PBRMaterial ? value.albedoColor : value.diffuseColor;
    return [value.uniqueId, base.asArray(), value.emissiveColor.asArray(), value.alpha, value.backFaceCulling,
      value instanceof PBRMaterial ? [value.metallic, value.roughness] : value.specularPower,
      value.getActiveTextures().map(texture => [texture.uniqueId, texture.level, texture.getTextureMatrix()?.updateFlag])];
  }));
  return resolved.stable ? signature : lightingContentHash([signature, 'owned-material-business-change', resolved.dirty]);
}

function mergeBusinessChanges(entry: Entry): void {
  const original = entry.original as unknown as Values | null, clone = entry.clone as unknown as Values;
  if (!original) return;
  const actualClone = snapshot(entry.clone, entry.ignored), actualOriginal = snapshot(entry.original, entry.ignored);
  for (const field of scalarFields) {
    const value = entry.businessOwned.has(field) ? entry.businessOwned.get(field) : entry.owned.has(field) ? entry.initial.values[field] : clone[field];
    if (!Object.is(value, entry.initial.values[field]) && sourceUnchanged(entry, field, original[field], entry.source.values[field]) && !Object.is(original[field], value)) {
      original[field] = value; entry.forwarded.set(field, original[field]);
    }
  }
  for (const field of colorFields) {
    const before = entry.initial.colors.get(field), source = entry.source.colors.get(field);
    const actual = actualClone.colors.get(field), current = actualOriginal.colors.get(field);
    if (actual && before && current && source && !same(actual, before)) {
      const target = original[field] as { copyFromFloats?: (r: number, g: number, b: number) => void } | undefined;
      const merged = current.map((value, index) => actual[index] !== before[index] && sourceUnchanged(entry, `${field}:${index}`, value, source[index]) ? actual[index] : value);
      if (target?.copyFromFloats && !same(merged, current)) {
        target.copyFromFloats(merged[0], merged[1], merged[2]);
        for (let index = 0; index < 3; index++) if (merged[index] !== current[index]) entry.forwarded.set(`${field}:${index}`, merged[index]);
      }
    }
  }
  for (const field of textureFields) {
    const current = actualClone.textures.get(field), source = actualOriginal.textures.get(field);
    if (current !== entry.initial.textures.get(field)) {
      if (sourceUnchanged(entry, field, source, entry.source.textures.get(field)) && source !== current) { original[field] = current; entry.forwarded.set(field, current); }
    } else if (current && source && current !== source && sourceUnchanged(entry, field, source, entry.source.textures.get(field))) {
      const before = entry.initial.textureStates.get(current), sourceBefore = entry.source.textureStates.get(source);
      const value = actualClone.textureStates.get(current), sourceValue = actualOriginal.textureStates.get(source);
      if (before && sourceBefore && value && sourceValue) for (const key of textureScalarFields) {
        const token = `${field}:${key}`;
        if (!Object.is(value[key], before[key]) && sourceUnchanged(entry, token, sourceValue[key], sourceBefore[key]) && !Object.is(sourceValue[key], value[key])) {
          (source as unknown as Values)[key] = value[key]; entry.forwarded.set(token, (source as unknown as Values)[key]);
        }
      }
    }
  }
  if (entry.clone instanceof MultiMaterial && entry.original instanceof MultiMaterial && entry.initial.children && entry.source.children) {
    const actual = entry.clone.subMaterials;
    for (let index = 0; index < actual.length; index++) if (actual[index] !== entry.initial.children[index]
      && entry.original.subMaterials[index] === entry.source.children[index]) entry.original.subMaterials[index] = actual[index];
    if (actual.length !== entry.initial.children.length && entry.original.subMaterials.length === entry.source.children.length) entry.original.subMaterials.length = actual.length;
  }
}

function copyOriginalChanges(entry: Entry): void {
  if (!entry.original) return;
  const source = snapshot(entry.original, entry.ignored), current = snapshot(entry.clone, entry.ignored), target = entry.clone as unknown as Values;
  for (const field of scalarFields) {
    if (entry.owned.has(field) || !Object.is(entry.initial.values[field], entry.source.values[field])) continue;
    if (!Object.is(source.values[field], entry.source.values[field]) && !Object.is(target[field], source.values[field])) target[field] = source.values[field];
  }
  for (const field of colorFields) {
    const value = source.colors.get(field), before = entry.source.colors.get(field), initial = entry.initial.colors.get(field), actual = current.colors.get(field);
    if (!value || !before || !initial || !actual) continue;
    const merged = actual.map((component, index) => value[index] !== before[index] && initial[index] === before[index] ? value[index] : component);
    const color = target[field] as { copyFromFloats?: (r: number, g: number, b: number) => void } | undefined;
    if (!same(merged, actual)) color?.copyFromFloats?.(merged[0], merged[1], merged[2]);
  }
  for (const field of textureFields) {
    const value = source.textures.get(field), before = entry.source.textures.get(field), actual = current.textures.get(field), initial = entry.initial.textures.get(field);
    if (value !== before) { if (target[field] !== value) target[field] = value; }
    else if (value && actual && actual === initial && actual !== value) {
      const values = source.textureStates.get(value), old = entry.source.textureStates.get(value), cloneInitial = entry.initial.textureStates.get(actual);
      if (values && old && cloneInitial) for (const key of textureScalarFields) {
        if (!Object.is(values[key], old[key]) && Object.is(cloneInitial[key], old[key]) && !Object.is((actual as unknown as Values)[key], values[key])) (actual as unknown as Values)[key] = values[key];
      }
    }
  }
}

/** 仅在原动态材质同步边界转发真实delta；只读resolver从不写值，静态baseline不重置。 */
export function synchronizeLightingMaterialBusinessSource(material: Material | null, target?: object): Material | null {
  const chain: Entry[] = []; const visited = new Set<Material>(); let current = material;
  while (current && entries.get(current)?.active) {
    if (visited.has(current)) throw new Error('光照显示材质来源形成循环。'); visited.add(current);
    const entry = entries.get(current)!;
    if (target && !entry.targets?.has(target)) throw new Error('动态材质不属于当前显示目标。');
    chain.push(entry); current = entry.original;
  }
  for (const entry of chain) mergeBusinessChanges(entry);
  for (const entry of [...chain].reverse()) copyOriginalChanges(entry);
  return current;
}

/** 物理source真实变化后，只更新当前目标的显示链；不遍历其它实例或重置静态审计基线。 */
export function synchronizeLightingMaterialDisplay(material: Material | null, target: object): void {
  const chain: Entry[] = []; const visited = new Set<Material>(); let current = material;
  while (current && entries.get(current)?.active) {
    if (visited.has(current)) throw new Error('光照显示材质来源形成循环。'); visited.add(current);
    const entry = entries.get(current)!;
    if (!entry.targets?.has(target)) throw new Error('动态材质不属于当前显示目标。');
    chain.push(entry); current = entry.original;
  }
  for (const entry of [...chain].reverse()) copyOriginalChanges(entry);
}

export type LightingMaterialOverrideLease = { release(): void; setOwnedScalar(field: 'wireframe', value: boolean): void };
/** 仅 GI 工作副本与入口显示副本调用；双侧各自以受控初始化后的值为基线。 */
export function registerLightingMaterialOverride(clone: Material, original: Material | null, owner: string,
  options: { ignoreTextures?: ReadonlySet<BaseTexture>; ownedWireframe?: boolean; targets?: ReadonlySet<object> } = {}): LightingMaterialOverrideLease {
  if (clone === original || entries.get(clone)?.active || isLightingMaterialOverrideOf(original, clone)) throw new Error('光照显示材质租约归属无效。');
  const ignored = options.ignoreTextures ?? noTextures;
  const entry: Entry = { clone, original, owner, ignored, targets: options.targets, source: snapshot(original, ignored), initial: snapshot(clone, ignored),
    active: true, owned: new Map(), businessOwned: new Map(), forwarded: new Map() };
  if (options.ownedWireframe) entry.owned.set('wireframe', clone.wireframe);
  entries.set(clone, entry);
  if (original) { let list = children.get(original); if (!list) { list = new Set(); children.set(original, list); } list.add(entry); }
  const lease: LightingMaterialOverrideLease = {
    setOwnedScalar(field, value) {
      if (!entry.active || !entry.owned.has(field)) throw new Error('光照显示材质字段不属于当前租约。');
      const current = (clone as unknown as Values)[field];
      if (!Object.is(current, entry.owned.get(field))) entry.businessOwned.set(field, current);
      (clone as unknown as Values)[field] = value; entry.owned.set(field, value);
    },
    release() {
      if (!entry.active) return;
      const errors: unknown[] = [];
      try {
        // 只收束已登记的后代/原始子叶配对；外部新换入的未知材质不能冒认所有权。
        const descendants = new Set(children.get(clone) ?? []);
        for (const [index, child] of entry.initial.children?.entries() ?? []) {
          const leaf = child ? entries.get(child) : undefined;
          if (leaf?.active && leaf.owner === entry.owner && leaf.original === entry.source.children?.[index]) descendants.add(leaf);
        }
        for (const child of descendants) if (child.active) {
          try { leases.get(child)?.release(); } catch (error) { errors.push(error); }
        }
        try { mergeBusinessChanges(entry); } catch (error) { errors.push(error); }
      } finally {
        entry.active = false; entries.delete(clone); if (original) children.get(original)?.delete(entry);
        leases.delete(entry);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, '光照显示材质租约释放失败，所有映射已撤销。');
    },
  };
  leases.set(entry, lease); return lease;
}
const leases = new WeakMap<Entry, LightingMaterialOverrideLease>();
