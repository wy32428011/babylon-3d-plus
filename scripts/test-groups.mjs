import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const groups = {
  core: ['test:lift-motion-arrows', 'test:digital-twin:unit', 'test:build-analysis', 'test:dev-asset-paths', 'test:typescript-build', 'test:expression', 'test:groups'],
  integration: ['test:digital-twin:integration', 'test:lift-motion-arrows:integration'],
  smoke: ['smoke:scene-capacity', 'smoke:lift-motion-arrows'],
};

export function auditEntries(scripts, manifest) {
  const missing = manifest.entries.filter(entry => scripts[entry.name] !== entry.command).map(entry => entry.name);
  if (missing.length) throw new Error(`既有入口丢失或命令改变：${missing.join(', ')}`);
  for (const names of Object.values(groups)) for (const name of names) {
    if (!scripts[name]) throw new Error(`分组入口不存在：${name}`);
  }
  return { retained: manifest.entries.length, missing: 0 };
}

// 每项独立子进程；串行保留 npm 入口原有构建、并发与全局状态隔离。
export function runCommand(command, args, { cwd = root, timeoutMs = 600_000, signal, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('测试已取消')); return; }
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio, windowsHide: true, detached: process.platform !== 'win32' });
    // pipe 供机制测试使用；持续消费避免输出积压本身改变被测进程的生命周期。
    if (stdio === 'pipe') { child.stdout.resume(); child.stderr.resume(); }
    let reason, stopping = false, settled = false, exitedAt;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const finish = error => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve({ code: 0 }); };
    const stop = async message => {
      if (stopping || settled) return;
      stopping = true; reason = new Error(message);
      try {
        if (process.platform === 'win32') {
          // CIM 保留已退出父进程的 ParentProcessId；同时核对创建时间，避免按复用 PID 清理。
          const script = `$start=[DateTimeOffset]::FromUnixTimeMilliseconds(${started}).UtcDateTime; $end=[DateTimeOffset]::FromUnixTimeMilliseconds(${exitedAt ?? Date.now()}).UtcDateTime; $rootPid=${child.pid}; $items=@(Get-CimInstance Win32_Process -ErrorAction Stop); $owned=@{}; $owned[$rootPid]=$true; $selected=@(); do { $changed=$false; foreach($item in $items) { if(!$item.CreationDate) { continue }; if($selected.ProcessId -contains $item.ProcessId) { continue }; $created=$item.CreationDate.ToUniversalTime(); if($created -lt $start) { continue }; $isRoot=($item.ProcessId -eq $rootPid); if(($isRoot -and $created -le $end -and ${exitedAt ? '$false' : '$true'}) -or (!$isRoot -and $owned.ContainsKey([int]$item.ParentProcessId) -and ($item.ParentProcessId -ne $rootPid -or $created -le $end))) { $selected+=,$item; $owned[[int]$item.ProcessId]=$true; $changed=$true } } } while($changed); foreach($item in ($selected | Sort-Object CreationDate -Descending)) { $live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.ProcessId) -ErrorAction Stop; if($live -and $live.CreationDate -eq $item.CreationDate) { $result=Invoke-CimMethod -InputObject $live -MethodName Terminate -ErrorAction Stop; if($result.ReturnValue -ne 0) { throw ('Terminate failed: '+$item.ProcessId) } } }`;
          await new Promise((done, fail) => {
            const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
            const deadline = setTimeout(() => { killer.kill(); fail(new Error('进程树清理超时')); }, 15000);
            killer.once('error', error => { clearTimeout(deadline); fail(error); });
            killer.once('close', code => { clearTimeout(deadline); code === 0 ? done() : fail(new Error(`进程树清理失败：${code}`)); });
          });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      } catch (error) { reason = new Error(`${message}；${error.message}`); }
      // 父进程已经退出时，close 仍可能被后代继承的管道拖住；清理完成后直接给出终态。
      child.stdout?.destroy(); child.stderr?.destroy(); finish(reason);
    };
    const cancel = () => stop('测试已取消');
    const timer = setTimeout(() => stop(`测试超时：${timeoutMs}ms`), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', error => finish(error));
    child.once('exit', (code, exitSignal) => {
      exitedAt = Date.now();
      if (!stopping && code !== 0) void stop(`测试失败：exit=${code}, signal=${exitSignal ?? 'none'}`);
    });
    child.once('close', (code, exitSignal) => {
      if (stopping) return;
      if (code !== 0) void stop(`测试失败：exit=${code}, signal=${exitSignal ?? 'none'}`);
      else finish();
    });
  });
}

async function main() {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const manifest = JSON.parse(readFileSync(path.join(root, 'scripts/test-entry-manifest.json'), 'utf8'));
  const audit = auditEntries(scripts, manifest);
  const [group = 'core', ...flags] = process.argv.slice(2);
  if (group === '--check' || group === '--list') { console.log(JSON.stringify({ ...audit, groups, entries: manifest.entries }, null, 2)); return; }
  if (!(group in groups) || flags.length) throw new Error('用法：test-groups.mjs [core|integration|smoke|--check|--list]');
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('找不到 npm-cli.js，请通过 npm test / npm run 调用。');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    for (const name of groups[group]) { console.log(`[test-group:${group}] ${name}`); await runCommand(process.execPath, [npmCli, 'run', name], { signal: abort.signal }); }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
