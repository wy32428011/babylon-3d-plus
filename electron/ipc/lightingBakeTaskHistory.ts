import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LightingBakeInput } from '../shared/sceneLightingBakeContract.ts';
import type { LightingBakePreflight } from '../shared/sceneLightingBakePreflight.ts';
import type { LightingBakeTaskRecord, LightingBakeTaskStatus, LightingBakeTaskHistory, LightingBakeTaskCleanup } from '../shared/sceneLightingBakeTasks.ts';
const activeTasks = new Set<string>();
const terminal = new Set<LightingBakeTaskStatus>(['completed', 'cancelled', 'error', 'interrupted']);
const taskIdPattern = /^[A-Za-z0-9_-]{1,160}$/;
function missing(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }
function isKnownMemory(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
/** 内存计量不是任务前置条件；平台不支持或采样异常时明确记录未知。 */
function sampleProcessMemory(): { rss: number | null; heapUsed: number | null } {
  try {
    const memory = process.memoryUsage();
    return { rss: isKnownMemory(memory.rss) ? memory.rss : null, heapUsed: isKnownMemory(memory.heapUsed) ? memory.heapUsed : null };
  } catch { return { rss: null, heapUsed: null }; }
}
function maximumObservedMemory(previous: number | null, current: number | null): number | null {
  if (current === null) return previous;
  return previous === null ? current : Math.max(previous, current);
}
async function tasksRoot(projectRoot: string, create = false): Promise<string> {
  const project = await fs.realpath(projectRoot);
  let current = project;
  for (const segment of ['.babylon-editor', 'lighting-bake-jobs']) {
    current = path.join(current, segment);
    if (create) { try { await fs.mkdir(current); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; } }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error('烘焙任务目录包含链接，拒绝读取或清理。');
  }
  return current;
}
async function taskDirectory(projectRoot: string, taskId: string): Promise<string> {
  if (!taskIdPattern.test(taskId)) throw new Error('烘焙任务标识无效。');
  const root = await tasksRoot(projectRoot), directory = path.join(root, taskId), stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('烘焙任务目录归属无效。');
  return directory;
}
async function readRecord(directory: string): Promise<LightingBakeTaskRecord> {
  const file = path.join(directory, 'task.json'), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('烘焙任务记录归属无效。');
  const record = JSON.parse(await fs.readFile(file, 'utf8')) as LightingBakeTaskRecord;
  if (!record || typeof record !== 'object') throw new Error('烘焙任务记录归属无效。');
  if (record.version !== 1 || record.format !== 'babylon-lighting-bake-task' || record.taskId !== path.basename(directory)
    || !taskIdPattern.test(record.jobId) || !record.taskId.startsWith(record.jobId + '-') || !['preparing','baking','applying',...terminal].includes(record.status)
    || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.sceneName !== 'string'
    || record.error !== undefined && typeof record.error !== 'string'
    || record.device !== undefined && (!record.device || typeof record.device !== 'object' || !['cpu','auto','gpu'].includes(record.device.requested) || !['CPU','GPU'].includes(record.device.actual) || typeof record.device.name !== 'string' || typeof record.device.backend !== 'string' || record.device.fallbackReason !== undefined && typeof record.device.fallbackReason !== 'string')
    || record.captureMetrics !== undefined && (!record.captureMetrics || typeof record.captureMetrics !== 'object' || record.captureMetrics.durationMs !== null && (!Number.isFinite(record.captureMetrics.durationMs) || record.captureMetrics.durationMs < 0) || !['performance.memory.usedJSHeapSize','unavailable'].includes(record.captureMetrics.rendererHeapBasis) || record.captureMetrics.rendererHeapMaxObservedBytes !== null && (!Number.isFinite(record.captureMetrics.rendererHeapMaxObservedBytes) || record.captureMetrics.rendererHeapMaxObservedBytes < 0))
    || record.inputBytes !== undefined && (!Number.isFinite(record.inputBytes) || record.inputBytes < 0)
    || record.expandedGeometryBytes !== undefined && (!Number.isFinite(record.expandedGeometryBytes) || record.expandedGeometryBytes < 0)
    || typeof record.logAvailable !== 'boolean'
    || typeof record.signature !== 'string' || typeof record.phase !== 'string' || typeof record.message !== 'string' || typeof record.engineVersion !== 'string'
    || !Number.isFinite(record.progress) || record.progress < 0 || record.progress > 1 || !Number.isFinite(record.durationMs) || record.durationMs < 0
    || !Number.isFinite(record.stagingBytes) || record.stagingBytes < 0 || !Number.isFinite(record.outputBytes) || record.outputBytes < 0
    || !record.preflight || record.preflight.signature !== record.signature || (!Array.isArray(record.preflight.issues) || record.preflight.issues.some(issue => !issue || typeof issue.code !== 'string' || typeof issue.message !== 'string' || !['error','warning'].includes(issue.severity)))
    || record.phaseMetrics !== undefined && (!Array.isArray(record.phaseMetrics) || record.phaseMetrics.some(metric => !metric || typeof metric.phase !== 'string' || !Number.isFinite(metric.durationMs) || metric.durationMs < 0 || [metric.mainRssBytes,metric.mainHeapUsedBytes].some(value => value !== null && !isKnownMemory(value)) || metric.cyclesPeakRssBytes !== null && (!Number.isFinite(metric.cyclesPeakRssBytes) || metric.cyclesPeakRssBytes < 0)))) throw new Error('烘焙任务记录归属无效。');
  return record;
}
async function persist(directory: string, record: LightingBakeTaskRecord): Promise<void> {
  const temp = path.join(directory, 'task.json.tmp');
  try { const old = await fs.lstat(temp); if (!old.isFile() || old.isSymbolicLink()) throw new Error('烘焙任务临时记录无效。'); } catch (error) { if (!missing(error)) throw error; }
  await fs.writeFile(temp, JSON.stringify(record));
  await fs.rename(temp, path.join(directory, 'task.json'));
}
async function inspectFiles(directory: string, forCleanup = false): Promise<{ bytes: number; logAvailable: boolean }> {
  let bytes = 0, logAvailable = false;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const stat = await fs.lstat(path.join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('任务目录含非普通文件，无法证明清理归属。');
    if (forCleanup && !/^(?:task\.json(?:\.tmp)?|cycles(?:-cpu)?\.log|cycles_bake\.py|input\.json|result\.json|preflight\.json|probes\.json|(?:geometry|lightmap)-\d+\.(?:json|png)|source-texture-\d+\.[A-Za-z0-9]+|geometry-(?:input-)?\d+\.bin)$/.test(entry.name)) throw new Error('任务目录含未知文件，无法证明清理归属。');
    bytes += stat.size; if (entry.name === 'cycles.log') logAvailable = true;
  }
  return { bytes, logAvailable };
}
function engineAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
}
export async function createLightingBakeTask(projectRoot: string, input: LightingBakeInput, engineVersion: string, preflight: LightingBakePreflight) {
  const root = await tasksRoot(projectRoot, true), directory = await fs.mkdtemp(path.join(root, input.jobId + '-'));
  const now = new Date().toISOString();
  const record: LightingBakeTaskRecord = { version: 1, format: 'babylon-lighting-bake-task', taskId: path.basename(directory), jobId: input.jobId, sceneName: input.sceneName, signature: input.signature,
    status: 'preparing', phase: 'preparing', progress: 0, message: '正在准备烘焙任务', startedAt: now, updatedAt: now, durationMs: 0, engineVersion,
    stagingBytes: 0, outputBytes: 0, logAvailable: false, preflight, ...(input.captureMetrics ? { captureMetrics: { ...input.captureMetrics } } : {}) };
  activeTasks.add(directory);
  let pending = Promise.resolve();
  const update = (patch: Partial<LightingBakeTaskRecord>): Promise<void> => {
    const memory = sampleProcessMemory();
    const metrics = record.phaseMetrics ??= [];
    let current = metrics[metrics.length - 1];
    if (current) current.durationMs = Math.max(0, Date.now() - Date.parse(record.updatedAt)) + current.durationMs;
    if (!current || patch.phase && patch.phase !== current.phase) {
      current = { phase: patch.phase ?? record.phase, durationMs: 0, mainRssBytes: memory.rss, mainHeapUsedBytes: memory.heapUsed, cyclesPeakRssBytes: null }; metrics.push(current);
    }
    current.mainRssBytes = maximumObservedMemory(current.mainRssBytes, memory.rss); current.mainHeapUsedBytes = maximumObservedMemory(current.mainHeapUsedBytes, memory.heapUsed);
    Object.assign(record, patch, { updatedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(record.startedAt) });
    const snapshot = structuredClone(record); pending = pending.then(() => persist(directory, snapshot)); void pending.catch(() => {}); return pending;
  };
  try { await update({}); } catch (error) { activeTasks.delete(directory); throw error; }
  return { directory, record, update, flush: () => pending,
    async finish(status: 'completed' | 'cancelled' | 'error', message: string, outputBytes = 0) {
      try { const info = await inspectFiles(directory); await update({ status, phase: status, progress: status === 'completed' ? 1 : record.progress, message, completedAt: new Date().toISOString(), enginePid: undefined, outputBytes, stagingBytes: info.bytes, logAvailable: info.logAvailable, ...(status === 'error' ? { error: message } : {}) }); }
      finally { activeTasks.delete(directory); }
    } };
}
/** 仅枚举当前工程；旧进程仍存活时保留中断记录但拒绝清理。 */
export async function getLightingBakeTaskHistory(projectRoot: string): Promise<LightingBakeTaskHistory> {
  let root: string;
  try { root = await tasksRoot(projectRoot); } catch (error) { if (missing(error)) return { tasks: [], totalStagingBytes: 0 }; throw error; }
  const tasks: LightingBakeTaskRecord[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !taskIdPattern.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const record = await readRecord(directory), info = await inspectFiles(directory);
      if (!terminal.has(record.status) && !activeTasks.has(directory)) { record.status = 'interrupted'; record.phase = 'interrupted'; record.message = '上次烘焙已中断，请查看日志后重新发起。'; record.completedAt = record.updatedAt = new Date().toISOString(); await persist(directory, record); }
      tasks.push({ ...record, stagingBytes: info.bytes, logAvailable: info.logAvailable });
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError || error instanceof Error && /归属|普通文件/.test(error.message)) continue;
      throw error;
    }
  }
  tasks.sort((a,b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { tasks, totalStagingBytes: tasks.reduce((sum, task) => sum + task.stagingBytes, 0) };
}
export async function cleanupLightingBakeTasks(projectRoot: string, taskIds: string[], isProjectCurrent: () => boolean = () => true): Promise<LightingBakeTaskCleanup> {
  if (!Array.isArray(taskIds) || taskIds.length > 1000 || taskIds.some(id => typeof id !== 'string' || !taskIdPattern.test(id))) throw new Error('烘焙任务标识无效。');
  if (!isProjectCurrent()) throw new Error('工程已切换，已停止清理。');
  const candidates: Array<{ directory: string; record: LightingBakeTaskRecord; bytes: number }> = [];
  for (const id of new Set(taskIds)) {
    if (!isProjectCurrent()) throw new Error('工程已切换，已停止清理。');
    const directory = await taskDirectory(projectRoot, id), record = await readRecord(directory);
    if (activeTasks.has(directory) || !terminal.has(record.status) || engineAlive(record.enginePid)) throw new Error('活动任务或引擎仍在运行，不能清理。');
    const info = await inspectFiles(directory, true); candidates.push({ directory, record, bytes: info.bytes });
  }
  const result: LightingBakeTaskCleanup = { removedTaskIds: [], removedBytes: 0 };
  for (const candidate of candidates) {
    // 再次检查归属及活动状态；唯一删除目标始终是专用任务根的直接子目录。
    await taskDirectory(projectRoot, candidate.record.taskId);
    if (activeTasks.has(candidate.directory)) throw new Error('任务重新活动，不能清理。');
    await inspectFiles(candidate.directory, true);
    if (!isProjectCurrent()) throw new Error('工程已切换，已停止清理。');
    await fs.rm(candidate.directory, { recursive: true, force: false }); result.removedTaskIds.push(candidate.record.taskId); result.removedBytes += candidate.bytes;
  }
  return result;
}
export async function readLightingBakeTaskLog(projectRoot: string, taskId: string): Promise<string> {
  const directory = await taskDirectory(projectRoot, taskId); await readRecord(directory);
  const names = ['cycles.log'];
  try { const retry = await fs.lstat(path.join(directory, 'cycles-cpu.log')); if (retry.isFile() && !retry.isSymbolicLink()) names.push('cycles-cpu.log'); }
  catch (error) { if (!missing(error)) throw error; }
  const parts: string[] = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('烘焙日志归属无效。');
    const handle = await fs.open(file, 'r');
    try { const limit = names.length > 1 ? 32768 : 65536, length = Math.min(stat.size, limit), bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, Math.max(0, stat.size - length));
      parts.push((names.length > 1 ? '[' + name + ']\n' : '') + (stat.size > length ? '（仅显示日志末尾）\n' : '') + bytes.toString('utf8'));
    } finally { await handle.close(); }
  }
  return parts.join('\n\n');
}
