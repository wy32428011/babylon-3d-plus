const CAD_HEADER_PREVIEW_BYTES = 16 * 1024;

type CadDxfEncoding = 'utf-8' | 'gb18030';

/** AutoCAD 2007 起 DXF 使用 UTF-8；旧版才依据中文代码页声明解码。 */
function detectCadDxfEncoding(bytes: Uint8Array): CadDxfEncoding {
  const headerPreview = new TextDecoder('utf-8').decode(bytes.subarray(0, CAD_HEADER_PREVIEW_BYTES));
  const version = /\$ACADVER[\s\S]{0,80}?AC(\d{4})/iu.exec(headerPreview);
  if (version && Number(version[1]) >= 1021) return 'utf-8';
  return /\$DWGCODEPAGE[\s\S]{0,80}ANSI_936/iu.test(headerPreview) ? 'gb18030' : 'utf-8';
}

function decodeCadDxfChunk(decoder: TextDecoder, bytes: Uint8Array | undefined, final: boolean): string {
  try {
    return decoder.decode(bytes, { stream: !final });
  } catch {
    const encodingLabel = decoder.encoding === 'gb18030' ? 'GB18030（ANSI_936）' : 'UTF-8';
    throw new Error(`CAD/DXF 文件不是有效的 ${encodingLabel} 文本。`);
  }
}

/** 整块与流式读取采用相同编码规则，非法字节不会替换为乱码后继续导入。 */
export function decodeCadDxfBytes(bytes: Uint8Array): string {
  return decodeCadDxfChunk(new TextDecoder(detectCadDxfEncoding(bytes), { fatal: true }), bytes, true);
}

export type CadDxfStreamDecoder = {
  decode: (bytes?: Uint8Array, final?: boolean) => string;
};

/** 只缓存首 16 KiB 探测编码；后续保留解码器状态以处理跨块多字节字符。 */
export function createCadDxfStreamDecoder(): CadDxfStreamDecoder {
  let preview: Uint8Array | null = new Uint8Array(CAD_HEADER_PREVIEW_BYTES);
  let previewLength = 0;
  let decoder: TextDecoder | null = null;
  let ended = false;

  return {
    decode(bytes = new Uint8Array(0), final = false): string {
      if (ended) throw new Error('CAD/DXF 流式解码已结束。');
      if (final) ended = true;
      if (decoder) return decodeCadDxfChunk(decoder, bytes, final);

      const prefix = preview!;
      const copiedBytes = Math.min(bytes.byteLength, prefix.byteLength - previewLength);
      prefix.set(bytes.subarray(0, copiedBytes), previewLength);
      previewLength += copiedBytes;
      if (previewLength < prefix.byteLength && !final) return '';

      const header = prefix.subarray(0, previewLength);
      decoder = new TextDecoder(detectCadDxfEncoding(header), { fatal: true });
      preview = null;
      const remaining = bytes.subarray(copiedBytes);
      const firstText = decodeCadDxfChunk(decoder, header, final && remaining.byteLength === 0);
      return remaining.byteLength > 0 ? firstText + decodeCadDxfChunk(decoder, remaining, final) : firstText;
    },
  };
}
