import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePackage } from './build-opening-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<rect width="1600" height="900" fill="#040716"/>
<ellipse cx="800" cy="470" rx="390" ry="175" fill="none" stroke="#27dfff" stroke-width="8"/>
<ellipse cx="800" cy="470" rx="300" ry="260" fill="none" stroke="#fd36c4" stroke-width="5"/>
<ellipse cx="800" cy="470" rx="170" ry="320" fill="none" stroke="#ffb65d" stroke-width="4"/>
<path d="M800 280 L940 370 L940 540 L800 640 L660 540 L660 370 Z M660 370 L800 460 L940 370 M800 460 V640" fill="#0b1940" fill-opacity=".7" stroke="#a4f8ff" stroke-width="6"/>
<circle cx="800" cy="470" r="350" fill="none" stroke="#227699" stroke-width="2"/>
</svg>`;

/** 独立构建新包，保留原示例构建器的两个包返回契约。 */
export async function buildPrismaticOpeningPackage(output = path.join(root, 'output/opening-packages')) {
  await mkdir(output, { recursive: true });
  const properties = {
    brandName: { type: 'string', title: '品牌名称', maxLength: 80 },
    heroTitle: { type: 'string', title: '核心标题', format: 'multiline', maxLength: 160 },
    tunnelTitle: { type: 'string', title: '隧道标题', format: 'multiline', maxLength: 160 },
    assemblyTitle: { type: 'string', title: '汇聚标题', format: 'multiline', maxLength: 160 },
    finaleTitle: { type: 'string', title: '展示标题', format: 'multiline', maxLength: 160 },
    accentCyan: { type: 'string', title: '青色光效', format: 'color' },
    accentMagenta: { type: 'string', title: '品红光效', format: 'color' },
    accentGold: { type: 'string', title: '金色光效', format: 'color' },
    showUI: { type: 'boolean', title: '显示播放器界面' },
    quality: { type: 'string', title: '渲染画质', enum: ['high', 'low'] },
  };
  return writePackage(output, {
    manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'prismatic-genesis', version: '1.0.0',
      name: '棱光创生 · 智能仓储开场', renderer: 'prismatic-genesis', assets: [], previewAssetId: 'cover',
      description: '棱光核心、数据隧道、粒子汇聚与仓储展示。仓库由当前场景环境模型实时渲染，需场景配置有效的环境模型。' },
    schema: { type: 'object', properties },
    uiSchema: { groups: [
      { title: '品牌与文案', fields: ['brandName', 'heroTitle', 'tunnelTitle', 'assemblyTitle', 'finaleTitle'] },
      { title: '棱光配色', fields: ['accentCyan', 'accentMagenta', 'accentGold'] },
      { title: '界面与画质', fields: ['showUI', 'quality'] },
    ] },
    defaults: { brandName: '中鼎智能', heroTitle: '智启 · 新境', tunnelTitle: '穿越数据之境',
      assemblyTitle: '万象汇聚 · 数字成境', finaleTitle: '智能仓储 · 数字孪生',
      accentCyan: '#27dfff', accentMagenta: '#fd36c4', accentGold: '#ffb65d', showUI: true, quality: 'high' },
    timeline: { handoffSeconds: .8, stages: [
      { id: 'core', label: '棱光核心', durationSeconds: 4, titleKey: 'heroTitle' },
      { id: 'tunnel', label: '数据隧道', durationSeconds: 3, titleKey: 'tunnelTitle' },
      { id: 'assembly', label: '万象汇聚', durationSeconds: 7, titleKey: 'assemblyTitle' },
      { id: 'showcase', label: '仓储展示', durationSeconds: 8, titleKey: 'finaleTitle' },
    ] },
  }, [['cover', 'assets/cover.svg', cover]]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { definition, ...result } = await buildPrismaticOpeningPackage(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(JSON.stringify(result, null, 2));
}
