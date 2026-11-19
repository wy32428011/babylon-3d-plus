export type CadReferenceAnnotation = {
  text: string;
  x: number;
  y: number;
  height: number;
  /** 从 CAD +X 朝 +Y 旋转的弧度。 */
  rotationRadians: number;
  horizontalAlignment: 'left' | 'center' | 'right';
  verticalAlignment: 'baseline' | 'bottom' | 'middle' | 'top';
  layerName?: string;
  widthFactor?: number;
  lineSpacingFactor?: number;
  fit?: { widthInHeights: number; preserveAspectRatio: boolean };
  flipX?: boolean;
  flipY?: boolean;
};

type Group = { code: number; value: string };

const TEXT_VERTICAL_ALIGNMENTS = ['baseline', 'bottom', 'middle', 'top'] as const;
const MTEXT_VERTICAL_ALIGNMENTS = ['top', 'middle', 'bottom'] as const;
const HORIZONTAL_ALIGNMENTS = ['left', 'center', 'right'] as const;
const TEXT_ESCAPES = /\\U\+[\da-f]{4}|%%[%dpcou]/giu;
const MTEXT_ESCAPES =
  /\\(?:U\+[\dA-Fa-f]{4}|[\\{}~PNKkLlOo]|[ACcFfHQSTWp][^;\\]*;)|[{}]|%%[%dDpPcCoOuU]/gu;
const PERCENT_ESCAPES: Record<string, string> = {
  '%%%': '%',
  '%%c': '⌀',
  '%%d': '°',
  '%%o': '',
  '%%p': '±',
  '%%u': '',
};

function decodeTextEscape(token: string): string {
  if (token[0] === '\\') return String.fromCharCode(Number.parseInt(token.slice(3), 16));
  return PERCENT_ESCAPES[token.toLowerCase()] ?? token;
}

function decodeMTextEscape(token: string): string {
  if (token[0] === '%' || token.startsWith('\\U+')) return decodeTextEscape(token);
  switch (token) {
    case '\\P':
    case '\\N':
      return '\n';
    case '\\~':
      return ' ';
    case '\\\\':
    case '\\{':
    case '\\}':
      return token[1];
    default:
      return token.startsWith('\\S') ? token.slice(2, -1).replace(/[#^]/gu, '/') : '';
  }
}

function readFiniteNumber(value: string | undefined, fallback: number): number {
  const number = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

function readGroupNumber(groups: readonly Group[], code: number, fallback = Number.NaN): number {
  return readFiniteNumber(groups.find((group) => group.code === code)?.value, fallback);
}

function readMTextRotation(groups: readonly Group[]): number {
  let directionIndex = -1;
  let angleIndex = -1;
  for (const [index, { code }] of groups.entries()) {
    // MTEXT 分栏定义之后的组码 50 表示列高。
    if (code === 75) break;
    if (code === 11 || code === 21 || code === 31) directionIndex = index;
    if (code === 50) angleIndex = index;
  }
  // DXF MTEXT 旋转角以弧度给出，方向向量与角度均存在时采用后出现的定义。
  if (angleIndex > directionIndex) return readFiniteNumber(groups[angleIndex].value, 0);
  return Math.atan2(readGroupNumber(groups, 21, 0), readGroupNumber(groups, 11, 1));
}

/** 读取顶层平面文字。位置与高度保留 DXF 单位，组码 1/3 保留原始空格。 */
export function readCadReferenceAnnotation(
  type: string,
  groups: readonly Group[],
): CadReferenceAnnotation | null {
  const multiline = type === 'MTEXT';
  if (type !== 'TEXT' && !multiline) return null;

  const height = readGroupNumber(groups, 40);
  const extrusionZ = readGroupNumber(groups, 230, 1);
  if (
    !Number.isFinite(height) ||
    height <= 0 ||
    extrusionZ === 0 ||
    readGroupNumber(groups, 210, 0) !== 0 ||
    readGroupNumber(groups, 220, 0) !== 0
  ) {
    return null;
  }

  const rawText = groups
    .filter(({ code }) => code === 1 || (multiline && code === 3))
    .map(({ value }) => value)
    .join('');
  const text = multiline
    ? rawText.replace(MTEXT_ESCAPES, decodeMTextEscape)
    : rawText.replace(TEXT_ESCAPES, decodeTextEscape);
  if (!text.trim()) return null;

  const layerName = groups.find(({ code }) => code === 8)?.value.trim() || '0';
  const insertX = readGroupNumber(groups, 10);
  const insertY = readGroupNumber(groups, 20);
  if (multiline) {
    if (!Number.isFinite(insertX) || !Number.isFinite(insertY)) return null;
    const attachment = readGroupNumber(groups, 71, 1) - 1;
    const lineSpacing = readGroupNumber(groups, 44, 1);
    return {
      text,
      layerName,
      x: insertX,
      y: insertY,
      height,
      rotationRadians: readMTextRotation(groups),
      horizontalAlignment: HORIZONTAL_ALIGNMENTS[attachment % 3] ?? 'left',
      verticalAlignment: MTEXT_VERTICAL_ALIGNMENTS[Math.floor(attachment / 3)] ?? 'top',
      lineSpacingFactor: lineSpacing >= 0.25 && lineSpacing <= 4 ? lineSpacing : 1,
      flipY: extrusionZ < 0,
    };
  }

  const horizontal = readGroupNumber(groups, 72, 0);
  const vertical = readGroupNumber(groups, 73, 0);
  const alignX = readGroupNumber(groups, 11);
  const alignY = readGroupNumber(groups, 21);
  const hasAlignmentPoint = Number.isFinite(alignX) && Number.isFinite(alignY);
  const useFit = horizontal === 3 || horizontal === 5;
  const useAlignmentPoint = hasAlignmentPoint && !useFit && (horizontal !== 0 || vertical !== 0);
  const x = useAlignmentPoint ? alignX : insertX;
  const y = useAlignmentPoint ? alignY : insertY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const fitWidth = useFit && hasAlignmentPoint ? Math.hypot(alignX - x, alignY - y) : 0;
  const widthInHeights = fitWidth / height;
  const fit =
    Number.isFinite(widthInHeights) && widthInHeights > 0
      ? { widthInHeights, preserveAspectRatio: horizontal === 3 }
      : undefined;
  const rotation = fit
    ? Math.atan2(alignY - y, alignX - x)
    : (readGroupNumber(groups, 50, 0) / 180) * Math.PI;
  const generationFlags = readGroupNumber(groups, 71, 0);
  const reverseExtrusion = extrusionZ < 0;
  const widthFactor = readGroupNumber(groups, 41, 1);
  return {
    text,
    layerName,
    x: reverseExtrusion ? -x : x,
    y,
    height,
    rotationRadians: reverseExtrusion ? -rotation : rotation,
    horizontalAlignment:
      horizontal === 4 ? 'center' : (HORIZONTAL_ALIGNMENTS[horizontal] ?? 'left'),
    verticalAlignment:
      horizontal === 4 ? 'middle' : (TEXT_VERTICAL_ALIGNMENTS[vertical] ?? 'baseline'),
    widthFactor: widthFactor > 0 ? widthFactor : 1,
    fit,
    flipX: ((generationFlags & 2) !== 0) !== reverseExtrusion,
    flipY: (generationFlags & 4) !== 0,
  };
}
