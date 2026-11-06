export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export type ParameterValue = number | string | boolean;

export interface AuthoringParameter {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'color' | 'string';
  defaultValue: ParameterValue;
  value: ParameterValue;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  expression?: string;
}

export interface NodeSelector {
  name: string;
  path: string[];
  occurrence: number;
  gltfPointer?: string;
}

export interface AuthoringNode {
  id: string;
  name: string;
  selector: NodeSelector;
  parentId?: string;
  isMesh: boolean;
  vertexCount: number;
  indexCount: number;
  geometryFingerprint: string;
  bounds: { min: Vec3; max: Vec3 };
  materialName?: string;
  hasUV?: boolean;
}

export interface AuthoringPart {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface GeometryRule {
  id: string;
  label: string;
  enabled: boolean;
  type: 'resize' | 'stretch' | 'translate' | 'rotate' | 'array' | 'visibility' | 'color';
  targets: string[];
  axis: Axis;
  expression: string;
  anchor: 'min' | 'center' | 'max';
  fixedStart?: number;
  fixedEnd?: number;
  arrayMode?: 'count' | 'fill';
  counts?: [string, string, string];
  steps?: [string, string, string];
  fillSpan?: string;
  gap?: string;
}

export interface SurfaceAnchor {
  nodeId: string;
  faceIndex: number;
  barycentric: Vec3;
  point: Vec3;
  normal: Vec3;
  tangent: Vec3;
  referenceTriangle?: [Vec3, Vec3, Vec3];
}

export interface SurfaceRegion {
  id: string;
  label: string;
  kind: 'whole' | 'faces' | 'rectangle' | 'polygon';
  targets: string[];
  faces: Record<string, number[]>;
  anchor?: SurfaceAnchor;
  width: number;
  height: number;
  depth: number;
  rotation: number;
  offset: Vec2;
  points: Vec2[];
  backfaces: boolean;
}

export type AppearanceBindingKey = 'width' | 'height' | 'rotation' | 'opacity' | 'offsetU' | 'offsetV' | 'color' | 'visible' | 'repeatU' | 'repeatV';

export interface AppearanceLayer {
  id: string;
  label: string;
  kind: 'color' | 'decal' | 'texture';
  regionId: string;
  enabled: boolean;
  color: string;
  opacity: number;
  blend: 'tint' | 'replace';
  textureId?: string;
  rotation: number;
  width: number;
  height: number;
  offset: Vec2;
  follow: 'fixed' | 'scale' | 'tile';
  repeat: Vec2;
  uvChannel: 0 | 1;
  lockAspect?: boolean;
  bindings: Partial<Record<AppearanceBindingKey, string>>;
}

export interface AssetDescriptor {
  id: string;
  path: string;
  fileName: string;
  mediaType: string;
  sha256: string;
}

export interface BinaryAsset extends AssetDescriptor {
  bytes: Uint8Array;
}

export interface SourceModel {
  id: string;
  name: string;
  fileName: string;
  modelAssetId: string;
  sha256: string;
  unit: 'meter' | 'centimeter' | 'millimeter';
  unitScale: number;
  originalModelJson: Record<string, unknown>;
  originalMeta: Record<string, unknown>;
  scripts: Array<{ fileName: string; assetId: string; path: string }>;
  thumbnailAssetId?: string;
}

export interface AuthoringProject {
  schema: 'zending.parametric-authoring';
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: SourceModel | null;
  nodes: AuthoringNode[];
  parts: AuthoringPart[];
  parameters: AuthoringParameter[];
  rules: GeometryRule[];
  regions: SurfaceRegion[];
  layers: AppearanceLayer[];
  textureAssets: AssetDescriptor[];
  legacy: { enabled: boolean; templateId?: 'conveyor' | 'shelf' | 'shuttle'; reason?: string };
  limits: { maxInstances: number; maxLayers: number };
}

export interface AuthoringSession {
  project: AuthoringProject;
  assets: Map<string, BinaryAsset>;
}

export interface AuthoringIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  parameterKey?: string;
  ruleId?: string;
  regionId?: string;
  layerId?: string;
  nodeId?: string;
}

export interface ArchiveCandidate {
  id: string;
  name: string;
  modelPath: string;
  metaPath?: string;
  modelJsonPath?: string;
  scriptPaths: string[];
  thumbnailPath?: string;
}

export interface ImportedArchive {
  entries: Record<string, Uint8Array>;
  candidates: ArchiveCandidate[];
}

export interface CatalogModel {
  id: string;
  name: string;
  code: string;
  modelUrl: string;
  metaUrl?: string;
  modelJsonUrl?: string;
  thumbnailUrl?: string;
  scripts: Array<{ name: string; url: string }>;
}

export interface PickedSurface {
  nodeId: string;
  faceIndex: number;
  anchor: SurfaceAnchor;
  screen: Vec2;
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createEmptyProject(): AuthoringProject {
  const now = new Date().toISOString();
  return {
    schema: 'zending.parametric-authoring', version: 1, id: newId('project'), name: '未命名模型',
    createdAt: now, updatedAt: now, source: null, nodes: [], parts: [], parameters: [], rules: [],
    regions: [], layers: [], textureAssets: [], legacy: { enabled: false },
    limits: { maxInstances: 1000, maxLayers: 8 },
  };
}
