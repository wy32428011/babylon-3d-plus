const CAD_HEADER_PREVIEW_BYTES = 16 * 1024;

/** 按 DXF 声明的中文代码页解码图层/块名称；未声明时严格按 UTF-8 处理。 */
export function decodeCadDxfBytes(bytes: Uint8Array): string {
  const headerPreview = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.byteLength, CAD_HEADER_PREVIEW_BYTES)));
  const usesChineseCodePage = /\$DWGCODEPAGE[\s\S]{0,80}ANSI_936/iu.test(headerPreview);
  const encoding = usesChineseCodePage ? 'gb18030' : 'utf-8';

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    const encodingLabel = usesChineseCodePage ? 'GB18030（ANSI_936）' : 'UTF-8';
    throw new Error(`CAD/DXF 文件不是有效的 ${encodingLabel} 文本。`);
  }
}
