/* global document, requestAnimationFrame */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * GPU 计时可用性探针（只读诊断，不参与产品运行）：
 * 在真实 WebGL2 上下文里用 EXT_disjoint_timer_query_webgl2 的 TIME_ELAPSED 区间查询包住一组绘制，
 * 轮询结果并统计 disjoint 丢弃，回答“为什么 Babylon 的 GPU 帧时间一直是 null”。
 * 用法：node scripts/probe-gpu-timer.mjs [--runtime browser|electron] [--frames 120] [--flag <chromium开关>]...
 * 探针不会用无结果的数据补 0；扩展不可用、结果不可用、全部 disjoint 都会原样报告。
 */

/** 在页面内执行的探针；返回可 JSON 序列化的结果。 */
export function probePageFunction(frameCount) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2560; canvas.height = 1440;
    document.body.appendChild(canvas);
    const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true });
    const result = { webgl2: Boolean(gl), renderer: null, extension: false, timestampBits: null, frames: frameCount, samples: [], disjointDiscarded: 0, pendingAtEnd: 0, error: null };
    if (!gl) { resolve(result); return; }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    result.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    result.extension = Boolean(ext);
    if (!ext) { resolve(result); return; }
    result.timestampBits = gl.getQuery(ext.TIMESTAMP_EXT, ext.QUERY_COUNTER_BITS_EXT);
    const compile = (type, source) => { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); return shader; };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 c; void main(){ float v = 0.; for(int i=0;i<64;i++) v += sin(gl_FragCoord.x*0.001+float(i)); c = vec4(v*0.001); }'));
    gl.linkProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    gl.viewport(0, 0, canvas.width, canvas.height);

    const pending = [];
    let issued = 0;
    const drain = () => {
      while (pending.length) {
        const query = pending[0];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        pending.shift();
        // 先读 disjoint 标志再取结果：发生 disjoint 时该时间无效，必须丢弃并计数。
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { result.disjointDiscarded += 1; gl.deleteQuery(query); continue; }
        result.samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(query);
      }
    };
    const frame = () => {
      if (pending.length < 8) {
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        for (let i = 0; i < 4; i++) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(query);
      }
      drain();
      issued += 1;
      if (issued < frameCount) requestAnimationFrame(frame);
      else setTimeout(() => { drain(); result.pendingAtEnd = pending.length; resolve(result); }, 300);
    };
    requestAnimationFrame(frame);
  });
}

/** 汇总样本：无样本时不输出 0，而是 null。 */
export function summarizeGpuTimerProbe(result) {
  const samples = [...result.samples].sort((a, b) => a - b);
  const pick = (ratio) => samples.length ? samples[Math.min(samples.length - 1, Math.ceil(ratio * samples.length) - 1)] : null;
  const usable = result.webgl2 && result.extension && samples.length > 0;
  return {
    usable,
    verdict: !result.webgl2 ? 'WebGL2 上下文不可用（或为软件渲染）'
      : !result.extension ? '运行时未暴露 EXT_disjoint_timer_query_webgl2'
        : samples.length === 0 ? '扩展存在但没有取得任何有效结果（全部 disjoint 或结果不可用）'
          : '可用',
    renderer: result.renderer, timestampBits: result.timestampBits,
    sampleCount: samples.length, disjointDiscarded: result.disjointDiscarded, pendingAtEnd: result.pendingAtEnd,
    minMs: samples[0] ?? null, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: samples.at(-1) ?? null,
  };
}

async function runBrowser(frames, flags) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-gpu-blocklist', ...flags] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body style="margin:0"></body>');
    return await page.evaluate(`(${probePageFunction.toString()})(${frames})`);
  } finally { await browser.close(); }
}

async function runElectron(frames, flags) {
  const electron = createRequire(import.meta.url)('electron');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-timer-probe-'));
  try {
    const mainPath = path.join(directory, 'main.cjs');
    const outputPath = path.join(directory, 'result.json');
    const probePath = path.join(directory, 'probe.js');
    // 探针函数以文件形式交给主进程读取，避免在模板字符串里二次转义。
    await writeFile(probePath, `(${probePageFunction.toString()})(${frames})`);
    await writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
for (const flag of ${JSON.stringify(flags)}) {
  const [name, ...value] = flag.replace(/^--/, '').split('=');
  value.length ? app.commandLine.appendSwitch(name, value.join('=')) : app.commandLine.appendSwitch(name);
}
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  await window.loadURL('data:text/html,<body></body>');
  const result = await window.webContents.executeJavaScript(readFileSync(${JSON.stringify(probePath)}, 'utf8'));
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
`);
    await new Promise((resolve, reject) => {
      // 宿主若设置了 ELECTRON_RUN_AS_NODE，Electron 会退化为普通 Node，必须清除。
      const { ELECTRON_RUN_AS_NODE: _ignored, ...environment } = process.env;
      const child = spawn(electron, [mainPath], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false, env: environment });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Electron 探针退出码 ${code}：${stderr}`)));
    });
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const flags = args.flatMap((arg, index) => arg === '--flag' ? [args[index + 1]] : []);
  const runtime = option('--runtime', 'browser');
  const frames = Number(option('--frames', '120'));
  const raw = runtime === 'electron' ? await runElectron(frames, flags) : await runBrowser(frames, flags);
  console.log(JSON.stringify({ runtime, flags, summary: summarizeGpuTimerProbe(raw) }, null, 2));
}
