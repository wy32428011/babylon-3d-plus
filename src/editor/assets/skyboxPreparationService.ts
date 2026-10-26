import { collectSceneSkyboxReferences } from '../../../electron/shared/sceneResourceTraversal.ts';
import { normalizeSkyboxEnvironmentResource, skyboxEnvironmentMatchesSource,
  type SkyboxEnvironmentResource, type SkyboxPreparationSource, type SkyboxPreparationStage } from '../../../electron/shared/sceneSkyboxContract.ts';
import type { SceneDocument, SceneSkyboxSettings } from '../model/SceneDocument';

type Progress = (stage: SkyboxPreparationStage) => void;
type Source = SkyboxPreparationSource & { environment?: SkyboxEnvironmentResource; sourceAvailable?: false };
type Job = { controller: AbortController; promise: Promise<SkyboxEnvironmentResource>; users: number; settled: boolean; listeners: Set<Progress>; start: () => void; cancel: () => void };
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = false;

function drain(): void {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  job.start();
}
function notify(job: Job, stage: SkyboxPreparationStage): void {
  for (const listener of job.listeners) {
    try { listener(stage); } catch (error) { console.warn('天空准备进度观察者失败：', error); }
  }
}

/** Editor 的唯一准备队列；Viewer 不导入本模块，同源消费者共享任务但独立取消。 */
export function prepareSkyboxEnvironment(source: Source, signal: AbortSignal, progress: Progress = () => undefined, contextKey = ''): Promise<SkyboxEnvironmentResource> {
  signal.throwIfAborted();
  const existing = source.environment ? normalizeSkyboxEnvironmentResource(source.environment) : null;
  if (!window.editorApi?.prepareSkyboxEnvironment) {
    if (existing && skyboxEnvironmentMatchesSource(source, existing)) return Promise.resolve(existing);
    return Promise.reject(new Error('此天空尚未生成 ENV，请在桌面编辑器中准备原始 HDR/EXR 后再打开。'));
  }
  const key = JSON.stringify([contextKey, source.sourceUrl, source.sourcePath, source.format, source.assetRevision ?? '', source.resolution,
    source.sourceAvailable === false ? existing?.sha256 : null]);
  let job = jobs.get(key);
  if (!job || job.controller.signal.aborted) {
    if (queue.length >= 8) return Promise.reject(new Error('天空转换等待队列已满，请取消旧任务后重试。'));
    let resolve!: (value: SkyboxEnvironmentResource) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SkyboxEnvironmentResource>((yes, no) => { resolve = yes; reject = no; });
    const created: Job = { controller: new AbortController(), promise, users: 0, settled: false, listeners: new Set(),
      cancel: () => {
        created.controller.abort();
        const index = queue.indexOf(created);
        if (index < 0) return;
        queue.splice(index, 1);
        created.settled = true;
        if (jobs.get(key) === created) jobs.delete(key);
        reject(created.controller.signal.reason);
      },
      start: () => {
        void execute(source, created).then(resource => { created.settled = true; resolve(resource); }, error => {
          created.settled = true; reject(error);
        }).finally(() => {
          if (jobs.get(key) === created) jobs.delete(key);
          running = false; drain();
        });
      },
    };
    job = created; jobs.set(key, created); queue.push(created);
  }
  const selected = job;
  selected.users++; selected.listeners.add(progress);
  const promise = new Promise<SkyboxEnvironmentResource>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown, resource?: SkyboxEnvironmentResource) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort); selected.listeners.delete(progress);
      selected.users--;
      if (error !== undefined) reject(error); else resolve(resource!);
      if (selected.users === 0 && !selected.settled) selected.cancel();
    };
    const abort = () => finish(signal.reason ?? new DOMException('天空准备已取消。', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    selected.promise.then(resource => finish(undefined, resource), error => finish(error));
    if (signal.aborted) abort();
  });
  drain();
  return promise;
}

async function execute(source: Source, job: Job): Promise<SkyboxEnvironmentResource> {
  const api = window.editorApi, signal = job.controller.signal;
  if (!api?.prepareSkyboxEnvironment || !api.commitSkyboxEnvironment || !api.cancelSkyboxEnvironment) throw new Error('当前窗口缺少 ENV 准备接口，请完整重启编辑器。');
  let token: string | null = null;
  let cancellation: Promise<unknown> | undefined;
  const cancelToken = () => {
    if (!token) return;
    const canceledToken = token;
    token = null;
    cancellation = api.cancelSkyboxEnvironment(canceledToken).catch(error => console.warn('取消天空准备任务失败：', error));
  };
  signal.addEventListener('abort', cancelToken, { once: true });
  try {
    signal.throwIfAborted(); notify(job, 'source-read'); signal.throwIfAborted();
    const ticket = await api.prepareSkyboxEnvironment({ sourceUrl: source.sourceUrl, sourcePath: source.sourcePath,
      format: source.format, assetRevision: source.assetRevision, resolution: source.resolution,
      ...(source.sourceAvailable === false ? { sourceAvailable: false as const } : {}),
      ...(source.environment ? { environment: source.environment } : {}) });
    token = ticket.token;
    signal.throwIfAborted();
    if (ticket.environment) return normalizeSkyboxEnvironmentResource(ticket.environment);
    if (!token) throw new Error('天空准备未返回有效的生成任务。');
    const { compileSkyboxEnvironment } = await import('./skyboxEnvironmentCompiler.ts');
    const bytes = await compileSkyboxEnvironment(ticket, source.format, signal, stage => notify(job, stage));
    signal.throwIfAborted(); notify(job, 'commit'); signal.throwIfAborted();
    const result = await api.commitSkyboxEnvironment({ token, bytes });
    signal.throwIfAborted();
    token = null;
    return normalizeSkyboxEnvironmentResource(result);
  } finally {
    signal.removeEventListener('abort', cancelToken);
    cancelToken();
    await cancellation;
  }
}

/** 只丰富捕获的副本，不修改 Store、撤销历史、原场景文件或原图身份。 */
export async function prepareSceneSkyboxEnvironments(document: SceneDocument, signal: AbortSignal,
  progress: Progress = () => undefined, contextKey = ''): Promise<SceneDocument> {
  const references = collectSceneSkyboxReferences(document);
  if (!references.length) return document;
  const copy = structuredClone(document);
  for (const skybox of collectSceneSkyboxReferences(copy)) {
    signal.throwIfAborted();
    skybox.environment = await prepareSkyboxEnvironment(skybox as unknown as SceneSkyboxSettings, signal, progress, contextKey);
  }
  signal.throwIfAborted();
  return copy;
}
