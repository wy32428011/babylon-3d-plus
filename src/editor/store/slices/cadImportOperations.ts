import { decodeCadDxfBytes } from '../../cad/cadTextEncoding';
import type { CadImportProgress } from './editorStoreTypes';

/** 归一化导入进度，避免 UI 收到越界百分比后产生异常宽度。 */
export function createCadImportProgress(
  id: string,
  percent: number,
  label: string,
  detail: string,
  fileName: string | null,
  tone: NonNullable<CadImportProgress['tone']> = 'active',
): CadImportProgress {
  return {
    id,
    active: tone === 'active',
    tone,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    label,
    detail,
    fileName,
  };
}

/** 读取 CAD 文件响应体，并在浏览器支持流读取时按字节数更新真实读取进度。 */
export async function readCadResponseText(
  response: Response,
  fileSizeBytes: number,
  onProgress: (percent: number, detail: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  const totalBytes = fileSizeBytes > 0 ? fileSizeBytes : Number(response.headers.get('content-length') ?? 0);

  if (!reader) {
    onProgress(38, '正在读取 CAD 文件...');
    const content = decodeCadDxfBytes(new Uint8Array(await response.arrayBuffer()));
    onProgress(68, 'CAD 文件读取完成。');
    return content;
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    receivedBytes += value.byteLength;
    chunks.push(value);

    const readRatio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const percent = totalBytes > 0 ? 18 + readRatio * 50 : Math.min(68, 18 + Math.log2(receivedBytes + 1) * 3);
    const detail = totalBytes > 0
      ? `已读取 ${Math.round(readRatio * 100)}%。`
      : `已读取 ${(receivedBytes / 1024 / 1024).toFixed(1)} MB。`;
    onProgress(percent, detail);
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(68, 'CAD 文件读取完成。');
  return decodeCadDxfBytes(bytes);
}
