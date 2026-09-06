/** 严格解码 UTF-8；拒绝用替换字符掩盖损坏字节，并兼容标准 UTF-8 BOM。 */
export function decodeUtf8Text(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${context}不是有效的 UTF-8 文本。`);
  }
}

/** 从 Fetch Response 读取严格 UTF-8 文本，供 JSON、场景和脚本入口复用。 */
export async function readUtf8ResponseText(response: Response, context: string): Promise<string> {
  return decodeUtf8Text(new Uint8Array(await response.arrayBuffer()), context);
}
