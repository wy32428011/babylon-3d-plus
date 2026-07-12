import path from 'node:path';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { build } from 'vite';

const workspaceRoot = process.cwd();
const outputRoot = path.resolve(workspaceRoot, 'output/playwright/yzj-production-dist');
const visualEntries = [
  path.resolve(workspaceRoot, 'output/playwright/image-library-texture-drop-check.html'),
  path.resolve(workspaceRoot, 'output/playwright/yzj-direction-arrow-check.html'),
  path.resolve(workspaceRoot, 'output/playwright/yzj-conveyor-runtime-check.html'),
];

/** 递归查找目录中的文件，供生产产物检查 hash PNG。 */
async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(entryPath));
    else files.push(entryPath);
  }
  return files;
}

/** 构建 YZJ 方向箭头生产视觉页，并复制浏览器夹具使用的模型包。 */
async function buildYzjDirectionArrowVisuals() {
  await rm(outputRoot, { recursive: true, force: true });
  await build({
    configFile: false,
    root: workspaceRoot,
    appType: 'mpa',
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      manifest: 'manifest.json',
      rollupOptions: { input: visualEntries },
    },
  });

  const fixtureTarget = path.join(outputRoot, 'output/playwright/yzj-assets');
  await mkdir(path.dirname(fixtureTarget), { recursive: true });
  await cp(path.resolve(workspaceRoot, 'output/playwright/yzj-assets'), fixtureTarget, { recursive: true, force: true });

  const outputFiles = await listFilesRecursively(outputRoot);
  const hashedDirectionArrowPngs = outputFiles.filter((filePath) => /direction-arrow-glow-[A-Za-z0-9_-]+[.]png$/i.test(path.basename(filePath)));
  if (hashedDirectionArrowPngs.length === 0) {
    throw new Error('生产构建未输出带 hash 的 direction-arrow-glow PNG。');
  }

  const pages = visualEntries.map((entry) => path.relative(workspaceRoot, entry).replaceAll('\\', '/'));
  const result = {
    outputRoot,
    pages,
    hashedDirectionArrowPngs: await Promise.all(hashedDirectionArrowPngs.map(async (filePath) => ({
      path: path.relative(outputRoot, filePath).replaceAll('\\', '/'),
      size: (await stat(filePath)).size,
    }))),
  };
  console.log(JSON.stringify(result, null, 2));
}

await buildYzjDirectionArrowVisuals();