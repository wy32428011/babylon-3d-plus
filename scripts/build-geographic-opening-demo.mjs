import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';

const root = process.cwd();
const output = path.join(root, 'output/geographic-opening');
await mkdir(output, { recursive: true });
const result = await build({
  configFile: false, root, base: './', publicDir: false,
  build: { write: false, minify: true, target: 'es2022', assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rolldownOptions: { input: path.join(root, 'tests/fixtures/geographicOpeningDemo.html'), output: { codeSplitting: false } },
  },
});
const assets = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const documentAsset = assets.find(item => item.type === 'asset' && item.fileName.endsWith('.html'));
const script = assets.find(item => item.type === 'chunk' && item.isEntry);
if (!documentAsset || !script) throw new Error('离线示意打包缺少 HTML 或入口脚本');
let html = String(documentAsset.source);
html = html.replace(/<script\b[^>]*src="[^"]*"[^>]*><\/script>/, () => `<script type="module">${script.code.replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '');
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '');
html = html.replace('</head>', `${assets.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<style>${String(item.source)}</style>`).join('\n')}</head>`);
const htmlPath = path.join(output, 'geographic-opening-demo.html');
await writeFile(htmlPath, html, 'utf8');
const guide = `# 中鼎智能数字孪生开场动画\n\n双击 geographic-opening-demo.html 即可离线播放，使用 Chrome / Edge。地图、绘制与界面依据用户提供的 zd_digital_twin_opening.html，全部素材内置，无网络依赖。\n\n默认62秒、9个阶段：旋转地球9秒 → 地球展开7秒 → 全球业务8秒 → 中国全景6秒 → 江苏高亮4秒 → 国内业务8秒 → 江苏全景6秒 → 无锡全景6秒 → 抵达惠山8秒。全球40条、国内34条示意路线。最后0.8秒显露已经加载的示例园区，不重建业务相机。\n\n支持暂停、播放、拖动进度、章节跳转、重播和跳过。产品入口：场景属性 → 开场动画，开关默认关闭，九段时长、文案、高清/流畅、界面显示、呼吸、画面坐标与路线均可配置，启用后保存并重新发布。\n\n飞线使用参考图归一化画面坐标，非经纬度；末尾园区是自建演示模型，不代表真实项目。惠山图片中的公司名、地图注记属于图片像素，文案配置只控制叠加文字。素材来源与边界详见 geographic-opening-data.md。\n`;
await writeFile(path.join(output, '下载说明.md'), guide, 'utf8');
const archive = new ZipArchive({ zlib: { level: 9 } });
const stream = createWriteStream(path.join(output, 'geographic-opening-offline.zip'));
const finished = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); });
archive.pipe(stream);
archive.file(htmlPath, { name: 'geographic-opening-demo.html' });
archive.append(guide, { name: '下载说明.md' });
archive.file(path.join(root, 'docs/geographic-opening-data.md'), { name: 'geographic-opening-data.md' });
await archive.finalize(); await finished;
console.log(JSON.stringify({ html: htmlPath, zip: path.join(output, 'geographic-opening-offline.zip') }));
