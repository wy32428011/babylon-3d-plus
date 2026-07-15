import type { ParsedDXF } from '@linkiez/dxf-renew';
import {
  CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET,
  convertParsedCadReferenceDxf,
  type CadReferenceGeometryBudget,
  type CadReferenceParseOptions,
  type CadReferenceParseResult,
} from './cadReference';

/** DXF group-pair 记录，code 表示组码，value 保留原始字符串值。 */
type DxfGroupPair = {
  code: number;
  value: string;
};

/** 轻量扫描出的 DXF 实体记录，只保留 CAD 参考层需要的字段。 */
type ScannedDxfEntity = Record<string, unknown> & {
  type: string;
  layer?: string;
  vertices?: ScannedDxfVertex[];
};

/** 轻量扫描出的 DXF 顶点记录，兼容 LWPOLYLINE 与 POLYLINE。 */
type ScannedDxfVertex = {
  x: number;
  y: number;
  bulge?: number;
};

/** 轻量扫描出的 DXF 块记录，用于后续 INSERT 展开。 */
const CAD_REFERENCE_MAX_SCANNED_GEOMETRY_PER_BLOCK = 128;

type ScannedDxfBlock = Record<string, unknown> & {
  name: string;
  x: number;
  y: number;
  entities: ScannedDxfEntity[];
  scanLimited: boolean;
};

/** 大 DXF 扫描产物，结构上兼容现有 CAD 转换层需要的 ParsedDXF 子集。 */
type ScannedDxfDocument = {
  header: Record<string, number>;
  blocks: ScannedDxfBlock[];
  entities: ScannedDxfEntity[];
  scanLimited: boolean;
};

/** 按 group-pair 顺序读取 DXF 文本，避免 split 产生数千万行数组。 */
class DxfGroupReader {
  private offset = 0;
  private pending = false;
  private pendingCode = 0;
  private pendingValue = '';
  private readonly currentGroup: DxfGroupPair = { code: 0, value: '' };

  /** 创建 DXF group-pair 读取器。 */
  constructor(private readonly content: string) {}

  /** 复用同一个 group 对象读取下一组 code/value，避免数千万次临时对象分配。 */
  next(): DxfGroupPair | null {
    if (this.pending) {
      this.pending = false;
      this.currentGroup.code = this.pendingCode;
      this.currentGroup.value = this.pendingValue;
      return this.currentGroup;
    }

    const codeLine = this.readLine();
    if (codeLine === null) return null;
    const valueLine = this.readLine();
    if (valueLine === null) return null;

    this.currentGroup.code = Number.parseInt(codeLine, 10);
    this.currentGroup.value = valueLine.trim();
    return this.currentGroup;
  }

  /** 复制当前组码和值用于单步回退，避免持有会被复用的 currentGroup 引用。 */
  unread(group: DxfGroupPair): void {
    this.pending = true;
    this.pendingCode = group.code;
    this.pendingValue = group.value;
  }

  /** 使用原生 indexOf 定位换行，避免逐字符扫描数亿字符。 */
  private readLine(): string | null {
    if (this.offset >= this.content.length) return null;

    const start = this.offset;
    const newlineIndex = this.content.indexOf('\n', start);
    if (newlineIndex < 0) {
      this.offset = this.content.length;
      return this.content.slice(start).replace(/\r$/, '');
    }

    this.offset = newlineIndex + 1;
    const end = newlineIndex > start && this.content.charCodeAt(newlineIndex - 1) === 13
      ? newlineIndex - 1
      : newlineIndex;
    return this.content.slice(start, end);
  }
}

/** 使用预算驱动的大文件扫描路径解析 DXF，不调用第三方完整 parseString。 */
export function parseLargeCadReferenceDxf(
  content: string,
  budget: CadReferenceGeometryBudget = CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET,
  options: Omit<CadReferenceParseOptions, 'geometryBudget'> = {},
): CadReferenceParseResult {
  const parsed = scanLargeDxfDocument(content);
  const result = convertParsedCadReferenceDxf(parsed as unknown as ParsedDXF, { ...options, geometryBudget: budget });
  result.budgetLimited = result.budgetLimited || parsed.scanLimited;
  return result;
}

/** 扫描 DXF 文档的 HEADER、BLOCKS 与 ENTITIES 三个关键区段。 */
function scanLargeDxfDocument(content: string): ScannedDxfDocument {
  const reader = new DxfGroupReader(content);
  const document: ScannedDxfDocument = { header: {}, blocks: [], entities: [], scanLimited: false };

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code !== 0 || group.value !== 'SECTION') continue;
    const sectionName = reader.next();
    if (!sectionName || sectionName.code !== 2) continue;

    if (sectionName.value === 'HEADER') {
      scanHeaderSection(reader, document.header);
    } else if (sectionName.value === 'BLOCKS') {
      const blocks = scanBlocksSection(reader);
      document.blocks.push(...blocks);
      document.scanLimited = document.scanLimited || blocks.some((block) => block.scanLimited);
    } else if (sectionName.value === 'ENTITIES') {
      document.entities.push(...scanEntitiesSection(reader));
    } else {
      skipCurrentSection(reader);
    }
  }

  return document;
}

/** 扫描 HEADER 区段中的 INSUNITS 与 MEASUREMENT，保证大文件单位策略和精确解析一致。 */
function scanHeaderSection(reader: DxfGroupReader, header: Record<string, number>): void {
  let variableName = '';
  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'ENDSEC') return;
    if (group.code === 9) {
      variableName = group.value.replace(/^\$/, '').toUpperCase();
      continue;
    }
    if ((variableName === 'INSUNITS' || variableName === 'MEASUREMENT') && isNumericGroupValue(group.value)) {
      header[variableName] = Number(group.value);
      variableName = '';
    }
  }
}

/** 扫描 BLOCKS 区段，保留块名、基点和块内基础线稿实体。 */
function scanBlocksSection(reader: DxfGroupReader): ScannedDxfBlock[] {
  const blocks: ScannedDxfBlock[] = [];

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'ENDSEC') return blocks;
    if (group.code === 0 && group.value === 'BLOCK') {
      blocks.push(readBlockRecord(reader));
    }
  }

  return blocks;
}

/** 读取单个 BLOCK，直到 ENDBLK 结束。 */
function readBlockRecord(reader: DxfGroupReader): ScannedDxfBlock {
  const block: ScannedDxfBlock = { name: '', x: 0, y: 0, entities: [], scanLimited: false };
  let scannedGeometryCount = 0;

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'ENDBLK') return block;
    if (group.code === 0) {
      const entity = readEntityAfterType(reader, group.value);
      if (entity?.type === 'INSERT') {
        block.entities.push(entity);
      } else if (entity && scannedGeometryCount < CAD_REFERENCE_MAX_SCANNED_GEOMETRY_PER_BLOCK) {
        block.entities.push(entity);
        scannedGeometryCount += 1;
      } else if (entity) {
        block.scanLimited = true;
      }
      continue;
    }

    applyBlockHeaderGroup(block, group);
  }

  return block;
}

/** 扫描 ENTITIES 区段，保留顶层实体和 INSERT。 */
function scanEntitiesSection(reader: DxfGroupReader): ScannedDxfEntity[] {
  const entities: ScannedDxfEntity[] = [];

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'ENDSEC') return entities;
    if (group.code === 0) {
      const entity = readEntityAfterType(reader, group.value);
      if (entity) entities.push(entity);
    }
  }

  return entities;
}

/** 跳过当前无需解析的 DXF SECTION。 */
function skipCurrentSection(reader: DxfGroupReader): void {
  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'ENDSEC') return;
  }
}

/** 按实体类型分派轻量读取逻辑。 */
function readEntityAfterType(reader: DxfGroupReader, type: string): ScannedDxfEntity | null {
  if (type === 'POLYLINE') return readPolylineEntity(reader);
  if (!isSupportedScannedEntityType(type)) {
    skipUnsupportedEntity(reader);
    return null;
  }

  return readBasicEntity(reader, type);
}

/** 读取 LINE、ARC、CIRCLE、LWPOLYLINE 与 INSERT 的基础字段。 */
function readBasicEntity(reader: DxfGroupReader, type: string): ScannedDxfEntity {
  const entity: ScannedDxfEntity = { type };
  let currentVertex: ScannedDxfVertex | null = null;

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0) {
      reader.unread(group);
      break;
    }
    currentVertex = applyEntityGroup(entity, group, currentVertex);
  }

  return entity;
}

/** 读取旧式 POLYLINE 的 VERTEX 列表，直到 SEQEND 结束。 */
function readPolylineEntity(reader: DxfGroupReader): ScannedDxfEntity {
  const entity: ScannedDxfEntity = { type: 'POLYLINE', vertices: [] };

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0 && group.value === 'SEQEND') return entity;
    if (group.code === 0 && group.value === 'VERTEX') {
      const vertex = readPolylineVertex(reader);
      if (vertex) entity.vertices?.push(vertex);
      continue;
    }
    if (group.code === 0) {
      reader.unread(group);
      return entity;
    }
    applyEntityHeaderGroup(entity, group);
  }

  return entity;
}

/** 读取旧式 POLYLINE 的单个 VERTEX。 */
function readPolylineVertex(reader: DxfGroupReader): ScannedDxfVertex | null {
  const vertex: ScannedDxfVertex = { x: Number.NaN, y: Number.NaN, bulge: 0 };

  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0) {
      reader.unread(group);
      break;
    }
    if (group.code === 10) vertex.x = readDxfNumber(group.value, Number.NaN);
    if (group.code === 20) vertex.y = readDxfNumber(group.value, Number.NaN);
    if (group.code === 42) vertex.bulge = readDxfNumber(group.value, 0);
  }

  return Number.isFinite(vertex.x) && Number.isFinite(vertex.y) ? vertex : null;
}

/** 跳过不参与显示的实体记录。 */
function skipUnsupportedEntity(reader: DxfGroupReader): void {
  for (let group = reader.next(); group; group = reader.next()) {
    if (group.code === 0) {
      reader.unread(group);
      return;
    }
  }
}

/** 应用 BLOCK 头字段，兼容 name 与 base point。 */
function applyBlockHeaderGroup(block: ScannedDxfBlock, group: DxfGroupPair): void {
  if (group.code === 2 || group.code === 3) block.name = group.value || block.name;
  if (group.code === 10) block.x = readDxfNumber(group.value, block.x);
  if (group.code === 20) block.y = readDxfNumber(group.value, block.y);
}

/** 应用实体头部字段，主要用于图层、闭合标志和法线。 */
function applyEntityHeaderGroup(entity: ScannedDxfEntity, group: DxfGroupPair): void {
  if (group.code === 8) entity.layer = group.value || '0';
  if (group.code === 70) entity.closed = (readDxfInteger(group.value, 0) & 1) === 1;
  if (group.code === 210) entity.extrusionX = readDxfNumber(group.value, 0);
  if (group.code === 220) entity.extrusionY = readDxfNumber(group.value, 0);
  if (group.code === 230) entity.extrusionZ = readDxfNumber(group.value, 1);
}

/** 应用单个 group-pair 到实体，并维护 LWPOLYLINE 当前顶点。 */
function applyEntityGroup(entity: ScannedDxfEntity, group: DxfGroupPair, currentVertex: ScannedDxfVertex | null): ScannedDxfVertex | null {
  applyEntityHeaderGroup(entity, group);

  if (entity.type === 'LINE') applyLineGroup(entity, group);
  if (entity.type === 'ARC' || entity.type === 'CIRCLE') applyArcCircleGroup(entity, group);
  if (entity.type === 'LWPOLYLINE') return applyLightweightPolylineGroup(entity, group, currentVertex);
  if (entity.type === 'INSERT') applyInsertGroup(entity, group);

  return currentVertex;
}

/** 应用 LINE 起止点字段。 */
function applyLineGroup(entity: ScannedDxfEntity, group: DxfGroupPair): void {
  const start = readOrCreatePointRecord(entity, 'start');
  const end = readOrCreatePointRecord(entity, 'end');
  if (group.code === 10) start.x = readDxfNumber(group.value, Number.NaN);
  if (group.code === 20) start.y = readDxfNumber(group.value, Number.NaN);
  if (group.code === 11) end.x = readDxfNumber(group.value, Number.NaN);
  if (group.code === 21) end.y = readDxfNumber(group.value, Number.NaN);
}

/** 应用 ARC/CIRCLE 中心、半径和角度字段，DXF 角度从度转换为弧度。 */
function applyArcCircleGroup(entity: ScannedDxfEntity, group: DxfGroupPair): void {
  if (group.code === 10) entity.x = readDxfNumber(group.value, Number.NaN);
  if (group.code === 20) entity.y = readDxfNumber(group.value, Number.NaN);
  if (group.code === 40) entity.r = readDxfNumber(group.value, 0);
  if (group.code === 50) entity.startAngle = degreesToRadians(readDxfNumber(group.value, 0));
  if (group.code === 51) entity.endAngle = degreesToRadians(readDxfNumber(group.value, 0));
}

/** 应用 LWPOLYLINE 顶点、bulge 和闭合字段。 */
function applyLightweightPolylineGroup(entity: ScannedDxfEntity, group: DxfGroupPair, currentVertex: ScannedDxfVertex | null): ScannedDxfVertex | null {
  if (!entity.vertices) entity.vertices = [];
  if (group.code === 10) {
    const vertex: ScannedDxfVertex = { x: readDxfNumber(group.value, Number.NaN), y: Number.NaN, bulge: 0 };
    entity.vertices.push(vertex);
    return vertex;
  }
  if (group.code === 20 && currentVertex) currentVertex.y = readDxfNumber(group.value, Number.NaN);
  if (group.code === 42 && currentVertex) currentVertex.bulge = readDxfNumber(group.value, 0);
  return currentVertex;
}

/** 应用 INSERT 块引用字段，字段名对齐现有展开逻辑。 */
function applyInsertGroup(entity: ScannedDxfEntity, group: DxfGroupPair): void {
  if (group.code === 2) entity.block = group.value;
  if (group.code === 10) entity.x = readDxfNumber(group.value, 0);
  if (group.code === 20) entity.y = readDxfNumber(group.value, 0);
  if (group.code === 41) entity.scaleX = readDxfNumber(group.value, 1);
  if (group.code === 42) entity.scaleY = readDxfNumber(group.value, 1);
  if (group.code === 43) entity.scaleZ = readDxfNumber(group.value, 1);
  if (group.code === 44) entity.columnSpacing = readDxfNumber(group.value, 0);
  if (group.code === 45) entity.rowSpacing = readDxfNumber(group.value, 0);
  if (group.code === 50) entity.rotation = readDxfNumber(group.value, 0);
  if (group.code === 70) entity.columnCount = readPositiveDxfInteger(group.value, 1);
  if (group.code === 71) entity.rowCount = readPositiveDxfInteger(group.value, 1);
}

/** 读取或初始化点对象，供 LINE 字段复用。 */
function readOrCreatePointRecord(entity: ScannedDxfEntity, key: 'start' | 'end'): Record<string, number> {
  const existing = entity[key];
  if (typeof existing === 'object' && existing !== null) return existing as Record<string, number>;
  const created = { x: Number.NaN, y: Number.NaN };
  entity[key] = created;
  return created;
}

/** 判断实体类型是否属于大文件预扫描支持范围。 */
function isSupportedScannedEntityType(type: string): boolean {
  return type === 'LINE' || type === 'ARC' || type === 'CIRCLE' || type === 'LWPOLYLINE' || type === 'INSERT';
}

/** 判断字符串是否可转为有限数字。 */
function isNumericGroupValue(value: string): boolean {
  return Number.isFinite(Number(value));
}

/** 将 DXF 数值字符串转为有限数字，失败时使用回退值。 */
function readDxfNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 将 DXF 整数字符串转为整数，失败时使用回退值。 */
function readDxfInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 将 DXF 阵列数量转为正整数，避免 0 或负数制造无效展开。 */
function readPositiveDxfInteger(value: string, fallback: number): number {
  return Math.max(1, readDxfInteger(value, fallback));
}

/** 将 DXF 角度制转换为当前转换层使用的弧度制。 */
function degreesToRadians(degrees: number): number {
  return (degrees / 180) * Math.PI;
}
