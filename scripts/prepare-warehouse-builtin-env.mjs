/* global window */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSkyboxViteServer } from '../tests/helpers/skyboxViteServer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'src', 'runtime', 'babylon', 'assets');
const faceSize = 256;
const width = 512;
const height = 256;

function floatToRgbe(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 1e-32) return [0, 0, 0, 0];
  const exponent = Math.ceil(Math.log2(max));
  const scale = Math.pow(2, -exponent) * 255.999;
  const clampByte = value => Math.max(0, Math.min(255, Math.floor(value * scale)));
  return [clampByte(r), clampByte(g), clampByte(b), exponent + 128];
}

/** 合成工业仓库程序化全景 HDR（未压缩 32-bit RGBE）。 */
function buildWarehouseHdr(variant) {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const headerBytes = Buffer.from(header, 'ascii');
  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = 1 - (y + 0.5) / height; // 1 = zenith, 0 = nadir
    const theta = (1 - v) * Math.PI;
    const ny = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = u * Math.PI * 2;
      const nx = sinTheta * Math.cos(phi);
      const nz = sinTheta * Math.sin(phi);

      let r = 0;
      let g = 0;
      let b = 0;

      if (variant === 'warehouse-bright') {
        // 中性高棚天窗 + 均匀工业顶灯阵列 + 浅灰混凝土地面反弹
        if (ny > 0.04) {
          const ceilingBase = 0.72 + 0.25 * ny;
          r = ceilingBase * 0.98;
          g = ceilingBase * 1.0;
          b = ceilingBase * 1.03;

          // 3x4 柔和工业 LED 顶灯带
          const gx = Math.abs(Math.sin((nx / Math.max(0.25, ny)) * Math.PI * 1.5));
          const gz = Math.abs(Math.sin((nz / Math.max(0.25, ny)) * Math.PI * 2.0));
          const panel = ny > 0.35 && gx > 0.88 && gz > 0.65 ? 1 : 0;
          if (panel) {
            r += 2.2;
            g += 2.25;
            b += 2.3;
          }
          // 柔和天窗主方向柔光
          const sunDot = Math.max(0, nx * 0.45 + ny * 0.82 + nz * 0.35);
          const skylight = Math.pow(sunDot, 12) * 1.8;
          r += skylight * 1.0;
          g += skylight * 0.99;
          b += skylight * 0.97;
        } else {
          const horizon = Math.exp(-Math.abs(ny) * 6);
          const floorBounce = 0.24 + 0.22 * horizon;
          r = floorBounce * 0.96;
          g = floorBounce * 0.98;
          b = floorBounce * 1.02;
        }
      } else {
        // 暗黑科技中控仓：深蓝灰基调 + 利落冷白顶灯带，保留金属货架高光且不抢告警色
        if (ny > 0.02) {
          const upper = 0.14 + 0.12 * ny;
          r = upper * 0.78;
          g = upper * 0.92;
          b = upper * 1.18;

          const gx = Math.abs(Math.sin((nx / Math.max(0.28, ny)) * Math.PI * 1.6));
          const gz = Math.abs(Math.sin((nz / Math.max(0.28, ny)) * Math.PI * 2.2));
          if (ny > 0.38 && gx > 0.9 && gz > 0.7) {
            r += 1.4;
            g += 1.75;
            b += 2.25;
          }
          const accentDot = Math.max(0, -nx * 0.5 + ny * 0.75 + nz * 0.43);
          const rim = Math.pow(accentDot, 10) * 0.9;
          r += rim * 0.65;
          g += rim * 0.9;
          b += rim * 1.25;
        } else {
          const horizon = Math.exp(-Math.abs(ny) * 5);
          const floorDark = 0.05 + 0.07 * horizon;
          r = floorDark * 0.72;
          g = floorDark * 0.85;
          b = floorDark * 1.12;
        }
      }

      const [re, ge, be, exp] = floatToRgbe(r, g, b);
      const offset = (y * width + x) * 4;
      // 避免首个像素恰好撞上 Radiance RLE 魔数 (2, 2)
      pixels[offset] = y === 0 && x === 0 && re === 2 && ge === 2 ? 3 : re;
      pixels[offset + 1] = ge;
      pixels[offset + 2] = be;
      pixels[offset + 3] = exp;
    }
  }
  return Buffer.concat([headerBytes, pixels]);
}

const specs = [
  { id: 'warehouse-bright', fileName: 'warehouseBright.env' },
  { id: 'warehouse-dark', fileName: 'warehouseDark.env' },
];

const hdrBuffers = new Map();
const hdrHashes = new Map();
for (const spec of specs) {
  const bytes = buildWarehouseHdr(spec.id);
  hdrBuffers.set(spec.id, bytes);
  hdrHashes.set(spec.id, createHash('sha256').update(bytes).digest('hex'));
}

const ownServer = await startSkyboxViteServer();
const browser = await chromium.launch({
  executablePath: process.env.SKYBOX_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage();
page.on('console', message => {
  if (message.type() !== 'debug') console.log(message.text());
});

await page.route('**/_warehouse_hdr/*.hdr*', async route => {
  const url = new URL(route.request().url());
  const name = url.pathname.split('/').pop()?.replace(/\.hdr$/i, '');
  const body = name ? hdrBuffers.get(name) : undefined;
  if (!body) {
    await route.abort();
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/octet-stream', body });
});

const watchdog = setTimeout(() => {
  console.error('智慧仓储内置 ENV 生成超时。');
  void browser.close();
}, 300000);

try {
  await mkdir(assetsDir, { recursive: true });
  await page.goto(`${ownServer.origin}/tests/fixtures/nativeSkybox.harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyboxModulesReady === true);
  await page.waitForLoadState('networkidle');

  const summary = [];
  for (const spec of specs) {
    const sourceSha256 = hdrHashes.get(spec.id);
    const compiled = await page.evaluate(
      async ({ origin, id, size, sourceSha256 }) => {
        const { compileSkyboxEnvironment } = window.__skyboxModules;
        const contract = window.__skyboxContract;
        const bytes = await compileSkyboxEnvironment(
          {
            token: `builtin-${id}`,
            sourceUrl: `${origin}/_warehouse_hdr/${id}.hdr`,
            sourceSha256,
            sourceRevision: sourceSha256,
            faceSize: size,
            recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE,
            environment: null,
          },
          'hdr',
          new AbortController().signal,
          stage => console.log(`${id}: ${stage}`),
        );
        return Array.from(bytes);
      },
      { origin: ownServer.origin, id: spec.id, size: faceSize, sourceSha256 },
    );

    const outBytes = Buffer.from(compiled);
    const outPath = path.join(assetsDir, spec.fileName);
    await writeFile(outPath, outBytes);
    summary.push({
      id: spec.id,
      fileName: spec.fileName,
      byteLength: outBytes.length,
      sha256: createHash('sha256').update(outBytes).digest('hex'),
    });
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await ownServer.close();
}
