import assert from 'node:assert/strict';
import test from 'node:test';
import { auditEntries, groups, runCommand } from '../scripts/test-groups.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('分组保留旧命令并拒绝入口丢失或静默改写', () => {
  const scripts = Object.fromEntries(Object.values(groups).flat().map(name => [name, 'preserved']));
  const manifest = { entries: [{ name: 'test:digital-twin:unit', command: 'preserved' }] };
  assert.deepEqual(auditEntries(scripts, manifest), { retained: 1, missing: 0 });
  assert.throws(() => auditEntries({ ...scripts, 'test:digital-twin:unit': 'changed' }, manifest), /丢失或命令改变/);
  assert.throws(() => auditEntries({ ...scripts, 'test:groups': undefined }, manifest), /分组入口不存在/);
});
test('子进程成功与非零退出准确传播', async () => {
  assert.deepEqual(await runCommand(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' }), { code: 0 });
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'pipe' }), /exit=7/);
});
test('超时结束本次子进程并报告失败', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 120, stdio: 'pipe' }), /超时/);
});
test('运行中取消和预先取消均报告失败', async () => {
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, stdio: 'pipe' });
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(pending, /取消/);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal, stdio: 'pipe' }), /取消/);
});

test('父进程非零退出后清理真实长期后代，pipe 不再悬挂', { timeout: 25000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'babylon-test-tree-'));
  const pidFile = path.join(directory, 'owned-child.pid');
  let descendant;
  try {
    const leaf = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('child alive');setInterval(()=>{},1000);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setTimeout(()=>process.exit(7),500);`;
    const began = Date.now();
    await assert.rejects(runCommand(process.execPath, ['-e', parent], { stdio: 'pipe', timeoutMs: 20000 }), /exit=7/);
    descendant = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let index = 0; index < 30 && alive; index++) {
      try { process.kill(descendant, 0); await new Promise(resolve => setTimeout(resolve, 100)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    assert.equal(alive, false, '本次创建的后代必须结束');
    assert.ok(Date.now() - began < 18000, '失败路径必须在原20秒测试超时前给出终态');
  } finally {
    if (!descendant) { try { descendant = Number(readFileSync(pidFile, 'utf8')); } catch {} }
    if (descendant) { try { process.kill(descendant); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rmSync(directory, { recursive: true });
  }
});
