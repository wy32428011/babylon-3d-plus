import path from 'node:path';
import { promises as fs } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin, PluginOption } from 'vite';

type Output = {
  type: string; fileName: string; isEntry?: boolean; imports?: string[];
  dynamicImports?: string[]; modules?: Record<string, { renderedLength: number }>;
};

/** 沿静态依赖闭包统计首批代码；动态入口单独列出，避免将全部 chunk 当成首屏。 */
export function initialChunkNames(outputs: Output[]): Set<string> {
  const chunks = new Map(outputs.filter(output => output.type === 'chunk').map(output => [output.fileName, output]));
  const initial = new Set<string>();
  const visit = (name: string) => {
    if (initial.has(name) || !chunks.has(name)) return;
    initial.add(name);
    for (const imported of chunks.get(name)!.imports ?? []) visit(imported);
  };
  for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk.fileName);
  return initial;
}

/** 分析文件直接写入独立目录，不通过 emitFile 加入 Viewer 的签名与导出清单。 */
export function buildAnalysisPlugins(target: 'editor' | 'viewer'): PluginOption[] {
  if (process.env.ANALYZE !== '1') return [];
  const reportRoot = path.resolve(process.env.ANALYZE_DIR ?? 'output/bundle-analysis', target);
  let started = 0;
  let transformed = 0;
  let generated = 0;
  let outputDirectory: string | undefined;
  let writtenOutputs: Output[] = [];
  const timing: Plugin = {
    name: 'build-analysis-timing',
    apply: 'build',
    buildStart() { started = performance.now(); },
    renderStart() { transformed = performance.now(); },
    generateBundle() { generated = performance.now(); },
  };
  const summary: Plugin = {
    name: 'build-analysis-final-files',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      if (!options.dir) throw new Error('构建分析需要目录输出。');
      outputDirectory = options.dir;
      writtenOutputs = Object.values(bundle);
    },
    async closeBundle() {
      if (!outputDirectory) return;
      const directory = outputDirectory;
      const outputs = writtenOutputs;
      const initial = initialChunkNames(outputs);
      const assets = await Promise.all(outputs.filter(output => output.type === 'asset').map(async output => {
        const content = await fs.readFile(path.join(directory, output.fileName));
        return { fileName: output.fileName, bytes: content.length, gzipBytes: gzipSync(content).length };
      }));
      const files = await fs.readdir(directory, { recursive: true, withFileTypes: true });
      const diskSizes = await Promise.all(files.filter(file => file.isFile()).map(async file =>
        (await fs.stat(path.join(file.parentPath, file.name))).size));
      const chunks = await Promise.all(outputs.filter(output => output.type === 'chunk').map(async output => {
        const content = await fs.readFile(path.join(directory, output.fileName));
        return {
          fileName: output.fileName, initial: initial.has(output.fileName), isEntry: output.isEntry,
          imports: output.imports, dynamicImports: output.dynamicImports,
          bytes: content.length, gzipBytes: gzipSync(content).length,
          // 模块 renderedLength 是 bundler 的归属估计；总量以最终 chunk 字节为准。
          modules: Object.entries(output.modules ?? {}).map(([id, module]) => ({
            id: path.relative(process.cwd(), id).replaceAll('\\', '/'), renderedBytes: module.renderedLength,
          })).sort((a, b) => b.renderedBytes - a.renderedBytes),
        };
      }));
      const totals = (selected: typeof chunks) => selected.reduce((sum, chunk) => ({
        chunks: sum.chunks + 1, bytes: sum.bytes + chunk.bytes, gzipBytes: sum.gzipBytes + chunk.gzipBytes,
      }), { chunks: 0, bytes: 0, gzipBytes: 0 });
      await fs.mkdir(reportRoot, { recursive: true });
      await fs.writeFile(path.join(reportRoot, 'summary.json'), JSON.stringify({
        target, generatedAt: new Date().toISOString(), node: process.version,
        note: 'Chunk/asset sizes are final disk bytes; gzip is per-file gzip. Module sizes are bundler estimates. Initial means static JS chunk closure, excluding CSS, runtime fetches and assets. Artifact includes copied public files. Build timings include analysis instrumentation.',
        timingsMs: { transform: transformed - started, renderAndGenerate: generated - transformed, writeAndAnalyze: performance.now() - generated },
        totals: { all: totals(chunks), initial: totals(chunks.filter(chunk => chunk.initial)), deferred: totals(chunks.filter(chunk => !chunk.initial)) },
        artifact: { files: diskSizes.length, bytes: diskSizes.reduce((sum, size) => sum + size, 0) },
        chunks, assets,
      }, null, 2) + '\n');
    },
  };
  return [timing, visualizer({ filename: path.join(reportRoot, 'modules.html'), projectRoot: process.cwd(), gzipSize: true }) as PluginOption, summary];
}
