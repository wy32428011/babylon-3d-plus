/** 中台文件入口与场景发布清单分开校验；不会把任意网络地址当成固定模型资源。 */
export function resolveInspectionModelVersionUrl(fileUrl: string, platformOrigin: string): string {
  const url = new URL(fileUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== platformOrigin
    || url.username || url.password || url.hash || url.search || fileUrl.includes('\\')
    || !url.pathname.startsWith('/api/v1/files/') || url.pathname === '/api/v1/files/'
    || /%(?:2f|5c|2e|00)/i.test(url.pathname)) {
    throw new Error('高模版本必须使用当前数据中台的受控文件地址。');
  }
  return url.href;
}

/** GLB/glTF 的版本只覆盖内嵌资源，外部纹理或缓冲区不能随其他文件静默变化。 */
export function validateSelfContainedInspectionAsset(bytes: Uint8Array, extension: '.glb' | '.gltf'): void {
  let jsonBytes = bytes;
  if (extension === '.glb') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67
      || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) {
      throw new Error('高模 GLB 文件头或长度无效。');
    }
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 !== 0
      || jsonLength === 0 || 20 + jsonLength > bytes.length) {
      throw new Error('高模 GLB 缺少有效 JSON 内容。');
    }
    jsonBytes = bytes.subarray(20, 20 + jsonLength);
    let offset = 20 + jsonLength;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error('高模 GLB 数据块不完整。');
      const length = view.getUint32(offset, true);
      if (length % 4 !== 0 || offset + 8 + length > bytes.length) throw new Error('高模 GLB 数据块长度无效。');
      offset += 8 + length;
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
  } catch {
    throw new Error('高模文件的 JSON 内容无效。');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('高模文件格式无效。');
  const root = json as Record<string, unknown>;
  const asset = root.asset as { version?: unknown } | undefined;
  if (!asset || asset.version !== '2.0') throw new Error('高模必须使用 glTF 2.0 格式。');
  for (const key of ['buffers', 'images']) {
    const entries = root[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`高模 ${key} 结构无效。`);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`高模 ${key} 结构无效。`);
      const uri: unknown = entry.uri;
      if (uri !== undefined && (typeof uri !== 'string' || !/^data:[^,]*,/i.test(uri))) {
        throw new Error('爆炸图高模含外部纹理或缓冲区，请上传资源内嵌的 GLB 或 glTF。');
      }
    }
  }
}

export async function prepareInspectionModelVersionAsset(
  fileUrl: string,
  extension: '.glb' | '.gltf',
  signal: AbortSignal,
): Promise<{ url: string; dispose: () => void }> {
  const response = await fetch(fileUrl, { signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(`读取固定高模版本失败：HTTP ${response.status}。`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  validateSelfContainedInspectionAsset(new Uint8Array(data), extension);
  const url = URL.createObjectURL(new Blob([data], { type: extension === '.glb' ? 'model/gltf-binary' : 'model/gltf+json' }));
  return { url, dispose: () => URL.revokeObjectURL(url) };
}
