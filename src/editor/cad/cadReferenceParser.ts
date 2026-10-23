import { parseString } from '@linkiez/dxf-renew';
import type { ParsedDXF } from '@linkiez/dxf-renew';
import { convertParsedCadReferenceDxf, type CadReferenceParseOptions, type CadReferenceParseResult } from './cadReferenceCore';

/** 解析 DXF 文本并转换为贴近 Babylon 网格层的米制线稿数据。 */
export function parseCadReferenceDxf(content: string, options: CadReferenceParseOptions = {}): CadReferenceParseResult {
  return convertParsedCadReferenceDxf(parseDxfContent(content), options);
}

/** 调用第三方基础解析器并把失败信息转换为用户可读中文。 */
function parseDxfContent(content: string): ParsedDXF {
  try {
    return parseString(content) as ParsedDXF;
  } catch (error) {
    throw new Error(`CAD/DXF 解析失败：${readErrorMessage(error)}`, { cause: error });
  }
}

/** 从未知错误中提取简短可读信息。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
