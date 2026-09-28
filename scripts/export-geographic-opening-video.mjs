import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const output = path.resolve('output/geographic-opening');
await mkdir(output, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const video = path.join(output, 'geographic-opening-demo.mp4');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let encoder;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  await page.goto(pathToFileURL(path.join(output, 'geographic-opening-demo.html')).href + '?seek=0', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__openingDemo?.getState().ready, null, { timeout: 120000 });
  await page.evaluate(async () => {
    await Promise.all(window.__openingDemo.engine.scenes.map(scene => scene.whenReadyAsync(true)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const baseCamera = await page.evaluate(() => Array.from(window.__openingDemo.scene.activeCamera.getViewMatrix(true).m));
  const duration = await page.evaluate(() => window.__openingDemo.getState().snapshot.totalDurationSeconds);
  assert.ok(Number.isFinite(duration) && duration > 0, '实际开场时长必须有效');
  const frameCount = Math.ceil((duration + 2) * 30);
  let encoderLog = '';
  encoder = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', '30', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  encoder.stderr.on('data', chunk => { encoderLog += chunk.toString(); });
  const completed = once(encoder, 'close');
  for (let frame = 0; frame < frameCount; frame++) {
    if (frame <= Math.ceil(duration * 30)) await page.evaluate(async ({seconds,duration}) => {
      window.__openingDemo.seek(seconds);
      const finalControls=document.querySelector('.complete-controls');
      if(finalControls)finalControls.style.visibility='hidden';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, {seconds:frame / 30,duration});
    const jpg = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!encoder.stdin.write(jpg)) await once(encoder.stdin, 'drain');
    if (frame % 120 === 0) console.log(`录制 ${frame}/${frameCount} 帧`);
  }
  encoder.stdin.end();
  const [code] = await completed;
  if (code !== 0) throw new Error(`视频编码失败：${encoderLog}`);
  const final = await page.evaluate(() => ({ camera: Array.from(window.__openingDemo.scene.activeCamera.getViewMatrix(true).m), state: window.__openingDemo.getState() }));
  assert.deepEqual(final.camera, baseCamera); assert.equal(final.state.scenes, 1);
  assert.equal(final.state.error, null, '录制期间运行器不得回退到错误画面');
  assert.equal(final.state.snapshot.phase, 'complete', '视频最后必须完成场景交接');
  assert.deepEqual(errors, []); assert.deepEqual(external, [], '离线演示不应请求网络资源');
  await writeFile(path.join(output, 'download-verification.json'), JSON.stringify({ video, seconds: frameCount/30, openingSeconds:duration, fps: 30, width: 1600, height: 900, offlineRequests: external, errors, cameraPreserved: true }, null, 2));
  console.log(JSON.stringify({ video, seconds: frameCount/30, fps: 30, errors, offline: true }));
} finally { encoder?.stdin?.destroy(); if (encoder && encoder.exitCode === null) encoder.kill(); await browser.close(); }
