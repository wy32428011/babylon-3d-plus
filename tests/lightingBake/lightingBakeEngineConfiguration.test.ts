import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLightingBakeEngineConfigurationService } from '../../electron/ipc/lightingBakeEngineConfiguration.ts';
import { detectLightingBakeEnginePath, probeLightingBakeEngineVersion } from '../../electron/ipc/lightingBakeService.ts';
import type { LightingBakeEngineStatus } from '../../electron/shared/sceneLightingBakeContract.ts';

type TestContext = { after(fn: () => Promise<void>): void };
async function setup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-engine-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, configPath: path.join(directory, 'lighting-bake-engine.json'), candidate: path.join(directory, 'Blender 中文', 'blender.exe') };
}
const ready = (candidate: string): LightingBakeEngineStatus => ({ available: true, path: candidate, version: '4.5.3', devices: [{ id: 'cpu', name: 'CPU', backend: 'CPU', type: 'CPU' }] });

test('无工程的本机配置查询显示有效来源，不创建配置文件', async t => {
  const fixture = await setup(t), installed = path.join(fixture.directory, 'installed', 'blender.exe');
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [installed], detectEnginePath: async candidate => ready(candidate) });
  const result = await service.getConfiguration();
  assert.equal(result.configuredPath, null); assert.equal(result.environmentPath, null); assert.equal(result.source, 'installation');
  assert.equal(result.engine.path, installed); assert.equal(result.configPath, fixture.configPath); assert.equal(result.busy, false);
  await assert.rejects(fs.stat(fixture.configPath), { code: 'ENOENT' });
});

test('环境变量优先，失效时依次回退手动配置和安装发现并报告实际来源', async t => {
  const fixture = await setup(t), environment = path.join(fixture.directory, 'environment', 'blender.exe');
  await fs.writeFile(fixture.configPath, JSON.stringify({ blenderPath: fixture.candidate }));
  let available = true; const probes: string[] = [];
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => environment, installationCandidates: async () => [], detectEnginePath: async candidate => { probes.push(candidate); return candidate !== environment || available ? ready(candidate) : { available: false, message: '无法启动本机 Blender。' }; } });
  assert.equal((await service.getConfiguration()).source, 'environment'); assert.deepEqual(probes, [environment]);
  available = false; probes.length = 0;
  const result = await service.getConfiguration(); assert.equal(result.source, 'configuration'); assert.equal(result.environmentPath, environment); assert.equal(result.engine.path, fixture.candidate);
  assert.deepEqual(probes, [environment, fixture.candidate]);
});

test('保存仅精确检测所填路径、刷新缓存并原子保留未知字段，环境变量仍可优先', async t => {
  const fixture = await setup(t), environment = path.join(fixture.directory, 'environment', 'blender.exe');
  await fs.writeFile(fixture.configPath, JSON.stringify({ blenderPath: 'old', future: { enabled: false }, count: 0 }));
  const probes: Array<[string, boolean]> = [];
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => environment, installationCandidates: async () => [], detectEnginePath: async (candidate, refresh) => { probes.push([candidate, refresh]); return ready(candidate); } });
  const result = await service.saveConfiguration(`  ${fixture.candidate}  `);
  assert.deepEqual(probes[0], [fixture.candidate, true]); assert.equal(result.configuredPath, fixture.candidate); assert.equal(result.source, 'environment'); assert.equal(result.engine.path, environment);
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.configPath, 'utf8')), { blenderPath: fixture.candidate, future: { enabled: false }, count: 0 });
  assert.deepEqual((await fs.readdir(fixture.directory)).sort(), ['lighting-bake-engine.json']);
});

test('指定路径检测失败时保存拒绝，原配置逐字节保持不变', async t => {
  const fixture = await setup(t), original = '{ "blenderPath": "old", "keep": true }\n';
  await fs.writeFile(fixture.configPath, original);
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [fixture.candidate], detectEnginePath: async () => ({ available: false, message: '光照烘焙需要 Blender 4 或更新版本。' }) });
  await assert.rejects(service.saveConfiguration(fixture.candidate), /Blender 4/);
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), original);
});

test('空值及空字符串移除手动路径并恢复自动查找，保留未知字段', async t => {
  const fixture = await setup(t), installed = path.join(fixture.directory, 'installed', 'blender.exe');
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [installed], detectEnginePath: async candidate => ready(candidate) });
  for (const candidate of [null, '  ']) {
    await fs.writeFile(fixture.configPath, JSON.stringify({ blenderPath: fixture.candidate, keep: [0, false, null] }));
    const result = await service.saveConfiguration(candidate);
    assert.equal(result.configuredPath, null); assert.equal(result.source, 'installation'); assert.equal(result.engine.path, installed);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.configPath, 'utf8')), { keep: [0, false, null] });
  }
});

test('损坏JSON、错误根类型和非法路径字段明确报告且不能静默覆盖', async t => {
  const fixture = await setup(t);
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => fixture.candidate, installationCandidates: async () => [], detectEnginePath: async candidate => ready(candidate) });
  for (const original of ['{broken', '[]', '{"blenderPath":42}']) {
    await fs.writeFile(fixture.configPath, original);
    const result = await service.getConfiguration(); assert.match(result.configurationError ?? '', /配置/); assert.equal(result.source, 'environment');
    await assert.rejects(service.saveConfiguration(fixture.candidate), /配置/); assert.equal(await fs.readFile(fixture.configPath, 'utf8'), original);
  }
});

test('原子替换失败时保留旧文件并清理仅本次创建的临时文件', async t => {
  const fixture = await setup(t), original = '{"blenderPath":"old","keep":1}';
  await fs.writeFile(fixture.configPath, original);
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [], detectEnginePath: async candidate => ready(candidate), replaceConfigurationFile: async () => { throw new Error('test replace failure'); } });
  await assert.rejects(service.saveConfiguration(fixture.candidate), /保存.*配置/);
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), original); assert.deepEqual(await fs.readdir(fixture.directory), ['lighting-bake-engine.json']);
});

test('烘焙与保存共用预约边界：运行中拒绝保存，保存期间拒绝新任务和并发保存', async t => {
  const fixture = await setup(t); let releaseProbe = () => {}; let holdProbe = false, signalProbe = () => {};
  const probeStarted = new Promise<void>(resolve => { signalProbe = resolve; });
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [], detectEnginePath: async candidate => { if (holdProbe) { signalProbe(); await new Promise<void>(resolve => { releaseProbe = resolve; }); } return ready(candidate); } });
  let finishBake = () => {};
  const baking = service.withBakeJob(() => new Promise<void>(resolve => { finishBake = resolve; }));
  assert.equal((await service.getConfiguration()).busy, true);
  await assert.rejects(service.saveConfiguration(fixture.candidate), /烘焙.*运行|正在.*烘焙/);
  finishBake(); await baking;
  holdProbe = true; const saving = service.saveConfiguration(fixture.candidate);
  await assert.rejects(service.withBakeJob(async () => {}), /保存/); await assert.rejects(service.saveConfiguration(null), /保存/);
  await probeStarted;
  holdProbe = false; releaseProbe(); assert.equal((await saving).busy, false);
  await assert.rejects(service.withBakeJob(async () => { throw new Error('test job error'); }), /test job error/); assert.equal((await service.getConfiguration()).busy, false);
});

test('检测期间外部修改配置时拒绝覆盖，保留外部新内容', async t => {
  const fixture = await setup(t), original = '{"blenderPath":"old"}', external = '{"blenderPath":"external","keep":true}';
  await fs.writeFile(fixture.configPath, original);
  const service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [], detectEnginePath: async candidate => { await fs.writeFile(fixture.configPath, external); return ready(candidate); } });
  await assert.rejects(service.saveConfiguration(fixture.candidate), /配置.*变化|配置.*修改/); assert.equal(await fs.readFile(fixture.configPath, 'utf8'), external);
});

test('指定路径探针拒绝相对路径、非Blender文件名、NUL和非字符串，且不回退其他引擎', async t => {
  const fixture = await setup(t); let calls = 0;
  const options = { probeVersion: async (candidate: string) => { calls++; return ready(candidate); }, discoverDevices: async () => [] };
  for (const candidate of ['blender.exe', path.join(fixture.directory, 'cmd.exe'), `${fixture.candidate}\0`, 42, null]) {
    assert.equal((await detectLightingBakeEnginePath(candidate, options)).available, false);
  }
  assert.equal(calls, 0); assert.match((await detectLightingBakeEnginePath(fixture.candidate, options)).message ?? '', /存在|文件/); assert.equal(calls, 0);
});

test('显式检测刷新同路径的版本与设备缓存，保存后重新创建服务可读回', async t => {
  const fixture = await setup(t); await fs.mkdir(path.dirname(fixture.candidate)); await fs.writeFile(fixture.candidate, 'test-only executable placeholder');
  let probes = 0, devices = 0;
  const options = { probeVersion: async (candidate: string) => ({ ...ready(candidate), version: ++probes === 1 ? '4.5.3' : '5.0.0' }), discoverDevices: async () => { devices++; return ready(fixture.candidate).devices!; } };
  assert.equal((await detectLightingBakeEnginePath(fixture.candidate, options)).version, '4.5.3');
  assert.equal((await detectLightingBakeEnginePath(fixture.candidate, options)).version, '4.5.3'); assert.equal(probes, 1); assert.equal(devices, 1);
  assert.equal((await detectLightingBakeEnginePath(fixture.candidate, { ...options, refresh: true })).version, '5.0.0'); assert.equal(probes, 2); assert.equal(devices, 2);
  const make = () => createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, getEnvironmentPath: () => undefined, installationCandidates: async () => [], detectEnginePath: async candidate => ready(candidate) });
  await make().saveConfiguration(fixture.candidate); assert.equal((await make().getConfiguration()).configuredPath, fixture.candidate);
});

test('默认发现读取环境变量，并按数字版本降序发现受控临时安装目录', async t => {
  const fixture = await setup(t), originalProgramFiles = process.env.ProgramFiles, originalEnvironment = process.env.BABYLON_BLENDER_PATH;
  t.after(async () => { if (originalProgramFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = originalProgramFiles; if (originalEnvironment === undefined) delete process.env.BABYLON_BLENDER_PATH; else process.env.BABYLON_BLENDER_PATH = originalEnvironment; });
  process.env.ProgramFiles = fixture.directory; process.env.BABYLON_BLENDER_PATH = fixture.candidate;
  const base = path.join(fixture.directory, 'Blender Foundation');
  for (const name of ['Blender 4.9', 'Blender 4.10', 'unrelated']) await fs.mkdir(path.join(base, name), { recursive: true });
  const probes: string[] = [], service = createLightingBakeEngineConfigurationService({ userDataDirectory: fixture.directory, detectEnginePath: async candidate => { probes.push(candidate); return ready(candidate); } });
  assert.equal((await service.getConfiguration()).source, 'environment'); delete process.env.BABYLON_BLENDER_PATH;
  assert.equal((await service.getConfiguration()).source, 'installation');
  if (process.platform === 'win32') assert.equal(probes[1], path.join(base, 'Blender 4.10', 'blender.exe'));
});

test('版本子进程超时只终止本次探针；启动异常和版本过低明确失败', async () => {
  for (const behavior of ['timeout', 'error', 'old-version', 'ready'] as const) {
    let kills = 0;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; return true; } });
    const spawnProcess = ((candidate: string, args: string[], options: { shell: boolean; windowsHide: boolean }) => {
      assert.equal(candidate, 'owned-test-blender'); assert.deepEqual(args, ['--version']); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      queueMicrotask(() => {
        if (behavior === 'error') child.emit('error', new Error('fixture spawn failure'));
        else if (behavior !== 'timeout') { child.stdout.write(behavior === 'ready' ? 'Blender 4.5.3\n' : 'Blender 3.6.0\n'); child.emit('close', 0); }
      });
      return child;
    }) as unknown as typeof spawn;
    const result = await probeLightingBakeEngineVersion('owned-test-blender', { spawnProcess, timeoutMs: 5 });
    assert.equal(result.available, behavior === 'ready'); assert.equal(kills, behavior === 'timeout' ? 1 : 0);
    if (behavior === 'timeout') assert.match(result.message ?? '', /超时/);
    if (behavior === 'error') assert.match(result.message ?? '', /无法启动/);
    if (behavior === 'old-version') assert.match(result.message ?? '', /Blender 4/);
    child.stdout.destroy(); child.stderr.destroy();
  }
});

test('旧查询完成较晚时不能覆盖显式刷新的设备缓存', async t => {
  const fixture = await setup(t); await fs.mkdir(path.dirname(fixture.candidate)); await fs.writeFile(fixture.candidate, 'test-only executable placeholder');
  let releaseOld = () => {}, signalOld = () => {}, releaseNew = () => {}, signalNew = () => {};
  const oldStarted = new Promise<void>(resolve => { signalOld = resolve; });
  const newStarted = new Promise<void>(resolve => { signalNew = resolve; });
  const oldQuery = detectLightingBakeEnginePath(fixture.candidate, { probeVersion: async candidate => { signalOld(); await new Promise<void>(resolve => { releaseOld = resolve; }); return ready(candidate); }, discoverDevices: async () => [{ id: 'old', name: 'Old CPU', backend: 'CPU', type: 'CPU' }] });
  await oldStarted;
  const currentDevices = [{ id: 'new', name: 'New GPU', backend: 'CUDA', type: 'GPU' as const }];
  const refreshing = detectLightingBakeEnginePath(fixture.candidate, { refresh: true, probeVersion: async candidate => { signalNew(); await new Promise<void>(resolve => { releaseNew = resolve; }); return { ...ready(candidate), version: '5.0.0' }; }, discoverDevices: async () => currentDevices });
  await newStarted; releaseOld(); await oldQuery; releaseNew();
  assert.deepEqual((await refreshing).devices, currentDevices);
  assert.deepEqual((await detectLightingBakeEnginePath(fixture.candidate)).devices, currentDevices);
});
