import { promises as fs } from 'node:fs';

/**
 * 严格解码 UTF-8；拒绝用替换字符掩盖损坏字节，并兼容标准 UTF-8 BOM。
 * @param {Uint8Array} bytes
 * @param {string} context
 * @returns {string}
 */
export function decodeUtf8Text(bytes, context) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${context}不是有效的 UTF-8 文本。`);
  }
}

/**
 * 严格读取 UTF-8 文件，避免 Node 宽松解码把损坏字节静默变成页面中的替换字符。
 * @param {string} filePath
 * @param {string} context
 * @returns {Promise<string>}
 */
export async function readUtf8File(filePath, context) {
  return decodeUtf8Text(await fs.readFile(filePath), context);
}
