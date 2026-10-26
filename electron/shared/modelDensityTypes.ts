export type SourceModelDensityFinding = {
  meshIndex: number;
  mesh: string;
  triangles: number;
  vertices: number | null;
  sizeMeters: number[];
  trianglesPerSquareMeter: number | null;
  reasons: Array<'small-high-poly' | 'dense'>;
};

/** 仅源 GLB JSON 的只读启发式，不能替代脚本生成后或实际渲染中的几何统计。 */
export type SourceModelDensity = {
  schemaVersion: 1;
  scope: 'source-glb-json';
  status: 'computed' | 'partial' | 'unavailable';
  unitScaleToMeters: number | null;
  triangles: number | null;
  uniqueTriangles: number | null;
  meshCount: number | null;
  sourceScripted: boolean;
  unknownReasons: string[];
  findings: SourceModelDensityFinding[];
  findingCount: number;
  sourceFile?: { size: number; mtimeMs: number };
};

/** 持久索引中的诊断只作可选提示；缺失/非法值丢弃，不能改变原资产是否可导入。 */
export function isSourceModelDensity(value: unknown): value is SourceModelDensity {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const nonNegative = (entry: unknown) => entry === null || (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
  if (record.schemaVersion !== 1 || record.scope !== 'source-glb-json' || !['computed', 'partial', 'unavailable'].includes(String(record.status))
    || !(record.unitScaleToMeters === null || (typeof record.unitScaleToMeters === 'number' && Number.isFinite(record.unitScaleToMeters) && record.unitScaleToMeters > 0))
    || !nonNegative(record.triangles) || !nonNegative(record.uniqueTriangles) || !nonNegative(record.meshCount)
    || typeof record.sourceScripted !== 'boolean' || !Number.isSafeInteger(record.findingCount) || (record.findingCount as number) < 0
    || !Array.isArray(record.unknownReasons) || record.unknownReasons.length > 16 || !record.unknownReasons.every(reason => typeof reason === 'string' && reason.length <= 256)
    || !Array.isArray(record.findings) || record.findings.length > 20 || (record.findingCount as number) < record.findings.length) return false;
  if (record.sourceFile !== undefined) {
    if (!record.sourceFile || typeof record.sourceFile !== 'object') return false;
    const file = record.sourceFile as Record<string, unknown>;
    if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0
      || typeof file.mtimeMs !== 'number' || !Number.isFinite(file.mtimeMs)) return false;
  }
  return record.findings.every(value => {
    if (!value || typeof value !== 'object') return false;
    const finding = value as Record<string, unknown>;
    return typeof finding.mesh === 'string' && finding.mesh.length <= 160 && Number.isSafeInteger(finding.meshIndex) && (finding.meshIndex as number) >= 0
      && typeof finding.triangles === 'number' && Number.isFinite(finding.triangles) && finding.triangles >= 0
      && nonNegative(finding.vertices) && nonNegative(finding.trianglesPerSquareMeter)
      && Array.isArray(finding.sizeMeters) && finding.sizeMeters.length === 3 && finding.sizeMeters.every(entry => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
      && Array.isArray(finding.reasons) && finding.reasons.length > 0 && finding.reasons.length <= 2 && finding.reasons.every(reason => reason === 'small-high-poly' || reason === 'dense');
  });
}
