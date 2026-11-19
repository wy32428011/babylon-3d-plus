import type { DxfGroupPair } from './cadReferenceLargeDxf';

const BASIC_ACI_COLORS = [
  '#000000',
  '#ff0000',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#0000ff',
  '#ff00ff',
  '#ffffff',
  '#808080',
  '#c0c0c0',
];

export const NDC8_POINT_LAYER_NAME = 'Ndc8_Point';
export type CadReferenceFillCircle = { x: number; y: number; radius: number };

/** 原图优先使用 DXF 真彩色，标准 ACI 色适配深色视口。 */
export function readCadLayerColor(groups: readonly DxfGroupPair[]): [string, string] | null {
  const name = groups.find((group) => group.code === 2)?.value;
  const trueColor = Number(groups.find((group) => group.code === 420)?.value);
  const aci = Math.abs(Number(groups.find((group) => group.code === 62)?.value));
  const color =
    Number.isInteger(trueColor) && trueColor >= 0 && trueColor <= 0xffffff
      ? '#' + trueColor.toString(16).padStart(6, '0')
      : BASIC_ACI_COLORS[aci];
  return name && color ? [name, color] : null;
}

/** NDC8 的点位填充为仅含一个完整圆弧边界的实心 HATCH。 */
export function readNdc8PointFill(groups: readonly DxfGroupPair[]): CadReferenceFillCircle | null {
  const value = (code: number) => groups.find((group) => group.code === code)?.value;
  if (
    value(8)?.toLowerCase() !== NDC8_POINT_LAYER_NAME.toLowerCase() ||
    value(67) === '1' ||
    value(2) !== 'SOLID' ||
    value(70) !== '1' ||
    value(91) !== '1'
  )
    return null;
  const edgeIndex = groups.findIndex((group) => group.code === 72 && group.value === '2');
  if (edgeIndex < 0 || value(93) !== '1' || (Number(value(92)) & 2) !== 0) return null;
  const edge = groups.slice(edgeIndex + 1);
  const number = (code: number) => Number(edge.find((group) => group.code === code)?.value);
  const x = number(10);
  const y = number(20);
  const radius = number(40);
  if (
    ![x, y, radius].every(Number.isFinite) ||
    radius <= 0 ||
    Math.abs(number(51) - number(50)) !== 360
  )
    return null;
  return { x, y, radius };
}
