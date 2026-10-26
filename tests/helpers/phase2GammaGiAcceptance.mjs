/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonicalGammaJson(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(canonicalGammaJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalGammaJson(value[key])]));
  return value;
}

/** 原生 bootstrap 预载并旁路观察真实 IPC；原 handler 仍收到同一 raw 对象。 */
export function gammaTransportBootstrap(binaryUrl) {
  return `
const {ipcMain}=await import('electron');
const {createHash}=await import('node:crypto');
const binary=await import(${JSON.stringify(binaryUrl)});
const canonical=${canonicalGammaJson.toString()};
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const originalHandle=ipcMain.handle, handlers=[]; globalThis.phase2GiHost.transport=[];
const errorTree=(error,depth=0)=>depth>8?{truncated:true}:{name:error?.name??typeof error,message:error?.message??String(error),stack:error?.stack,code:error?.code,
  ...(error?.cause!==undefined?{cause:errorTree(error.cause,depth+1)}:{}),...(Array.isArray(error?.errors)?{errors:error.errors.map(value=>errorTree(value,depth+1))}:{})};
ipcMain.handle=function(channel,listener){
  if(!['lighting-bake:start','lighting-bake:preflight'].includes(channel)) return Reflect.apply(originalHandle,this,[channel,listener]);
  handlers.push({channel,listener});
  return Reflect.apply(originalHandle,this,[channel,async function(event,raw){
    const encodedBefore=digest(raw), decoded=binary.decodeLightingBakeTransport(raw), {captureMetrics,...capture}=decoded;
    const record={channel,jobId:decoded.jobId,tableCount:raw.textureTable?.urls?.length??0,tableVersion:raw.textureTable?.version??null,
      references:JSON.stringify(raw.input).split('lighting-texture-ref://v1/').length-1,
      restoredCaptureSha256:digest(capture),captureMetricsPreserved:digest(captureMetrics??null)===digest(raw.input.captureMetrics??null),
      unresolvedReferences:JSON.stringify(decoded).includes('lighting-texture-ref://v1/'),encodedUnchanged:null};
    globalThis.phase2GiHost.transport.push(record);
    try{return await Reflect.apply(listener,this,[event,raw]);}catch(error){record.error=errorTree(error);throw error;}finally{record.encodedUnchanged=digest(raw)===encodedBefore;}
  }]);
};
globalThis.phase2GiHost.restoreTransport=()=>{ipcMain.handle=originalHandle;for(const {channel,listener} of handlers){ipcMain.removeHandler(channel);Reflect.apply(originalHandle,ipcMain,[channel,listener]);}return ipcMain.handle===originalHandle;};
`;
}

async function readUi(page) {
  return page.evaluate(async () => {
    const state = window.phase2Gi.store.getState(), lighting = state.scene.sceneSettings.lighting;
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    return { version: lighting.version, encoding: lighting.bake.lightmapEncoding ?? null,
      signature: getSceneLightingBakeSignature(state.scene), result: Boolean(lighting.result),
      history: { undo: state.history.undoStack.length, redo: state.history.redoStack.length } };
  });
}
async function saveUi(page, scenePath, predicate) {
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  const deadline = Date.now() + 30000; let incomplete;
  while (Date.now() < deadline) {
    try { const bytes = await fs.readFile(scenePath), document = JSON.parse(bytes.toString('utf8')); if (predicate(document)) return { bytes: bytes.length, sha256: sha(bytes), document }; }
    catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; incomplete = error.message; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('UI保存未完整落盘预期v3/编码：' + (incomplete ?? '字段未匹配'));
}

export async function exerciseGammaGiUi({ page, scenePath, output }) {
  const report = { before: await readUi(page) };
  assert.equal(report.before.version, 2); assert.equal(report.before.encoding, null);
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true }); await manager.waitFor({ state: 'visible' });
  await fs.writeFile(path.join(output, 'gamma-ui-controls.json'), JSON.stringify(await manager.locator('input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => ({ label: input.closest('label')?.textContent, checked: input.checked, html: input.outerHTML }))), null, 2));
  // 左栏独立滚动；按实际 label 文本定位 input，再执行真实scroll/check，不依赖description合成的accessible name。
  const row = manager.locator('label.lighting-manager-toggle').filter({ has: page.getByText('暗部精度（Gamma RGBM）', { exact: true }) });
  const toggle = row.locator('input[type="checkbox"]');
  await toggle.waitFor({ state: 'attached' }); assert.equal(await toggle.count(), 1); await row.scrollIntoViewIfNeeded();
  await toggle.waitFor({ state: 'visible' }); assert.equal(await toggle.isChecked(), false);
  await toggle.check(); await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await page.waitForFunction(() => window.phase2Gi.store.getState().scene.sceneSettings.lighting.version === 3);
  report.enabled = await readUi(page); assert.equal(report.enabled.encoding, 'rgbm-gamma');
  assert.equal(report.enabled.signature, report.before.signature);
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  report.undo = await readUi(page); assert.equal(report.undo.version, 2); assert.equal(report.undo.encoding, null);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  report.redo = await readUi(page); assert.equal(report.redo.version, 3); assert.equal(report.redo.encoding, 'rgbm-gamma');
  const saved = await saveUi(page, scenePath, value => value.scene.sceneSettings.lighting.version === 3 && value.scene.sceneSettings.lighting.bake.lightmapEncoding === 'rgbm-gamma');
  report.saved = { bytes: saved.bytes, sha256: saved.sha256 };
  await fs.writeFile(path.join(output, 'gamma-enabled-before-bake.scene.json'), JSON.stringify(saved.document, null, 2) + '\n');
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  const card = page.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) });
  await card.getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const current = window.phase2Gi, runtime = current.runtime;
    if (!runtime || runtime.scene.isDisposed || !runtime.scene.isReady()) return false;
    const load = runtime.getPerformanceMetrics().loading;
    return !current.preparation.isScenePreparationActive() && !load.pendingModelCount && !load.active.length
      && current.store.getState().scene.sceneSettings.lighting.bake.lightmapEncoding === 'rgbm-gamma';
  }, null, { timeout: 180000 });
  report.reopened = await readUi(page); assert.equal(report.reopened.version, 3);
  assert.equal(report.reopened.encoding, 'rgbm-gamma'); assert.equal(report.reopened.signature, report.before.signature);
  await page.screenshot({ path: path.join(output, 'gamma-ui-reopened.png') });
  return report;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** 独立解析真实 PNG 的 CRC/IDAT/滤波，不经过 Canvas 的预乘/色彩路径。 */
export function decodeGammaGiPng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = []; let width, height, offset = 8, ended = false;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), start = offset + 8, end = start + length;
    assert.ok(end + 4 <= bytes.length); assert.equal(crc32(bytes.subarray(offset + 4, end)), bytes.readUInt32BE(end));
    if (type === 'IHDR') { width = bytes.readUInt32BE(start); height = bytes.readUInt32BE(start + 4);
      assert.equal(length, 13); assert.equal(bytes[start + 8], 8); assert.equal(bytes[start + 9], 6); assert.deepEqual([...bytes.subarray(start + 10, end)], [0, 0, 0]); }
    if (type === 'IDAT') parts.push(bytes.subarray(start, end));
    offset = end + 4; if (type === 'IEND') { ended = true; break; }
  }
  assert.ok(ended && width > 0 && height > 0); assert.equal(offset, bytes.length);
  const raw = inflateSync(Buffer.concat(parts)), stride = width * 4, rgba = Buffer.alloc(stride * height);
  assert.equal(raw.length, (stride + 1) * height);
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0, up = y ? rgba[(y - 1) * stride + x] : 0, corner = y && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      rgba[y * stride + x] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  return { width, height, rgba };
}

export async function inspectGammaGiPngs({ snapshot, output }) {
  const microPath = 'output/phase2-completion-20261025/b9-png-micro-1/report.json', microBytes = await fs.readFile(microPath), micro = JSON.parse(microBytes.toString('utf8'));
  assert.equal(micro.pass, true); assert.equal(micro.png.formulas['floor-float32-x255-plus-half'].mismatchChannels, 0);
  const report = { quantizationOracle: { path: microPath, sha256: sha(microBytes), formula: 'floor(float32(x*255)+float32(.5))', pngRowOrder: micro.png.pngRowOrder }, atlases: [] };
  for (const asset of snapshot.assets.filter(asset => asset.kind === 'lightmap')) {
    assert.equal(asset.encoding, 'rgbm-gamma'); assert.ok(asset.rgbmRange >= 1);
    const filename = decodeURIComponent(new URL(asset.url).pathname.slice(1)), bytes = await fs.readFile(filename), decoded = decodeGammaGiPng(bytes);
    assert.equal(bytes.length, asset.byteLength); assert.equal(sha(bytes), asset.sha256);
    let maximum = 0, positive = 0, dark = 0;
    for (let index = 0; index < decoded.rgba.length; index += 4) for (let channel = 0; channel < 3; channel++) {
      const value = (decoded.rgba[index + channel] / 255 * decoded.rgba[index + 3] / 255) ** 2 * asset.rgbmRange;
      assert.ok(Number.isFinite(value) && value >= 0); maximum = Math.max(maximum, value); if (value > 0) positive++; if (value > 0 && value < .01) dark++;
    }
    assert.ok(positive > 0, '实际烘焙PNG不能全黑');
    const rawPath = path.join(output, asset.id + '-png-top-first.rgba'); await fs.writeFile(rawPath, decoded.rgba);
    report.atlases.push({ id: asset.id, encoding: asset.encoding, range: asset.rgbmRange, width: decoded.width, height: decoded.height,
      bytes: bytes.length, sha256: sha(bytes), rgbaSha256: sha(decoded.rgba), rgbaPath: rawPath, positiveChannels: positive, darkChannels: dark, decodedMaximum: maximum });
  }
  return report;
}

export async function verifyGammaGiTransport(application, captures) {
  const records = await application.evaluate(() => globalThis.phase2GiHost.transport);
  assert.ok(records.some(record => record.channel === 'lighting-bake:start') && records.some(record => record.channel === 'lighting-bake:preflight'));
  for (const record of records) {
    const capture = captures.find(value => value.jobId === record.jobId); assert.ok(capture);
    const value = JSON.parse(await fs.readFile(capture.file, 'utf8'));
    assert.equal(record.restoredCaptureSha256, sha(JSON.stringify(canonicalGammaJson(value))), '真实IPC字典恢复后的全部捕获字段必须逐值相等');
    assert.equal(record.captureMetricsPreserved, true); assert.equal(record.unresolvedReferences, false); assert.equal(record.encodedUnchanged, true);
  }
  assert.ok(records.some(record => record.tableCount > 0 && record.references > 0), '本次真实业务必须触发table分支，不能用无重复输入冒充');
  const restored = await application.evaluate(() => globalThis.phase2GiHost.restoreTransport()); assert.equal(restored, true);
  return { records, nativeHandlersRestored: restored };
}
