import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZipArchive } from 'archiver';
import { createDefaultReferenceOpening } from '../src/editor/model/sceneOpeningReference.ts';
import { REFERENCE_STAGES } from '../src/runtime/opening/reference/referenceStages.ts';
import { validateOpeningPackageDefinition } from '../electron/shared/openingPackage.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${content}</svg>`;
const campus = svg(`<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071b34"/><stop offset="1" stop-color="#03101f"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#sky)"/>
${Array.from({ length: 18 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="900" stroke="#143653" stroke-width="1"/><line x1="0" y1="${i * 60}" x2="1600" y2="${i * 60}" stroke="#143653" stroke-width="1"/>`).join('')}
<path d="M410 620 L720 365 L1420 545 L1110 800 Z" fill="#14344d" stroke="#39759c" stroke-width="3"/>
<path d="M485 660 L830 390 M650 710 L975 430 M800 755 L1130 470 M590 475 L1270 660" fill="none" stroke="#237290" stroke-width="8"/>
${[[630, 490, 160, 88], [920, 440, 180, 100], [1010, 635, 220, 96], [770, 660, 140, 72], [1230, 570, 100, 65]].map(([x, y, w, h]) => `<path d="M${x} ${y} l${w * .75} ${-h * .55} l${w * .5} ${h * .24} l${-w * .75} ${h * .55} Z" fill="#246184" stroke="#62bdd6" stroke-width="2"/><path d="M${x} ${y} v${h} l${w * .5} ${h * .24} v${-h} Z" fill="#123852" stroke="#317995"/><path d="M${x + w * .5} ${y + h * .24} l${w * .75} ${-h * .55} v${h} l${-w * .75} ${h * .55} Z" fill="#194a66" stroke="#439dbb"/>`).join('')}
<circle cx="1000" cy="575" r="190" fill="none" stroke="#39c1d8" stroke-opacity=".18" stroke-width="2"/>
<circle cx="1000" cy="575" r="260" fill="none" stroke="#39c1d8" stroke-opacity=".10" stroke-width="2"/>`);
const brand = svg(`<defs><radialGradient id="glow"><stop offset="0" stop-color="#154d78"/><stop offset="1" stop-color="#020913"/></radialGradient></defs>
<rect width="1600" height="900" fill="url(#glow)"/>
${Array.from({ length: 7 }, (_, i) => `<ellipse cx="1120" cy="440" rx="${100 + i * 65}" ry="${80 + i * 45}" fill="none" stroke="#61d3f3" stroke-opacity="${.4 - i * .045}" stroke-width="1.5"/>`).join('')}
<path d="M970 390 L1100 310 L1230 390 L1230 530 L1100 610 L970 530 Z M970 390 L1100 470 L1230 390 M1100 470 V610" fill="none" stroke="#7fe7ff" stroke-width="4"/>
<circle cx="1100" cy="460" r="220" fill="none" stroke="#317dba" stroke-opacity=".5"/>`);
const logo = svg('<path d="M180 100 L600 100 L960 450 L600 800 L180 800 L540 450 Z" fill="#69dfff"/><path d="M730 100 L1110 100 L1460 450 L1110 800 L730 800 L1080 450 Z" fill="#e1f6ff"/>');

async function writePackage(output, definition, assets) {
  const folder = path.join(output, `${definition.manifest.id}-${definition.manifest.version}`);
  await mkdir(path.join(folder, 'assets'), { recursive: true });
  definition.manifest.assets = [];
  for (const [id, assetPath, bytes] of assets) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(path.join(folder, assetPath), data);
    definition.manifest.assets.push({ id, path: assetPath, type: 'image', size: data.length, sha256: sha256(data) });
  }
  validateOpeningPackageDefinition(definition);
  const files = { 'manifest.json': definition.manifest, 'config.schema.json': definition.schema,
    'ui.schema.json': definition.uiSchema, 'defaults.json': definition.defaults, 'timeline.json': definition.timeline };
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(folder, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const zip = `${folder}.opening.zip`;
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const stream = createWriteStream(zip);
  const finished = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); });
  archive.pipe(stream);
  for (const name of Object.keys(files)) archive.file(path.join(folder, name), { name });
  for (const [, assetPath] of assets) archive.file(path.join(folder, assetPath), { name: assetPath });
  await archive.finalize(); await finished;
  const plugin = `${folder}.dtopening`;
  await copyFile(zip, plugin);
  return { id: definition.manifest.id, folder, zip, plugin, stages: definition.timeline.stages.length, definition };
}

export async function buildOpeningPackages(output = path.join(root, 'output/opening-packages')) {
  await mkdir(output, { recursive: true });
  const reference = createDefaultReferenceOpening();
  const referenceFields = {
    brandName: { type: 'string', title: '品牌名称', maxLength: 80 },
    companyName: { type: 'string', title: '公司名称', maxLength: 160 },
    heroTitle: { type: 'string', title: '开场标题', format: 'multiline', maxLength: 160 },
    heroSubtitle: { type: 'string', title: '开场说明', format: 'multiline', maxLength: 240 },
    finaleTitle: { type: 'string', title: '抵达标题', format: 'multiline', maxLength: 160 },
    arrivalDescription: { type: 'string', title: '抵达说明（留空使用公司名称）', format: 'multiline' },
    quality: { type: 'string', title: '渲染画质', enum: ['high', 'low'] },
    showUI: { type: 'boolean', title: '显示播放器界面' },
    breathingEnabled: { type: 'boolean', title: '科技呼吸效果' },
    breathingIntensity: { type: 'number', title: '呼吸强度', minimum: 0, maximum: 1 },
    breathingPeriodSeconds: { type: 'number', title: '呼吸周期（秒）', minimum: 2, maximum: 10 },
  };
  const referenceDefaults = Object.fromEntries(Object.keys(referenceFields).map(key => [key, key === 'arrivalDescription' ? '' : reference[key]]));
  Object.assign(referenceDefaults, { breathingEnabled: true, breathingIntensity: .65, breathingPeriodSeconds: 4 });
  const referenceStages = REFERENCE_STAGES.map((stage, index) => ({ id: `stage-${index + 1}`, label: stage.label,
    durationSeconds: reference.stageDurations[index], title: stage.title, subtitle: stage.en, description: stage.detail,
    ...(index === 8 ? { titleKey: 'finaleTitle', descriptionKey: 'arrivalDescription' } : {}),
    ...(index === 2 || index === 5 ? { origin: index === 2 ? reference.worldOrigin : reference.chinaOrigin,
      routes: (index === 2 ? reference.worldDestinations : reference.chinaDestinations).map((destination, routeIndex) => ({
        id: `route-${routeIndex + 1}`, name: destination.name, from: index === 2 ? reference.worldOrigin : reference.chinaOrigin,
        to: { x: destination.x, y: destination.y },
      })) } : {}),
  }));
  const referenceAssets = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const name = `asset-${index + 1}`;
    return [name, `assets/${name}.webp`, await readFile(path.join(root, `src/runtime/opening/reference/assets/${name}.webp`))];
  }));
  const first = await writePackage(output, { manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'reference-huishan', version: '1.1.0',
    name: '地球到惠山 · 参考开场', description: '保留原参考九段画面，可配置文字、时长、飞线与素材槽位。地图底图内已有文字属于像素。', renderer: 'reference-huishan', assets: [], previewAssetId: 'asset-9' },
    schema: { type: 'object', properties: referenceFields }, uiSchema: { groups: [{ title: '品牌与叙事', fields: ['brandName', 'companyName', 'heroTitle', 'heroSubtitle', 'finaleTitle', 'arrivalDescription'] }, { title: '界面与画质', fields: ['quality', 'showUI'] }, { title: '科技呼吸', fields: ['breathingEnabled', 'breathingIntensity', 'breathingPeriodSeconds'] }] },
    defaults: referenceDefaults, timeline: { stages: referenceStages, handoffSeconds: .8 } }, referenceAssets);

  const origin = { x: .63, y: .64 };
  const destinations = [['仓储中心', .45, .59], ['生产中心', .62, .49], ['物流中心', .78, .62], ['园区入口', .52, .81]];
  const second = await writePackage(output, { manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'campus-network', version: '1.0.0',
    name: '品牌与园区网络 · 自由分镜', description: '三个独立分镜，干净底图、可编辑文字和 UV 飞线，展示声明式组合能力。', renderer: 'timeline', assets: [], previewAssetId: 'campus' },
    schema: { type: 'object', properties: {
      brandTitle: { type: 'string', title: '品牌标题', format: 'multiline' }, brandSubtitle: { type: 'string', title: '品牌说明', format: 'multiline' },
      campusTitle: { type: 'string', title: '园区标题' }, campusDescription: { type: 'string', title: '园区说明', format: 'multiline' },
      arrivalTitle: { type: 'string', title: '交接标题' }, logo: { type: 'string', title: '标志素材', format: 'asset' },
    } }, uiSchema: { groups: [{ title: '品牌与说明', fields: ['brandTitle', 'brandSubtitle', 'logo'] }, { title: '园区与交接', fields: ['campusTitle', 'campusDescription', 'arrivalTitle'] }] },
    defaults: { brandTitle: '连接每一处\n智能现场', brandSubtitle: '数字孪生 · 看见真实运行', campusTitle: '让园区高效协同',
      campusDescription: '设备、空间与物流信息，在同一张画面中汇聚。', arrivalTitle: '进入数字孪生现场', logo: 'logo' },
    timeline: { handoffSeconds: .8, stages: [
      { id: 'brand', label: '品牌启航', durationSeconds: 4, titleKey: 'brandTitle', subtitleKey: 'brandSubtitle', backgroundAssetId: 'brand', logoKey: 'logo',
        textStyle: { x: .08, y: .25, fontSize: 76, color: '#eff8ff' }, subtitleStyle: { x: .08, y: .52, fontSize: 27, color: '#84d7ff' }, zoomFrom: 1, zoomTo: 1.04 },
      { id: 'network', label: '园区网络', durationSeconds: 8, titleKey: 'campusTitle', descriptionKey: 'campusDescription', backgroundAssetId: 'campus',
        textStyle: { x: .07, y: .15, fontSize: 62, color: '#eff8ff' }, subtitleStyle: { x: .07, y: .26, fontSize: 24, color: '#84d7ff' },
        zoomFrom: 1, zoomTo: 1.03, transitionSeconds: .65, origin,
        routeStyle: { color: '#55d9ff', width: 2, speed: .35, curvature: .2, trail: .15, pulse: true },
        routes: destinations.map(([name, x, y], index) => ({ id: `site-${index + 1}`, name, from: origin, to: { x, y }, ...(index === 2 ? { color: '#ffd27c' } : {}) })) },
      { id: 'arrival', label: '场景交接', durationSeconds: 3, titleKey: 'arrivalTitle', subtitle: '实时状态，即刻呈现', backgroundAssetId: 'campus',
        textStyle: { x: .5, y: .35, align: 'center', fontSize: 68, color: '#ffffff' }, subtitleStyle: { x: .5, y: .49, align: 'center', fontSize: 28, color: '#84d7ff' },
        zoomFrom: 1.03, zoomTo: 1.10, transitionSeconds: .5 },
    ] } }, [['brand', 'assets/brand.svg', brand], ['campus', 'assets/campus.svg', campus], ['logo', 'assets/logo.svg', logo]]);
  await writeFile(path.join(output, '说明.md'), '# 开场插件包\n\n在编辑器“场景属性 → 开场动画 → 导入开场包”选择 .opening.zip。每个场景独立保存实例参数。\n\nreference-huishan 是原参考画面的九段兼容模板；campus-network 使用三段通用时间线和无字 SVG 底图，可自由修改、排序、增删分镜与飞线。\n\n两个包都只含声明式 JSON 和图片，不含执行脚本。新绘制算法需要新增已注册的内置渲染能力。\n', 'utf8');
  return [first, second];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildOpeningPackages(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(JSON.stringify(result.map(({ definition, ...entry }) => entry), null, 2));
}
