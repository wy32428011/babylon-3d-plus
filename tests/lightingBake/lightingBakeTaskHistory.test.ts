import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { createLightingBakeTask, getLightingBakeTaskHistory, cleanupLightingBakeTasks, readLightingBakeTaskLog } from '../../electron/ipc/lightingBakeTaskHistory.ts';
import { inspectLightingBakeInput } from '../../electron/shared/sceneLightingBakePreflight.ts';
import type { LightingBakeInput } from '../../electron/shared/sceneLightingBakeContract.ts';
const input = { jobId: 'test', sceneName: '历史', signature: 's', meshes: [], lights: [], settings: { probeSpacing: 4, atlasSize: 1024, texelsPerMeter: 8, maxTextureMiB: 16 }, environment: {} } as unknown as LightingBakeInput;
const preflight = { ...inspectLightingBakeInput({ ...input, meshes: [{ positions: [0,0,0], normals: [0,1,0], indices: [], worldMatrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], material: {} }] } as unknown as LightingBakeInput) };
async function setup(t: { after(fn: () => Promise<void>): void }) { const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-history-')); t.after(() => fs.rm(project, { recursive: true, force: true })); return project; }
test('任务阶段持久化、活动任务保护、终态显式清理仅删除 staging', async t => {
  const project = await setup(t), task = await createLightingBakeTask(project, input, '5.2', preflight);
  await fs.writeFile(path.join(task.directory, 'cycles.log'), '测试日志');
  await task.update({ status: 'baking', phase: 'unwrap', progress: 0.1, message: '展开' });
  const history = await getLightingBakeTaskHistory(project); assert.equal(history.tasks[0].status, 'baking'); assert.ok(history.totalStagingBytes > 0); assert.ok(history.tasks[0].phaseMetrics?.every(metric => metric.durationMs >= 0 && metric.mainRssBytes !== null && metric.mainRssBytes > 0 && metric.mainHeapUsedBytes !== null && metric.mainHeapUsedBytes > 0));
  await assert.rejects(cleanupLightingBakeTasks(project, [task.record.taskId]), /运行|活动/);
  await task.finish('cancelled', '用户取消');
  const formal = path.join(project, 'Assets', 'LightingBakes', 'keep'); await fs.mkdir(formal, { recursive: true }); await fs.writeFile(path.join(formal, 'keep.json'), 'keep');
  assert.equal(await readLightingBakeTaskLog(project, task.record.taskId), '测试日志');
  const result = await cleanupLightingBakeTasks(project, [task.record.taskId]); assert.equal(result.removedTaskIds.length, 1); assert.ok(result.removedBytes > 0); assert.equal(await fs.readFile(path.join(formal, 'keep.json'), 'utf8'), 'keep');
});
test('重开遗留运行态标中断，未知文件及路径越界拒绝清理', async t => {
  const project = await setup(t), task = await createLightingBakeTask(project, input, '5.2', preflight);
  await task.finish('error', '失败');
  const record = { ...task.record, status: 'baking' }; await fs.writeFile(path.join(task.directory, 'task.json'), JSON.stringify(record));
  const history = await getLightingBakeTaskHistory(project); assert.equal(history.tasks[0].status, 'interrupted');
  await fs.writeFile(path.join(task.directory, 'user-file.txt'), 'preserve');
  await assert.rejects(cleanupLightingBakeTasks(project, [task.record.taskId]), /归属|未知/);
  await assert.rejects(cleanupLightingBakeTasks(project, ['../Assets']), /标识/);
});

test('任务中出现 Junction 或子目录时拒绝回收，链接目标保持完整', async t => {
  const project=await setup(t), task=await createLightingBakeTask(project,input,'5.2',preflight); await task.finish('completed','完成');
  const protectedDirectory=path.join(project,'protected'); await fs.mkdir(protectedDirectory); await fs.writeFile(path.join(protectedDirectory,'keep.txt'),'keep');
  await fs.symlink(protectedDirectory,path.join(task.directory,'linked'),'junction');
  await assert.rejects(cleanupLightingBakeTasks(project,[task.record.taskId]),/普通文件|归属/);
  assert.equal(await fs.readFile(path.join(protectedDirectory,'keep.txt'),'utf8'),'keep');
});

test('损坏可选错误与设备字段不能进入历史UI，也不能借清理删除原文件', async t => {
  const project=await setup(t), task=await createLightingBakeTask(project,input,'5.2',preflight); await task.finish('error','失败');
  for(const patch of [{error:{}},{device:{requested:'gpu',actual:'CPU',name:'CPU',backend:'CPU',fallbackReason:{}}}]) {
    await fs.writeFile(path.join(task.directory,'task.json'),JSON.stringify({...task.record,...patch}));
    assert.equal((await getLightingBakeTaskHistory(project)).tasks.length,0);
    await assert.rejects(cleanupLightingBakeTasks(project,[task.record.taskId]),/归属/); assert.ok((await fs.stat(task.directory)).isDirectory());
  }
});

test('非关键内存采样抛错时任务仍可创建、更新、完成并读取未知指标', async t => {
  const project=await setup(t), original=process.memoryUsage;
  try {
    process.memoryUsage=Object.assign(()=>{throw new Error('platform memory sampling unavailable');},{rss:original.rss});
    const task=await createLightingBakeTask(project,input,'5.2',preflight);
    await task.update({status:'applying',phase:'applying',progress:0.97,message:'正式资产已提交'});
    await task.finish('completed','完成',123);
    const history=await getLightingBakeTaskHistory(project), recorded=history.tasks[0];
    assert.equal(recorded.status,'completed');assert.equal(recorded.progress,1);assert.equal(recorded.outputBytes,123);
    assert.ok(recorded.phaseMetrics?.every(metric=>metric.mainRssBytes===null&&metric.mainHeapUsedBytes===null));
    const cleanup=await cleanupLightingBakeTasks(project,[task.record.taskId]);assert.deepEqual(cleanup.removedTaskIds,[task.record.taskId]);
  } finally {process.memoryUsage=original;}
});

test('阶段最大内存保留有效观察值，未知采样不清零且恢复后继续累计', async t => {
  const project=await setup(t), original=process.memoryUsage;
  let sample:{rss:number;heapUsed:number}|null={rss:100,heapUsed:50};
  try {
    process.memoryUsage=Object.assign(()=>{if(!sample)throw new Error('transient unavailable');return {...sample,heapTotal:200,external:0,arrayBuffers:0};},{rss:original.rss});
    const task=await createLightingBakeTask(project,input,'5.2',preflight);
    sample=null;await task.update({message:'采样临时不可用'});
    sample={rss:140,heapUsed:40};await task.update({message:'采样恢复'});
    assert.equal(task.record.phaseMetrics?.[0].mainRssBytes,140);assert.equal(task.record.phaseMetrics?.[0].mainHeapUsedBytes,50);
    sample=null;await task.update({status:'baking',phase:'baking'});
    assert.equal(task.record.phaseMetrics?.[1].mainRssBytes,null);assert.equal(task.record.phaseMetrics?.[1].mainHeapUsedBytes,null);
    sample={rss:130,heapUsed:80};await task.update({message:'新阶段采样恢复'});
    assert.equal(task.record.phaseMetrics?.[1].mainRssBytes,130);assert.equal(task.record.phaseMetrics?.[1].mainHeapUsedBytes,80);
    sample={rss:Number.NaN,heapUsed:-1};await task.update({status:'applying',phase:'applying'});
    assert.equal(task.record.phaseMetrics?.[2].mainRssBytes,null);assert.equal(task.record.phaseMetrics?.[2].mainHeapUsedBytes,null);
    await task.finish('completed','完成');assert.equal((await getLightingBakeTaskHistory(project)).tasks[0].status,'completed');
  } finally {process.memoryUsage=original;}
});
