import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readUtf8File } from '../shared/strictUtf8.js';
import { readGlbModelJsonDocument } from './modelPackageScanner.js';
import { isPathInsideOrEqual, throwIfDeploymentExportAborted } from './deploymentExportFileSystem.js';

const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** SOURCE/DIST共用原glTF URI策略；GLB仅读取有界JSON，绝不把整个模型库作为依赖。 */
export async function readModelResourceDependencies(modelPath: string, packageRoot: string, signal: AbortSignal): Promise<string[]> {
  throwIfDeploymentExportAborted(signal);
  let document: unknown;
  if (path.extname(modelPath).toLowerCase() === '.glb') document = await readGlbModelJsonDocument(modelPath);
  else {
    const stat = await fs.lstat(modelPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('glTF 主文件不是安全的普通文件。');
    if (stat.size > MAX_GLTF_JSON_BYTES) throw new Error('glTF JSON 超过安全解析上限。');
    try { document = JSON.parse(await readUtf8File(modelPath, 'glTF 文件')) as unknown; }
    catch (error) { throw new Error('glTF JSON 无法解析。', { cause: error }); }
  }
  if (!object(document)) throw new Error('glTF 文档格式不正确。');
  const uris: string[] = [];
  for (const [key, label] of [['buffers', 'glTF buffers'], ['images', 'glTF images']] as const) {
    const values = document[key]; if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`${label} 格式不正确。`);
    for (const entry of values) {
      if (!object(entry) || entry.uri === undefined) continue;
      if (typeof entry.uri !== 'string' || !entry.uri) throw new Error(`${label} URI 格式不正确。`);
      uris.push(entry.uri);
    }
  }
  const dependencies = new Set<string>();
  for (const uri of uris) {
    throwIfDeploymentExportAborted(signal);
    if (/^data:/i.test(uri)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//')) throw new Error('glTF 包含无法离线导出的远程资源 URI。');
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(uri.split(/[?#]/, 1)[0] ?? ''); }
    catch (error) { throw new Error('glTF 资源 URI 编码不正确。', { cause: error }); }
    if (!decodedPath || path.isAbsolute(decodedPath) || path.win32.isAbsolute(decodedPath)) throw new Error('glTF 资源 URI 不是安全相对路径。');
    const dependencyPath = path.resolve(path.dirname(modelPath), decodedPath);
    if (!isPathInsideOrEqual(packageRoot, dependencyPath)) throw new Error('glTF 资源 URI 逃逸模型包根目录。');
    // 显式资源缺失必须阻止两个包，不能把缺图伪装成完成离线闭包。
    let stat;
    try { stat = await fs.lstat(dependencyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`glTF 依赖文件不存在：${uri}`, { cause: error }); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('glTF 依赖不是安全的普通文件。');
    dependencies.add(dependencyPath);
  }
  throwIfDeploymentExportAborted(signal);
  return [...dependencies];
}
