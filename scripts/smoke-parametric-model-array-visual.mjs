import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';

const workspace = process.cwd();
const modelRoot = path.resolve(process.env.BABYLON_MODEL_ROOT ?? path.join(workspace, '..', '3d-models', 'models'));
const scenePath = path.resolve(process.env.BABYLON_SCENE_PATH ?? String.raw`F:\3d-projects\Untitled Scene.scene(1).json`);
const configuredReportPath = process.env.BABYLON_MODEL_ARRAY_VISUAL_REPORT?.trim();
const expectedPackageCount = 16;
const screenshotWidth = 1280;
const screenshotHeight = 800;
const pixelDifferenceThreshold = 24;
const outputStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.join(workspace, 'output', 'model-array-validation', `visual-${outputStamp}`);
const originalSceneBytes = await fs.readFile(scenePath);
const originalSceneHash = createHash('sha256').update(originalSceneBytes).digest('hex');

function unitScaleToMeters(lengthUnit) {
  if (lengthUnit === 'millimeter') return 0.001;
  if (lengthUnit === 'centimeter') return 0.01;
  return 1;
}

function defaultValues(meta) {
  return Object.fromEntries((meta.modelParameters?.parameters ?? []).map((item) => [item.key, item.defaultValue]));
}

function createChangedValue(definition, defaults) {
  const current = Number(defaults[definition.key]);
  const config = definition.configuration ?? definition;
  const minimum = Number.isFinite(Number(config.min)) ? Number(config.min) : Number.NEGATIVE_INFINITY;
  const maximum = Number.isFinite(Number(config.max)) ? Number(config.max) : Number.POSITIVE_INFINITY;
  const isCount = /count|density/i.test(definition.key) && Number.isInteger(current);
  let next = isCount ? current + 1 : current * 1.2;
  if (!Number.isFinite(next) || Math.abs(next - current) < 1e-6) next = current + (Number(config.step) || 0.1);
  next = Math.min(maximum, Math.max(minimum, next));
  if (Math.abs(next - current) < 1e-6) next = Math.min(maximum, Math.max(minimum, current - (Number(config.step) || 0.1)));
  return Math.abs(next - current) < 1e-9 ? null : { ...defaults, [definition.key]: next };
}

function chooseChangedCandidates(meta, defaults, sceneValues) {
  const definitions = meta.modelParameters?.parameters ?? [];
  const candidates = [];
  const sceneCandidate = sceneValues ? { ...defaults, ...sceneValues } : null;
  const sceneChangedKeys = sceneCandidate
    ? definitions.filter((definition) => (
      definition.type === 'number' && sceneCandidate[definition.key] !== defaults[definition.key]
    )).map((definition) => definition.key)
    : [];
  if (sceneCandidate && sceneChangedKeys.length > 0) {
    candidates.push({ key: `scene-parameters:${sceneChangedKeys.join(',')}`, values: sceneCandidate });
  }
  const priorities = [
    'length', 'width', 'height', 'layerCount', 'columnCount', 'trackLength', 'bodyLength', 'bodyHeight',
    'platformLength', 'vehicleLength', 'vehicleWidth', 'carLength', 'carWidth', 'depth', 'slotLength',
    'slotWidth', 'slotHeight', 'rollerDensity',
  ];
  const numeric = definitions.filter((definition) => definition.type === 'number');
  const ordered = [
    ...priorities.map((key) => numeric.find((definition) => definition.key === key)).filter(Boolean),
    ...numeric.filter((definition) => !priorities.includes(definition.key)),
  ];
  for (const definition of ordered) {
    const values = createChangedValue(definition, defaults);
    if (values) candidates.push({ key: definition.key, values });
  }
  return candidates.filter((candidate, index) => (
    candidates.findIndex((item) => JSON.stringify(item.values) === JSON.stringify(candidate.values)) === index
  ));
}

function collectSceneValuesByPackage(scene) {
  const result = new Map();
  for (const entity of Object.values(scene.entities ?? {})) {
    const modelAsset = entity?.components?.modelAsset;
    if (!modelAsset || entity.components?.modelArrayInstance || !modelAsset.parameterValues) continue;
    const sourcePath = String(modelAsset.sourcePath ?? modelAsset.sourceUrl ?? '').replace(/\\/g, '/').split('?')[0];
    const packageName = path.basename(path.dirname(sourcePath));
    if (!packageName) continue;
    const current = result.get(packageName);
    if (!current || parameterComplexity(modelAsset.parameterValues) > parameterComplexity(current)) {
      result.set(packageName, modelAsset.parameterValues);
    }
  }
  return result;
}

function parameterComplexity(values) {
  const factors = ['layerCount', 'columnCount', 'slotCountHeight', 'slotCountLength']
    .map((key) => Number(values?.[key]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return factors.reduce((total, value) => total * value, 1) * (values?.doubleDeepEnabled ? 2 : 1);
}

function viteFsUrl(filePath) {
  return `/@fs/${filePath.replace(/\\/g, '/')}`;
}

function rawScriptUrl(filePath) {
  const relative = path.relative(modelRoot, filePath).replace(/\\/g, '/');
  return `/__model-script__/${encodeURIComponent(relative)}`;
}

function webPath(filePath) {
  const relative = path.relative(workspace, filePath).replace(/\\/g, '/');
  return `/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function packageFolder(index, packageName) {
  const ascii = packageName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  return `${String(index + 1).padStart(2, '0')}-${ascii}`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function analyzePng(electronApp, buffer) {
  return electronApp.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const pixelCount = Math.max(1, size.width * size.height);
    const borderWidth = Math.max(2, Math.floor(Math.min(size.width, size.height) * 0.02));
    const borderHistogram = new Map();
    const quantizedColorKey = (r, g, b) => `${r >> 3}:${g >> 3}:${b >> 3}`;
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        if (!(x < borderWidth || x >= size.width - borderWidth || y < borderWidth || y >= size.height - borderWidth)) continue;
        const offset = (y * size.width + x) * 4;
        const b = bitmap[offset] ?? 0;
        const g = bitmap[offset + 1] ?? 0;
        const r = bitmap[offset + 2] ?? 0;
        const key = quantizedColorKey(r, g, b);
        const bucket = borderHistogram.get(key) ?? { key, count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        borderHistogram.set(key, bucket);
      }
    }
    const ordered = [...borderHistogram.values()].sort((left, right) => right.count - left.count);
    const borderSamples = ordered.reduce((total, value) => total + value.count, 0);
    const backgroundPalette = [];
    let covered = 0;
    for (const color of ordered) {
      if (backgroundPalette.length >= 6) break;
      if (color.count < Math.max(4, borderSamples * 0.002) && covered >= borderSamples * 0.995) break;
      backgroundPalette.push({
        r: color.r / color.count,
        g: color.g / color.count,
        b: color.b / color.count,
        key: color.key,
        count: color.count,
      });
      covered += color.count;
      if (covered >= borderSamples * 0.995) break;
    }
    const sampledColors = new Set();
    const foregroundColors = new Set();
    let foreground = 0;
    let minimumX = size.width;
    let minimumY = size.height;
    let maximumX = -1;
    let maximumY = -1;
    let foregroundLuma = 0;
    let foregroundLumaSquared = 0;
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const offset = (y * size.width + x) * 4;
        const b = bitmap[offset] ?? 0;
        const g = bitmap[offset + 1] ?? 0;
        const r = bitmap[offset + 2] ?? 0;
        const key = quantizedColorKey(r, g, b);
        sampledColors.add(key);
        const distance = backgroundPalette.reduce((minimum, background) => Math.min(
          minimum,
          Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b),
        ), Number.POSITIVE_INFINITY);
        if (distance < 24) continue;
        const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        foreground += 1;
        foregroundColors.add(key);
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
        foregroundLuma += luma;
        foregroundLumaSquared += luma * luma;
      }
    }
    const foregroundWidth = maximumX >= minimumX ? maximumX - minimumX + 1 : 0;
    const foregroundHeight = maximumY >= minimumY ? maximumY - minimumY + 1 : 0;
    const foregroundAverageLuma = foregroundLuma / Math.max(1, foreground);
    const foregroundVariance = Math.max(0, foregroundLumaSquared / Math.max(1, foreground) - foregroundAverageLuma ** 2);
    return {
      width: size.width,
      height: size.height,
      distinctSampledColors: sampledColors.size,
      distinctForegroundColors: foregroundColors.size,
      foregroundRatio: foreground / pixelCount,
      foregroundBounds: foreground > 0 ? { minimumX, minimumY, maximumX, maximumY } : null,
      foregroundSpanRatio: {
        x: foregroundWidth / Math.max(1, size.width),
        y: foregroundHeight / Math.max(1, size.height),
      },
      foregroundAverageLuma,
      foregroundLumaStandardDeviation: Math.sqrt(foregroundVariance),
      backgroundPalette: backgroundPalette.map(({ key, count }) => ({ key, count })),
    };
  }, buffer.toString('base64'));
}

async function comparePng(electronApp, left, right, leftAnalysis, rightAnalysis) {
  const bounds = [leftAnalysis.foregroundBounds, rightAnalysis.foregroundBounds].filter(Boolean);
  const roi = bounds.length > 0 ? {
    minimumX: Math.max(0, Math.min(...bounds.map((value) => value.minimumX)) - 2),
    minimumY: Math.max(0, Math.min(...bounds.map((value) => value.minimumY)) - 2),
    maximumX: Math.max(...bounds.map((value) => value.maximumX)) + 2,
    maximumY: Math.max(...bounds.map((value) => value.maximumY)) + 2,
  } : null;
  return electronApp.evaluate(({ nativeImage }, payload) => {
    const leftImage = nativeImage.createFromBuffer(Buffer.from(payload.left, 'base64'));
    const rightImage = nativeImage.createFromBuffer(Buffer.from(payload.right, 'base64'));
    const leftSize = leftImage.getSize();
    const rightSize = rightImage.getSize();
    if (leftSize.width !== rightSize.width || leftSize.height !== rightSize.height) {
      return { sameSize: false, differentPixelRatio: 1, fullDifferentPixelRatio: 1, meanAbsoluteDifference: 255 };
    }
    const leftBitmap = leftImage.toBitmap();
    const rightBitmap = rightImage.toBitmap();
    const fullPixelCount = Math.max(1, leftSize.width * leftSize.height);
    const minimumX = Math.max(0, Math.min(leftSize.width - 1, Math.floor(payload.roi?.minimumX ?? 0)));
    const minimumY = Math.max(0, Math.min(leftSize.height - 1, Math.floor(payload.roi?.minimumY ?? 0)));
    const maximumX = Math.max(minimumX, Math.min(leftSize.width - 1, Math.ceil(payload.roi?.maximumX ?? leftSize.width - 1)));
    const maximumY = Math.max(minimumY, Math.min(leftSize.height - 1, Math.ceil(payload.roi?.maximumY ?? leftSize.height - 1)));
    const comparisonPixelCount = Math.max(1, (maximumX - minimumX + 1) * (maximumY - minimumY + 1));
    let different = 0;
    let fullDifferent = 0;
    let differenceTotal = 0;
    for (let y = 0; y < leftSize.height; y += 1) {
      for (let x = 0; x < leftSize.width; x += 1) {
        const index = y * leftSize.width + x;
        const offset = index * 4;
        const differences = [0, 1, 2].map((channel) => Math.abs((leftBitmap[offset + channel] ?? 0) - (rightBitmap[offset + channel] ?? 0)));
        const maximum = Math.max(...differences);
        if (maximum > payload.threshold) fullDifferent += 1;
        if (x < minimumX || x > maximumX || y < minimumY || y > maximumY) continue;
        differenceTotal += differences.reduce((sum, value) => sum + value, 0) / 3;
        if (maximum > payload.threshold) different += 1;
      }
    }
    return {
      sameSize: true,
      roi: { minimumX, minimumY, maximumX, maximumY },
      comparisonPixelCount,
      differentPixelRatio: different / comparisonPixelCount,
      fullDifferentPixelRatio: fullDifferent / fullPixelCount,
      meanAbsoluteDifference: differenceTotal / comparisonPixelCount,
    };
  }, {
    left: left.toString('base64'),
    right: right.toString('base64'),
    threshold: pixelDifferenceThreshold,
    roi,
  });
}

function assertNonEmpty(label, analysis) {
  assert.ok(analysis.foregroundRatio >= 0.002, `${label} 前景像素占比过低：${analysis.foregroundRatio}`);
  assert.ok(analysis.distinctForegroundColors >= 3, `${label} 前景颜色过少：${analysis.distinctForegroundColors}`);
  assert.ok(Math.max(analysis.foregroundSpanRatio.x, analysis.foregroundSpanRatio.y) >= 0.18, `${label} 模型占屏跨度过小`);
  assert.ok(analysis.foregroundLumaStandardDeviation >= 1.5, `${label} 前景亮度变化过小`);
}

function compareForeground(label, direct, array, pixel) {
  const spanError = Math.max(
    Math.abs(direct.foregroundSpanRatio.x - array.foregroundSpanRatio.x),
    Math.abs(direct.foregroundSpanRatio.y - array.foregroundSpanRatio.y),
  );
  const brightnessDifference = Math.abs(direct.foregroundAverageLuma - array.foregroundAverageLuma);
  assert.ok(spanError <= 0.01, `${label} direct/array 前景跨度误差 ${spanError} 超过 1%`);
  assert.ok(brightnessDifference <= 8, `${label} direct/array 平均亮度差 ${brightnessDifference} 超过 8`);
  assert.ok(pixel.sameSize, `${label} direct/array 截图尺寸不一致`);
  assert.ok(pixel.differentPixelRatio <= 0.05, `${label} direct/array 容差像素差 ${pixel.differentPixelRatio} 超过 5%`);
  return { spanError, brightnessDifference, ...pixel };
}

async function captureCanvas({ page, canvas, electronApp, directory, name, preparation }) {
  await page.waitForTimeout(120);
  const base64 = await page.evaluate(() => {
    const renderCanvas = document.querySelector('#renderCanvas');
    if (!(renderCanvas instanceof HTMLCanvasElement)) throw new Error('WebGL canvas 不存在');
    return renderCanvas.toDataURL('image/png').split(',', 2)[1] ?? '';
  });
  const buffer = Buffer.from(base64, 'base64');
  assert.ok(buffer.length > 0, `${name} 未读取到 WebGL 帧`);
  const imagePath = path.join(directory, `${name}.png`);
  await fs.writeFile(imagePath, buffer);
  const analysis = await analyzePng(electronApp, buffer);
  await fs.writeFile(
    path.join(directory, `${name}.json`),
    `${JSON.stringify({ preparation, analysis }, null, 2)}\n`,
    'utf8',
  );
  assertNonEmpty(name, analysis);
  return {
    name,
    imagePath,
    imageUrl: webPath(imagePath),
    sha256: sha256(buffer),
    preparation,
    analysis,
    buffer,
  };
}

async function buildSpec(packageName, sceneValuesByPackage) {
  const packageRoot = path.join(modelRoot, packageName);
  const meta = JSON.parse(await fs.readFile(path.join(packageRoot, 'meta.json'), 'utf8'));
  const files = await fs.readdir(packageRoot);
  const scriptName = meta.parameterScripts?.[0]?.scriptFilename ?? meta.animationScripts?.[0]?.scriptFilename;
  const declaredModelName = meta.parameterScripts?.[0]?.modelFilename ?? meta.animationScripts?.[0]?.modelFilename;
  const modelName = files.includes(declaredModelName)
    ? declaredModelName
    : files.find((file) => /\.(?:glb|gltf)$/i.test(file) && !/\.bak/i.test(file));
  assert.ok(scriptName && files.includes(scriptName), `${packageName} 缺少参数化脚本`);
  assert.ok(modelName, `${packageName} 缺少 GLB/GLTF`);
  const glbPath = path.join(packageRoot, modelName);
  const scriptPath = path.join(packageRoot, scriptName);
  const [glbStat, scriptText, metaText] = await Promise.all([
    fs.stat(glbPath),
    fs.readFile(scriptPath, 'utf8'),
    fs.readFile(path.join(packageRoot, 'meta.json'), 'utf8'),
  ]);
  const defaults = defaultValues(meta);
  const changedCandidates = chooseChangedCandidates(meta, defaults, sceneValuesByPackage.get(packageName));
  assert.ok(changedCandidates.length > 0, `${packageName} 缺少数值参数变化候选`);
  return {
    packageName,
    modelName,
    glbPath,
    glbUrl: viteFsUrl(glbPath),
    scriptName,
    scriptPath,
    scriptUrl: rawScriptUrl(scriptPath),
    assetRevision: `visual-${createHash('sha256').update(`${glbStat.size}:${glbStat.mtimeMs}:${scriptText}:${metaText}`).digest('hex').slice(0, 20)}`,
    lengthUnit: meta.lengthUnit ?? 'meter',
    unitScaleToMeters: unitScaleToMeters(meta.lengthUnit),
    parameterScriptMetadata: meta.parameterScripts ?? [],
    animationScriptMetadata: meta.animationScripts ?? [],
    parameterConfig: meta.modelParameters,
    dataDrivenConfig: meta.dataDriven,
    defaults,
    changedCandidates,
  };
}

async function createElectronMain() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'babylon-model-array-visual-'));
  const mainPath = path.join(tempRoot, 'main.cjs');
  await fs.writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.MODEL_ARRAY_VISUAL_USER_DATA);
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${screenshotWidth},
    height: ${screenshotHeight},
    show: false,
    backgroundColor: '#091019',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  await win.loadURL(process.env.MODEL_ARRAY_VISUAL_URL);
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');
  return { tempRoot, mainPath };
}

const sceneFile = JSON.parse(originalSceneBytes.toString('utf8'));
const sceneDocument = sceneFile.scene ?? sceneFile;
const sceneValuesByPackage = collectSceneValuesByPackage(sceneDocument);
const allPackageNames = (await fs.readdir(modelRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !['Assets', '.babylon-editor'].includes(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
assert.equal(allPackageNames.length, expectedPackageCount, `模型包数量必须为 ${expectedPackageCount}`);
const focusedPackageName = process.env.BABYLON_MODEL_ARRAY_PACKAGE?.trim();
const packageNames = focusedPackageName
  ? allPackageNames.filter((packageName) => packageName === focusedPackageName)
  : allPackageNames;
assert.ok(packageNames.length > 0, `未找到指定模型包：${focusedPackageName}`);
const fullRun = packageNames.length === allPackageNames.length;
const focusedReportSuffix = focusedPackageName
  ? `-${focusedPackageName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`
  : '';
const reportPath = path.resolve(configuredReportPath ?? path.join(
  workspace,
  'output',
  'model-array-validation',
  `visual-report${focusedReportSuffix}.json`,
));
await fs.mkdir(runRoot, { recursive: true });
await fs.mkdir(path.dirname(reportPath), { recursive: true });

let viteServer;
let electronApp;
let tempElectron;
const results = [];
const browserMessages = [];
let activePackageName = '';
try {
  viteServer = await createServer({
    root: workspace,
    cacheDir: path.join(workspace, 'output', '.vite-model-array-visual-cache'),
    plugins: [{
      name: 'raw-external-model-script',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/__model-script__/')) return next();
          const requestUrl = new URL(request.url, 'http://127.0.0.1');
          const relative = decodeURIComponent(requestUrl.pathname.slice('/__model-script__/'.length));
          const resolved = path.resolve(modelRoot, relative.replace(/\//g, path.sep));
          const rootPrefix = `${path.resolve(modelRoot)}${path.sep}`;
          if (!resolved.startsWith(rootPrefix)) {
            response.statusCode = 403;
            response.end('Forbidden');
            return;
          }
          void fs.readFile(resolved, 'utf8').then((source) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(source);
          }).catch((error) => {
            response.statusCode = error?.code === 'ENOENT' ? 404 : 500;
            response.end(error instanceof Error ? error.message : String(error));
          });
        });
      },
    }],
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      hmr: false,
      fs: { allow: [workspace, modelRoot, path.dirname(scenePath)] },
    },
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  assert.ok(address && typeof address !== 'string', 'Vite 可视化服务器未取得监听端口');
  const harnessUrl = `http://127.0.0.1:${address.port}/scripts/fixtures/model-array-visual-harness.html`;
  tempElectron = await createElectronMain();
  electronApp = await electron.launch({
    executablePath: path.join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [tempElectron.mainPath],
    cwd: workspace,
    env: {
      ...process.env,
      MODEL_ARRAY_VISUAL_URL: harnessUrl,
      MODEL_ARRAY_VISUAL_USER_DATA: path.join(tempElectron.tempRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  page.setDefaultTimeout(180_000);
  page.on('console', (message) => browserMessages.push({ packageName: activePackageName, type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => browserMessages.push({ packageName: activePackageName, type: 'pageerror', text: error.stack ?? error.message }));
  await page.waitForFunction(() => Boolean(window.modelArrayVisualHarness?.ready), null, { timeout: 240_000 });
  const canvas = page.locator('#renderCanvas');
  await canvas.waitFor({ state: 'visible' });

  for (let index = 0; index < packageNames.length; index += 1) {
    const packageName = packageNames[index];
    activePackageName = packageName;
    const startedAt = Date.now();
    const directory = path.join(runRoot, packageFolder(index, packageName));
    await fs.mkdir(directory, { recursive: true });
    console.log(`[model-array-visual:start] ${packageName}`);
    const lifecycle = { direct: false, parameter: false, array: false, parameterAfterArray: false, sourceParameterTransition: false, restore: false };
    try {
      const spec = await buildSpec(packageName, sceneValuesByPackage);
      const initialization = await page.evaluate((value) => window.modelArrayVisualHarness.initialize(value), spec);
      lifecycle.direct = initialization.lifecycle?.direct === true;
      lifecycle.parameter = initialization.lifecycle?.parameter === true;
      assert.ok(lifecycle.direct && lifecycle.parameter, `${packageName} 阵列前 direct/parameter 生命周期未通过`);
      const captures = {};
      const captureComparisonPair = async (parameterSet, comparisonTarget, label) => {
        const prefix = `${parameterSet}-${comparisonTarget}`;
        const directPreparation = await page.evaluate((request) => window.modelArrayVisualHarness.prepareCapture(request), {
          parameterSet,
          kind: 'direct',
          view: 'compare',
          comparisonTarget,
        });
        const direct = await captureCanvas({
          page,
          canvas,
          electronApp,
          directory,
          name: `${prefix}-direct-compare`,
          preparation: directPreparation,
        });
        const arrayPreparation = await page.evaluate((request) => window.modelArrayVisualHarness.prepareCapture(request), {
          parameterSet,
          kind: 'array',
          view: 'compare',
          comparisonTarget,
          cameraPreset: directPreparation.cameraPreset,
        });
        const array = await captureCanvas({
          page,
          canvas,
          electronApp,
          directory,
          name: `${prefix}-array-compare`,
          preparation: arrayPreparation,
        });
        const captureKey = `${parameterSet}${comparisonTarget[0].toUpperCase()}${comparisonTarget.slice(1)}`;
        captures[`${captureKey}Direct`] = direct;
        captures[`${captureKey}Array`] = array;
        const pixel = await comparePng(electronApp, direct.buffer, array.buffer, direct.analysis, array.analysis);
        return compareForeground(label, direct.analysis, array.analysis, pixel);
      };

      const defaultComparisons = {
        positive: await captureComparisonPair('default', 'positive', '默认参数·旋转非均匀缩放实例'),
        negative: await captureComparisonPair('default', 'negative', '默认参数·负缩放镜像实例'),
      };
      lifecycle.array = true;

      const defaultOverviewPreparation = await page.evaluate(() => window.modelArrayVisualHarness.prepareCapture({
        parameterSet: 'default', kind: 'group', view: 'overview',
      }));
      captures.defaultOverview = await captureCanvas({ page, canvas, electronApp, directory, name: 'default-overview', preparation: defaultOverviewPreparation });
      const defaultDetailPreparation = await page.evaluate(() => window.modelArrayVisualHarness.prepareCapture({
        parameterSet: 'default', kind: 'group', view: 'detail',
      }));
      captures.defaultDetail = await captureCanvas({ page, canvas, electronApp, directory, name: 'default-detail', preparation: defaultDetailPreparation });

      const changedComparisons = {
        positive: await captureComparisonPair('changed', 'positive', '参数修改后·旋转非均匀缩放实例'),
        negative: await captureComparisonPair('changed', 'negative', '参数修改后·负缩放镜像实例'),
      };

      const changedOverviewPreparation = await page.evaluate(() => window.modelArrayVisualHarness.prepareCapture({
        parameterSet: 'changed', kind: 'group', view: 'overview',
      }));
      assert.ok(
        changedOverviewPreparation.parameterVariantCount >= 1
          && changedOverviewPreparation.parameterVariantEntityIds.includes('visual-array-b'),
        `${packageName} 阵列后单实例参数变化未创建独立参数宿主`,
      );
      captures.changedOverview = await captureCanvas({ page, canvas, electronApp, directory, name: 'changed-overview', preparation: changedOverviewPreparation });
      const changedDetailPreparation = await page.evaluate(() => window.modelArrayVisualHarness.prepareCapture({
        parameterSet: 'changed', kind: 'group', view: 'detail',
      }));
      captures.changedDetail = await captureCanvas({ page, canvas, electronApp, directory, name: 'changed-detail', preparation: changedDetailPreparation });
      lifecycle.parameterAfterArray = true;

      const sourceParameterTransition = await page.evaluate(() => window.modelArrayVisualHarness.verifySourceParameterTransition());
      assert.equal(sourceParameterTransition.logicalEntityCount, 4, `${packageName} 源参数换批必须覆盖源模型和三个阵列副本`);
      assert.equal(sourceParameterTransition.minimumCoveredEntityCount, 4, `${packageName} 源参数经过默认值时存在阵列模型消失帧`);
      assert.equal(sourceParameterTransition.contextLost, false, `${packageName} 源参数换批不得丢失 WebGL 上下文`);
      lifecycle.sourceParameterTransition = true;

      let denseShelfArray21 = null;
      if (packageName === 'Shelf') {
        denseShelfArray21 = await page.evaluate(() => window.modelArrayVisualHarness.verifyDenseShelfArrayCount(21));
        assert.equal(denseShelfArray21.denseSourceMeshCount, 18, 'Shelf 20x100 双深必须保留 18 个 dense 源批次');
        assert.equal(denseShelfArray21.denseSourceThinInstanceCount, 16_674, 'Shelf 20x100 双深必须保留 16674 个源矩阵');
        assert.equal(denseShelfArray21.preview20, true, 'Shelf 20 个副本预览必须成功');
        assert.equal(denseShelfArray21.preview21, true, 'Shelf 第 21 个副本预览必须成功');
        assert.equal(denseShelfArray21.previewBatchReused, true, 'Shelf 第 21 个副本预览必须复用矩阵批次');
        assert.equal(denseShelfArray21.previewThinInstanceCount, denseShelfArray21.previewMatrixSourceCount * 21, 'Shelf 第 21 个预览副本不得清空内部矩阵');
        assert.ok(denseShelfArray21.previewRenderableMeshCount > 0, 'Shelf 第 21 个预览副本后必须保留可渲染批次');
        assert.equal(denseShelfArray21.previewContextLost, false, 'Shelf 第 21 个预览副本不得丢失 WebGL 上下文');
        assert.equal(denseShelfArray21.logicalEntityCount, 22, 'Shelf 正式阵列必须保留源和全部 21 个副本');
        assert.equal(denseShelfArray21.completeThinInstanceCount, denseShelfArray21.formalMatrixSourceCount * 22, 'Shelf 第 21 个正式副本不得截断内部矩阵');
        assert.ok(denseShelfArray21.formalRenderableMeshCount > 0, 'Shelf 第 21 个正式副本后必须保留可渲染分片');
        assert.ok(denseShelfArray21.nearSource.renderableMeshCount > 0, '近看源 Shelf 时阵列分片不得全部被错误裁剪');
        assert.ok(denseShelfArray21.nearMiddle.renderableMeshCount > 0, '近看中间 Shelf 时阵列分片不得全部被错误裁剪');
        assert.ok(denseShelfArray21.nearLast.renderableMeshCount > 0, '近看末端 Shelf 时阵列分片不得全部被错误裁剪');
        assert.equal(denseShelfArray21.contextLost, false, 'Shelf 第 21 个正式副本不得丢失 WebGL 上下文');
        captures.denseShelfArray21 = await captureCanvas({
          page,
          canvas,
          electronApp,
          directory,
          name: 'changed-dense-array-21',
          preparation: denseShelfArray21,
        });
      }

      const restore = await page.evaluate(() => window.modelArrayVisualHarness.verifyRestore());
      assert.equal(restore.pass, true, `${packageName} 参数恢复/取消阵列后未恢复默认模型`);
      lifecycle.restore = true;
      const packageMessages = browserMessages.filter((message) => message.packageName === packageName);
      const failureMessages = packageMessages.filter((message) => (
        message.type === 'pageerror' || /模型(?:加载|脚本|参数|矩阵阵列).*失败|创建模型阵列矩阵批次失败/i.test(message.text)
      ));
      assert.deepEqual(failureMessages, [], `${packageName} 可视运行存在失败日志`);

      assert.ok(Object.values(lifecycle).every(Boolean), `${packageName} 六阶段视觉生命周期未全部通过`);
      const result = {
        packageName,
        status: 'PASS',
        durationMs: Date.now() - startedAt,
        changedKey: initialization.changedKey,
        lifecycle,
        comparisons: { default: defaultComparisons, changed: changedComparisons },
        sourceParameterTransition,
        denseShelfArray21,
        restore,
        captures: Object.fromEntries(Object.entries(captures).map(([key, capture]) => [key, {
          name: capture.name,
          imagePath: capture.imagePath,
          imageUrl: capture.imageUrl,
          sha256: capture.sha256,
          preparation: capture.preparation,
          analysis: capture.analysis,
        }])),
        browserMessages: packageMessages,
      };
      await fs.writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      results.push(result);
      console.log(`[model-array-visual:pass] ${packageName} ${result.durationMs}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      const result = { packageName, status: 'FAIL', durationMs: Date.now() - startedAt, lifecycle, error: message };
      await fs.writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      results.push(result);
      console.error(`[model-array-visual:fail] ${packageName}\n${message}`);
    } finally {
      await page.evaluate(() => window.modelArrayVisualHarness.dispose()).catch(() => undefined);
      const partialReport = {
        status: results.some((result) => result.status !== 'PASS') ? 'FAIL' : fullRun && results.length === allPackageNames.length ? 'PASS' : 'PARTIAL',
        mode: fullRun ? 'full' : 'focused',
        generatedAt: new Date().toISOString(),
        modelRoot,
        scenePath,
        runRoot,
        packageCount: allPackageNames.length,
        executedPackageCount: results.length,
        results,
      };
      await fs.writeFile(reportPath, `${JSON.stringify(partialReport, null, 2)}\n`, 'utf8');
    }
  }

  const cards = results.map((result) => ({
    packageName: result.packageName,
    status: result.status,
    lifecycle: result.lifecycle,
    defaultImageUrl: result.captures?.defaultOverview?.imageUrl ?? '',
    changedImageUrl: result.captures?.changedOverview?.imageUrl ?? '',
    error: result.error ?? '',
  }));
  const renderedContactSheet = await page.evaluate((payload) => window.modelArrayVisualHarness.renderContactSheet(payload), {
    generatedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
    packageCount: results.length,
    cards,
  });
  const contactSheetLayout = {
    width: Math.ceil(renderedContactSheet.width),
    height: Math.ceil(renderedContactSheet.height),
  };
  const contactSheetPath = path.join(runRoot, 'contact-sheet.png');
  const contactSheetBuffer = Buffer.from(renderedContactSheet.pngBase64, 'base64');
  assert.ok(contactSheetBuffer.length > 0, '联系表 Canvas 未生成 PNG 数据');
  await fs.writeFile(contactSheetPath, contactSheetBuffer);
  const capturedContactSheetSize = await electronApp.evaluate(({ nativeImage }, base64) => (
    nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).getSize()
  ), contactSheetBuffer.toString('base64'));
  assert.ok(
    capturedContactSheetSize.width >= contactSheetLayout.width
      && capturedContactSheetSize.height >= contactSheetLayout.height,
    `联系表截图未覆盖完整页面：capture=${capturedContactSheetSize.width}x${capturedContactSheetSize.height}, page=${contactSheetLayout.width}x${contactSheetLayout.height}`,
  );
  const failures = results.filter((result) => result.status !== 'PASS');
  const currentSceneHash = sha256(await fs.readFile(scenePath));
  assert.equal(currentSceneHash, originalSceneHash, '原始目标场景被可视化 smoke 修改');
  const report = {
    status: failures.length > 0 ? 'FAIL' : fullRun ? 'PASS' : 'PARTIAL',
    mode: fullRun ? 'full' : 'focused',
    generatedAt: new Date().toISOString(),
    modelRoot,
    scenePath,
    originalSceneHash,
    runRoot,
    contactSheetPath,
    contactSheetLayout,
    capturedContactSheetSize,
    packageCount: allPackageNames.length,
    executedPackageCount: results.length,
    passCount: results.length - failures.length,
    failCount: failures.length,
    thresholds: {
      foregroundSpanErrorMaximum: 0.01,
      foregroundBrightnessDifferenceMaximum: 8,
      differentPixelRatioMaximum: 0.05,
      pixelDifferenceThreshold,
    },
    results,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: report.status,
    reportPath,
    runRoot,
    contactSheetPath,
    packageCount: report.packageCount,
    passCount: report.passCount,
    failCount: report.failCount,
    failures: failures.map(({ packageName, error }) => ({ packageName, error })),
  }, null, 2));
  assert.equal(failures.length, 0, `存在 ${failures.length} 个模型未通过可视化阵列验收，详见 ${reportPath}`);
  if (fullRun) assert.equal(report.executedPackageCount, report.packageCount, '全量视觉报告必须执行全部 16 个模型包');
} finally {
  await electronApp?.close().catch(() => undefined);
  await viteServer?.close().catch(() => undefined);
  if (tempElectron?.tempRoot) {
    const resolvedTempRoot = path.resolve(tempElectron.tempRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTempRoot.startsWith(`${resolvedOsTemp}${path.sep}`)) {
      await fs.rm(resolvedTempRoot, { recursive: true, force: true });
    }
  }
}
