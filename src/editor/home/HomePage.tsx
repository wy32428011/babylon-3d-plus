import { useEffect, useState } from 'react';
import { APPLICATION_NAME, BrandLogo } from '../ui/BrandLogo';

type HomePageProps = {
  onEnterBlankEditor: () => void;
  onEnterProjectEditor: () => void;
  onNewScene: () => void;
  onOpenSceneDialog: () => Promise<boolean>;
  onOpenRecentScene: (filePath: string) => Promise<boolean>;
};

type HomeStatus = {
  kind: 'info' | 'error';
  message: string;
};

const EMPTY_RECENT_WORKSPACES: RecentWorkspacesResult = {
  projects: [],
  scenes: [],
};

/** 格式化最近打开时间，失败时保留原始 ISO 字符串便于排查。 */
function formatRecentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 从可选 Electron API 中读取最近工作区，普通浏览器环境会返回可读降级状态。 */
async function requestRecentWorkspaces(): Promise<RecentWorkspacesResult> {
  if (!window.editorApi?.getRecentWorkspaces) {
    throw new Error('最近项目需要 Electron 桌面环境。');
  }

  return window.editorApi.getRecentWorkspaces();
}

/** 渲染进入编辑器前的启动台，集中承载项目与场景入口。 */
export function HomePage({
  onEnterBlankEditor,
  onEnterProjectEditor,
  onNewScene,
  onOpenSceneDialog,
  onOpenRecentScene,
}: HomePageProps) {
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspacesResult>(EMPTY_RECENT_WORKSPACES);
  const [isLoadingRecent, setIsLoadingRecent] = useState(true);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [status, setStatus] = useState<HomeStatus | null>(null);

  useEffect(() => {
    let isMounted = true;

    /** 首页加载时刷新最近工作区列表，失效路径由主进程标记并留给用户移除。 */
    async function loadRecentWorkspaces(): Promise<void> {
      setIsLoadingRecent(true);

      try {
        const result = await requestRecentWorkspaces();
        if (!isMounted) return;
        setRecentWorkspaces(result);
        setStatus(null);
      } catch (error) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : String(error);
        setRecentWorkspaces(EMPTY_RECENT_WORKSPACES);
        setStatus({ kind: 'error', message });
      } finally {
        if (isMounted) setIsLoadingRecent(false);
      }
    }

    void loadRecentWorkspaces();

    return () => {
      isMounted = false;
    };
  }, []);

  /** 选择新的项目目录后进入编辑器，Project 面板会沿用当前项目根目录加载资产。 */
  async function handleSelectProjectDirectory(): Promise<void> {
    if (!window.editorApi?.selectProjectDirectory) {
      setStatus({ kind: 'error', message: '选择项目目录需要 Electron 桌面环境。' });
      return;
    }

    setBusyActionId('select-project');
    setStatus({ kind: 'info', message: '正在选择项目目录...' });

    try {
      const result = await window.editorApi.selectProjectDirectory();
      if (result.canceled || !result.projectRoot) {
        setStatus({ kind: 'info', message: '已取消选择项目目录。' });
        return;
      }

      onEnterProjectEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: 'error', message: `打开项目目录失败：${message}` });
    } finally {
      setBusyActionId(null);
    }
  }

  /** 打开最近项目，主进程负责设置当前项目并授权项目资产目录。 */
  async function handleOpenRecentProject(project: RecentProjectEntry): Promise<void> {
    if (!project.exists) return;
    if (!window.editorApi?.openRecentProject) {
      setStatus({ kind: 'error', message: '打开最近项目需要 Electron 桌面环境。' });
      return;
    }

    setBusyActionId(`project:${project.projectRoot}`);
    setStatus({ kind: 'info', message: `正在打开项目：${project.displayName}` });

    try {
      await window.editorApi.openRecentProject({ projectRoot: project.projectRoot });
      onEnterProjectEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: 'error', message: `打开最近项目失败：${message}` });
    } finally {
      setBusyActionId(null);
    }
  }

  /** 打开最近场景，加载成功后由 App 切换到编辑器。 */
  async function handleOpenRecentScene(scene: RecentSceneEntry): Promise<void> {
    if (!scene.exists) return;

    setBusyActionId(`scene:${scene.filePath}`);
    setStatus({ kind: 'info', message: `正在打开场景：${scene.displayName}` });

    try {
      const loaded = await onOpenRecentScene(scene.filePath);
      if (!loaded) {
        setStatus({ kind: 'error', message: `打开场景失败：${scene.displayName}` });
      }
    } finally {
      setBusyActionId(null);
    }
  }

  /** 调用系统文件选择器打开场景文件，取消时留在首页。 */
  async function handleOpenSceneDialog(): Promise<void> {
    setBusyActionId('open-scene-dialog');
    setStatus({ kind: 'info', message: '正在打开场景文件...' });

    try {
      const loaded = await onOpenSceneDialog();
      if (!loaded) {
        setStatus({ kind: 'info', message: '已取消打开场景文件。' });
      }
    } finally {
      setBusyActionId(null);
    }
  }

  /** 从最近列表移除单条记录，不删除磁盘上的真实文件或目录。 */
  async function handleRemoveRecentItem(kind: 'project' | 'scene', itemPath: string): Promise<void> {
    if (!window.editorApi?.removeRecentWorkspaceItem) {
      setStatus({ kind: 'error', message: '移除最近记录需要 Electron 桌面环境。' });
      return;
    }

    setBusyActionId(`remove:${kind}:${itemPath}`);

    try {
      await window.editorApi.removeRecentWorkspaceItem({ kind, path: itemPath });
      setRecentWorkspaces(await requestRecentWorkspaces());
      setStatus({ kind: 'info', message: '最近记录已移除。' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: 'error', message: `移除最近记录失败：${message}` });
    } finally {
      setBusyActionId(null);
    }
  }

  const hasRecentProjects = recentWorkspaces.projects.length > 0;
  const hasRecentScenes = recentWorkspaces.scenes.length > 0;

  return (
    <main className="home-page" aria-label="编辑器首页">
      <header className="home-topbar">
        <div className="home-brand">
          <h1 aria-label={APPLICATION_NAME}>
            <BrandLogo className="home-brand-logo" surface="dark" />
            <span className="home-brand-product">3D EDITOR</span>
          </h1>
          <p>项目启动台</p>
        </div>
        <div className="home-actions" aria-label="首页操作">
          <button onClick={onNewScene} type="button">新建场景</button>
          <button
            disabled={busyActionId === 'open-scene-dialog'}
            onClick={() => void handleOpenSceneDialog()}
            type="button"
          >
            打开场景文件
          </button>
          <button
            disabled={busyActionId === 'select-project'}
            onClick={() => void handleSelectProjectDirectory()}
            type="button"
          >
            打开项目目录
          </button>
          <button onClick={onEnterBlankEditor} type="button">进入空白编辑器</button>
        </div>
      </header>

      <section className="home-content">
        <section className="home-panel home-recent-panel" aria-label="最近打开项目">
          <div className="home-panel-header">
            <h2>最近项目</h2>
            <span>{isLoadingRecent ? '加载中' : `${recentWorkspaces.projects.length} 项`}</span>
          </div>
          <div className="home-recent-list">
            {!isLoadingRecent && !hasRecentProjects ? (
              <p className="home-empty-state">暂无最近项目</p>
            ) : null}
            {recentWorkspaces.projects.map((project) => (
              <article className={project.exists ? 'home-recent-card' : 'home-recent-card home-recent-card-missing'} key={project.projectRoot}>
                <div className="home-recent-card-main">
                  <strong>{project.displayName}</strong>
                  <span title={project.projectRoot}>{project.projectRoot}</span>
                </div>
                <dl className="home-recent-meta">
                  <div>
                    <dt>模型</dt>
                    <dd>{project.exists ? project.assetCount : '失效'}</dd>
                  </div>
                  <div>
                    <dt>时间</dt>
                    <dd>{formatRecentTime(project.lastOpenedAt)}</dd>
                  </div>
                </dl>
                {project.lastScenePath ? <p className="home-recent-subline" title={project.lastScenePath}>最近场景：{project.lastScenePath}</p> : null}
                <div className="home-recent-actions">
                  <button
                    disabled={!project.exists || busyActionId === `project:${project.projectRoot}`}
                    onClick={() => void handleOpenRecentProject(project)}
                    type="button"
                  >
                    打开
                  </button>
                  <button
                    disabled={busyActionId === `remove:project:${project.projectRoot}`}
                    onClick={() => void handleRemoveRecentItem('project', project.projectRoot)}
                    type="button"
                  >
                    移除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="home-panel home-recent-panel" aria-label="最近打开场景">
          <div className="home-panel-header">
            <h2>最近场景</h2>
            <span>{isLoadingRecent ? '加载中' : `${recentWorkspaces.scenes.length} 项`}</span>
          </div>
          <div className="home-recent-list">
            {!isLoadingRecent && !hasRecentScenes ? (
              <p className="home-empty-state">暂无最近场景</p>
            ) : null}
            {recentWorkspaces.scenes.map((scene) => (
              <article className={scene.exists ? 'home-recent-card' : 'home-recent-card home-recent-card-missing'} key={scene.filePath}>
                <div className="home-recent-card-main">
                  <strong>{scene.displayName}</strong>
                  <span title={scene.filePath}>{scene.filePath}</span>
                </div>
                <dl className="home-recent-meta">
                  <div>
                    <dt>状态</dt>
                    <dd>{scene.exists ? '可用' : '失效'}</dd>
                  </div>
                  <div>
                    <dt>时间</dt>
                    <dd>{formatRecentTime(scene.lastOpenedAt)}</dd>
                  </div>
                </dl>
                {scene.projectRoot ? <p className="home-recent-subline" title={scene.projectRoot}>项目：{scene.projectRoot}</p> : null}
                <div className="home-recent-actions">
                  <button
                    disabled={!scene.exists || busyActionId === `scene:${scene.filePath}`}
                    onClick={() => void handleOpenRecentScene(scene)}
                    type="button"
                  >
                    打开
                  </button>
                  <button
                    disabled={busyActionId === `remove:scene:${scene.filePath}`}
                    onClick={() => void handleRemoveRecentItem('scene', scene.filePath)}
                    type="button"
                  >
                    移除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      {status ? (
        <p className={`home-status home-status-${status.kind}`} role="status" aria-live="polite">
          {status.message}
        </p>
      ) : null}
    </main>
  );
}
