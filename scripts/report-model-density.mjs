import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLDS, analyzeGltfJson } from '../electron/shared/modelDensityAnalysis.js';
export { DEFAULT_THRESHOLDS, analyzeGltfJson };

/**
 * GLB 面数密度与高模检测报告（只读，不修改任何资产）。
 * 只解析 GLB 的 JSON 块：三角面数取自 indices/POSITION accessor 的 count，尺寸取自 POSITION 的 min/max，
 * 再沿节点层级变换包围盒，因此 Draco/meshopt 压缩的模型也能统计，无需解码顶点。
 * 判定是启发式提示，供资产作者在 DCC 中减面或改用 LOD，不代表模型错误，也不自动降级画质。
 */

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

/** 读取 GLB 的 JSON 块；非 GLB 或损坏时抛出带原因的错误。 */
export function parseGlbJson(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('不是 GLB 文件');
  if (buffer.readUInt32LE(4) !== 2) throw new Error('只支持 glTF 2.0 GLB');
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLength > buffer.length) throw new Error('GLB 首块不是 JSON');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

async function collectGlbFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return /\.glb$/i.test(target) ? [target] : [];
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await collectGlbFiles(full));
    else if (/\.glb$/i.test(entry.name)) files.push(full);
  }
  return files;
}

/** 扫描文件/目录下全部 GLB；单个文件失败只记录原因，不中断整体报告。 */
export async function reportModelDensity(targets, thresholds = DEFAULT_THRESHOLDS) {
  const files = [...new Set((await Promise.all(targets.map(collectGlbFiles))).flat())].sort();
  const results = [];
  for (const file of files) {
    try {
      const bytes = await readFile(file);
      results.push({ file, bytes: bytes.length, ...analyzeGltfJson(parseGlbJson(bytes), thresholds) });
    } catch (error) {
      results.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const valid = results.filter(result => !result.error);
  return {
    thresholds,
    scannedFiles: files.length,
    failedFiles: results.length - valid.length,
    totalTriangles: valid.every(result => result.triangles !== null) ? valid.reduce((sum, result) => sum + result.triangles, 0) : null,
    knownTriangles: valid.reduce((sum, result) => sum + (result.triangles ?? 0), 0),
    filesWithFindings: valid.filter(result => result.findings.length).length,
    results: results.sort((a, b) => (b.triangles ?? -1) - (a.triangles ?? -1)),
  };
}

function formatText(report, top) {
  const lines = [`扫描 ${report.scannedFiles} 个 GLB（失败 ${report.failedFiles}），三角面合计${report.totalTriangles === null ? '未知（部分元数据缺失）' : `约 ${report.totalTriangles.toLocaleString()}`}（含实例），${report.filesWithFindings} 个文件有高模提示。`];
  for (const result of report.results.slice(0, top)) {
    if (result.error) { lines.push(`  ${result.file}  读取失败：${result.error}`); continue; }
    const share = report.totalTriangles && result.triangles !== null ? (result.triangles / report.totalTriangles * 100).toFixed(1) : '未知';
    const flags = Object.entries(result.compression).filter(([, used]) => used).map(([name]) => name).join('/') || '未压缩';
    lines.push(`  ${(result.triangles === null ? '未知' : result.triangles.toLocaleString()).padStart(12)} 面  ${share.padStart(5)}%  ${(result.bytes / 1048576).toFixed(1)} MB  ${flags}  ${result.file}`);
    for (const finding of result.findings.slice(0, 3)) {
      lines.push(`      - ${finding.mesh}: ${finding.triangles.toLocaleString()} 面，尺寸 ${finding.sizeMeters.join('×')} m，${finding.trianglesPerSquareMeter?.toLocaleString() ?? '-'} 面/m²  [${finding.reasons.join(',')}]`);
    }
  }
  lines.push('注意：只读启发式报告，按 glTF 米制单位计算；不修改任何资产，也不自动降低画质。');
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const targets = args.filter((arg, index) => !arg.startsWith('--') && !['--top'].includes(args[index - 1]));
  if (!targets.length) {
    console.error('用法：node scripts/report-model-density.mjs <文件或目录...> [--json] [--top 20]');
    process.exitCode = 2;
  } else {
    const report = await reportModelDensity(targets);
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatText(report, Number(option('--top') ?? 20)));
  }
}
