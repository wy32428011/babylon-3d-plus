import { useEffect, useState, type FormEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
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

type DataPlatformProjectOpenResult = {
  projectRoot: string;
  sceneFilePath: string | null;
  source: 'package' | 'generated';
  warning: string | null;
  modelSyncStarted: boolean;
};

type DataPlatformProjectOpenApi = {
  openDataPlatformProject?: (request: { projectId: string }) => Promise<DataPlatformProjectOpenResult>;
};

function getDataPlatformProjectOpenApi(): DataPlatformProjectOpenApi {
  return (window.editorApi ?? {}) as DataPlatformProjectOpenApi;
}

const EMPTY_RECENT_WORKSPACES: RecentWorkspacesResult = {
  projects: [],
  scenes: [],
};

const EMPTY_DATA_PLATFORM_CONFIG: DataPlatformConfig = {
  baseUrl: '',
};

/** 格式化最近更新时间，缺失时显示占位，失败时保留原始字符串便于排查。 */
function formatRecentTime(value: string | null | undefined): string {
  if (!value) return '—';

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

/** 拼接远程项目关联的最新 Editor 工程信息。 */
function formatEditorProject(project: DataPlatformProjectEntry): string {
  if (!project.latestEditorProjectName) return '暂无 Editor 工程';
  if (project.latestEditorProjectVersionNumber === null) return `Editor 工程：${project.latestEditorProjectName}`;
  return `Editor 工程：${project.latestEditorProjectName} · v${project.latestEditorProjectVersionNumber}`;
}

/** 去除 Electron IPC 包装前缀，只向用户展示可操作的错误原因。 */
function getHomeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** 从可选 Electron API 中读取最近工作区，普通浏览器环境会返回可读降级状态。 */
async function requestRecentWorkspaces(): Promise<RecentWorkspacesResult> {
  if (!window.editorApi?.getRecentWorkspaces) {
    throw new Error('最近工作区需要 Electron 桌面环境。');
  }

  return window.editorApi.getRecentWorkspaces();
}

/** 从主进程读取持久化的数据中台配置。 */
async function requestDataPlatformConfig(): Promise<DataPlatformConfig> {
  if (!window.editorApi?.getDataPlatformConfig) {
    throw new Error('数据中台配置需要 Electron 桌面环境。');
  }

  return window.editorApi.getDataPlatformConfig();
}

/** 通过主进程访问数据中台，避免 renderer 直接跨域请求。 */
async function requestDataPlatformProjects(projectName = ''): Promise<DataPlatformProjectListResult> {
  if (!window.editorApi?.listDataPlatformProjects) {
    throw new Error('数据中台项目列表需要 Electron 桌面环境。');
  }

  return window.editorApi.listDataPlatformProjects({ projectName });
}

/** 打开数据中台项目，主进程负责准备本地项目与场景文件。 */
async function requestOpenDataPlatformProject(projectId: string): Promise<DataPlatformProjectOpenResult> {
  const dataPlatformProjectApi = getDataPlatformProjectOpenApi();
  if (!dataPlatformProjectApi.openDataPlatformProject) {
    throw new Error('打开数据中台项目需要 Electron 桌面环境。');
  }

  return dataPlatformProjectApi.openDataPlatformProject({ projectId });
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
  const [dataPlatformConfig, setDataPlatformConfig] = useState<DataPlatformConfig>(EMPTY_DATA_PLATFORM_CONFIG);
  const [dataPlatformProjects, setDataPlatformProjects] = useState<DataPlatformProjectEntry[]>([]);
  const [dataPlatformProjectTotal, setDataPlatformProjectTotal] = useState(0);
  const [isLoadingDataPlatformConfig, setIsLoadingDataPlatformConfig] = useState(true);
  const [isLoadingDataPlatformProjects, setIsLoadingDataPlatformProjects] = useState(false);
  const [dataPlatformError, setDataPlatformError] = useState<string | null>(null);
  const [projectSearchDraft, setProjectSearchDraft] = useState('');
  const [activeProjectSearch, setActiveProjectSearch] = useState('');
  const [isConfigDialogOpen, setIsConfigDialogOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState('');
  const [configDialogError, setConfigDialogError] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [status, setStatus] = useState<HomeStatus | null>(null);
  const isOpeningDataPlatformProject = busyActionId?.startsWith('data-platform-project:') ?? false;

  useEffect(() => {
    let isMounted = true;

    /** 首页加载时独立刷新本地最近场景，数据中台失败不会影响本地入口。 */
    async function loadRecentWorkspaces(): Promise<void> {
      setIsLoadingRecent(true);

      try {
        const result = await requestRecentWorkspaces();
        if (!isMounted) return;
        setRecentWorkspaces(result);
      } catch (error) {
        if (!isMounted) return;
        const message = getHomeErrorMessage(error);
        setRecentWorkspaces(EMPTY_RECENT_WORKSPACES);
        setStatus({ kind: 'error', message });
      } finally {
        if (isMounted) setIsLoadingRecent(false);
      }
    }

    /** 首页加载时读取数据中台配置，并在已配置时自动拉取项目列表。 */
    async function loadDataPlatform(): Promise<void> {
      setIsLoadingDataPlatformConfig(true);
      setDataPlatformError(null);

      try {
        const config = await requestDataPlatformConfig();
        if (!isMounted) return;
        setDataPlatformConfig(config);
        setConfigDraft(config.baseUrl);

        if (!config.baseUrl) {
          setDataPlatformProjects([]);
          setDataPlatformProjectTotal(0);
          return;
        }

        setIsLoadingDataPlatformProjects(true);
        const result = await requestDataPlatformProjects('');
        if (!isMounted) return;
        setDataPlatformProjects(result.records);
        setDataPlatformProjectTotal(result.total);
      } catch (error) {
        if (!isMounted) return;
        const message = getHomeErrorMessage(error);
        setDataPlatformProjects([]);
        setDataPlatformProjectTotal(0);
        setDataPlatformError(message);
      } finally {
        if (isMounted) {
          setIsLoadingDataPlatformConfig(false);
          setIsLoadingDataPlatformProjects(false);
        }
      }
    }

    void loadRecentWorkspaces();
    void loadDataPlatform();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isConfigDialogOpen) return undefined;

    /** Escape 仅关闭当前未提交的配置弹窗，保存过程中避免重复操作。 */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !isSavingConfig) {
        setIsConfigDialogOpen(false);
        setConfigDialogError(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isConfigDialogOpen, isSavingConfig]);

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
      const message = getHomeErrorMessage(error);
      setStatus({ kind: 'error', message: `打开项目目录失败：${message}` });
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

  /** 从最近列表移除场景记录，不删除磁盘上的真实文件。 */
  async function handleRemoveRecentScene(filePath: string): Promise<void> {
    if (!window.editorApi?.removeRecentWorkspaceItem) {
      setStatus({ kind: 'error', message: '移除最近记录需要 Electron 桌面环境。' });
      return;
    }

    setBusyActionId(`remove:scene:${filePath}`);

    try {
      await window.editorApi.removeRecentWorkspaceItem({ kind: 'scene', path: filePath });
      setRecentWorkspaces(await requestRecentWorkspaces());
      setStatus({ kind: 'info', message: '最近场景记录已移除。' });
    } catch (error) {
      const message = getHomeErrorMessage(error);
      setStatus({ kind: 'error', message: `移除最近记录失败：${message}` });
    } finally {
      setBusyActionId(null);
    }
  }

  /** 读取已保存配置对应的最新项目列表，刷新和重试默认沿用当前搜索词。 */
  async function refreshDataPlatformProjects(
    projectName = activeProjectSearch,
    baseUrl = dataPlatformConfig.baseUrl,
  ): Promise<void> {
    if (isOpeningDataPlatformProject) return;

    if (!baseUrl) {
      setDataPlatformProjects([]);
      setDataPlatformProjectTotal(0);
      setDataPlatformError(null);
      return;
    }

    setIsLoadingDataPlatformProjects(true);
    setDataPlatformError(null);

    try {
      const result = await requestDataPlatformProjects(projectName);
      setDataPlatformProjects(result.records);
      setDataPlatformProjectTotal(result.total);
      setStatus({
        kind: 'info',
        message: projectName
          ? `已找到 ${result.records.length} 个与“${projectName}”匹配的项目。`
          : `已从数据中台加载 ${result.records.length} 个项目。`,
      });
    } catch (error) {
      const message = getHomeErrorMessage(error);
      setDataPlatformProjects([]);
      setDataPlatformProjectTotal(0);
      setDataPlatformError(message);
    } finally {
      setIsLoadingDataPlatformProjects(false);
    }
  }

  /** 提交项目名称搜索，显式传递新词，避免等待状态更新时使用旧查询。 */
  async function handleSearchDataPlatformProjects(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isOpeningDataPlatformProject) return;
    const projectName = projectSearchDraft.trim();
    setProjectSearchDraft(projectName);
    setActiveProjectSearch(projectName);
    await refreshDataPlatformProjects(projectName);
  }

  /** 清除搜索条件并重新加载默认项目列表。 */
  async function handleClearDataPlatformProjectSearch(): Promise<void> {
    if (isOpeningDataPlatformProject) return;

    setProjectSearchDraft('');
    setActiveProjectSearch('');
    await refreshDataPlatformProjects('');
  }

  /** 打开数据中台项目；已有场景文件时加载场景，否则进入项目编辑器并等待模型同步。 */
  async function handleOpenDataPlatformProject(project: DataPlatformProjectEntry): Promise<void> {
    if (isOpeningDataPlatformProject) return;

    const actionId = `data-platform-project:${project.id}`;
    setBusyActionId(actionId);
    setDataPlatformError(null);
    setStatus({ kind: 'info', message: `正在准备数据中台项目：${project.projectName}` });

    try {
      const result = await requestOpenDataPlatformProject(project.id);
      if (result.warning) {
        setStatus({ kind: 'info', message: `数据中台项目已准备：${result.warning}` });
        useEditorStore.getState().pushLog(`数据中台项目提示：${result.warning}`);
      } else if (result.modelSyncStarted) {
        setStatus({ kind: 'info', message: '数据中台项目已打开，模型同步已开始。' });
      } else {
        setStatus({ kind: 'info', message: '数据中台项目已准备完成。' });
      }
      if (result.modelSyncStarted) {
        useEditorStore.getState().pushLog('数据中台全局模型同步已在后台启动。');
      }

      if (result.sceneFilePath) {
        const loaded = await onOpenRecentScene(result.sceneFilePath);
        if (!loaded) {
          setStatus({ kind: 'error', message: `数据中台项目场景加载失败：${result.sceneFilePath}` });
        }
        return;
      }

      onEnterProjectEditor();
    } catch (error) {
      const message = getHomeErrorMessage(error);
      setStatus({ kind: 'error', message: `打开数据中台项目失败：${message}` });
    } finally {
      setBusyActionId(null);
    }
  }

  /** 打开配置弹窗并回填当前持久化地址。 */
  function openDataPlatformConfigDialog(): void {
    setConfigDraft(dataPlatformConfig.baseUrl);
    setConfigDialogError(null);
    setIsConfigDialogOpen(true);
  }

  /** 关闭配置弹窗，保存过程中禁止通过遮罩或按钮中断。 */
  function closeDataPlatformConfigDialog(): void {
    if (isSavingConfig) return;
    setIsConfigDialogOpen(false);
    setConfigDialogError(null);
  }

  /** 保存数据中台地址，并使用新配置立即刷新左侧项目列表。 */
  async function handleSaveDataPlatformConfig(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!window.editorApi?.saveDataPlatformConfig) {
      setConfigDialogError('保存数据中台配置需要 Electron 桌面环境。');
      return;
    }

    setIsSavingConfig(true);
    setConfigDialogError(null);

    try {
      const savedConfig = await window.editorApi.saveDataPlatformConfig({ baseUrl: configDraft });
      setDataPlatformConfig(savedConfig);
      setConfigDraft(savedConfig.baseUrl);
      setProjectSearchDraft('');
      setActiveProjectSearch('');
      setIsConfigDialogOpen(false);

      if (!savedConfig.baseUrl) {
        setDataPlatformProjects([]);
        setDataPlatformProjectTotal(0);
        setDataPlatformError(null);
        setStatus({ kind: 'info', message: '数据中台配置已清除。' });
        return;
      }

      setStatus({ kind: 'info', message: '数据中台地址已保存，正在刷新项目列表...' });
      await refreshDataPlatformProjects('', savedConfig.baseUrl);
    } catch (error) {
      const message = getHomeErrorMessage(error);
      setConfigDialogError(message);
    } finally {
      setIsSavingConfig(false);
    }
  }

  const hasRecentScenes = recentWorkspaces.scenes.length > 0;
  const projectCountLabel = isLoadingDataPlatformConfig
    ? '读取配置'
    : !dataPlatformConfig.baseUrl
      ? '未配置'
      : isLoadingDataPlatformProjects
        ? '加载中'
        : dataPlatformProjectTotal > dataPlatformProjects.length
          ? `${activeProjectSearch ? '搜索 · ' : ''}${dataPlatformProjects.length} / ${dataPlatformProjectTotal} 项`
          : `${activeProjectSearch ? '搜索 · ' : ''}${dataPlatformProjects.length} 项`;

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
          <button onClick={openDataPlatformConfigDialog} type="button">数据中台配置</button>
          <button onClick={onEnterBlankEditor} type="button">进入空白编辑器</button>
        </div>
      </header>

      <section className="home-content">
        <section className="home-panel home-recent-panel home-data-platform-panel" aria-label="数据中台最近项目">
          <div className="home-panel-header">
            <h2>最近项目</h2>
            <div className="home-panel-header-actions">
              <span>数据中台 · {projectCountLabel}</span>
              <button
                aria-label="刷新数据中台项目"
                disabled={!dataPlatformConfig.baseUrl || isLoadingDataPlatformConfig || isLoadingDataPlatformProjects || isOpeningDataPlatformProject}
                onClick={() => void refreshDataPlatformProjects()}
                type="button"
              >
                刷新
              </button>
            </div>
          </div>
          <form
            aria-label="搜索数据中台项目"
            className="home-project-search"
            onSubmit={(event) => void handleSearchDataPlatformProjects(event)}
            role="search"
          >
            <input
              aria-label="项目名称"
              disabled={!dataPlatformConfig.baseUrl || isLoadingDataPlatformConfig || isLoadingDataPlatformProjects || isOpeningDataPlatformProject}
              maxLength={100}
              onChange={(event) => setProjectSearchDraft(event.target.value)}
              placeholder="输入项目名称"
              spellCheck={false}
              type="search"
              value={projectSearchDraft}
            />
            <button
              disabled={!dataPlatformConfig.baseUrl || isLoadingDataPlatformConfig || isLoadingDataPlatformProjects || isOpeningDataPlatformProject}
              type="submit"
            >
              搜索
            </button>
            <button
              className="home-project-search-clear"
              disabled={
                !dataPlatformConfig.baseUrl
                || isLoadingDataPlatformConfig
                || isLoadingDataPlatformProjects
                || isOpeningDataPlatformProject
                || (!projectSearchDraft && !activeProjectSearch)
              }
              onClick={() => void handleClearDataPlatformProjectSearch()}
              type="button"
            >
              清除
            </button>
          </form>
          <div className="home-recent-list">
            {isLoadingDataPlatformConfig ? (
              <p className="home-empty-state">正在读取数据中台配置...</p>
            ) : null}

            {!isLoadingDataPlatformConfig && dataPlatformError ? (
              <div className="home-empty-state home-empty-state-action home-empty-state-error" role="alert">
                <span>{dataPlatformError}</span>
                <button
                  disabled={isOpeningDataPlatformProject}
                  onClick={dataPlatformConfig.baseUrl
                    ? () => void refreshDataPlatformProjects()
                    : openDataPlatformConfigDialog}
                  type="button"
                >
                  {dataPlatformConfig.baseUrl ? '重试' : '重新配置'}
                </button>
              </div>
            ) : null}

            {!isLoadingDataPlatformConfig && !dataPlatformError && !dataPlatformConfig.baseUrl ? (
              <div className="home-empty-state home-empty-state-action">
                <span>尚未配置数据中台地址</span>
                <button onClick={openDataPlatformConfigDialog} type="button">立即配置</button>
              </div>
            ) : null}

            {!isLoadingDataPlatformConfig
              && !dataPlatformError
              && dataPlatformConfig.baseUrl
              && isLoadingDataPlatformProjects ? (
                <p className="home-empty-state">正在获取数据中台项目...</p>
              ) : null}

            {!isLoadingDataPlatformConfig
              && !dataPlatformError
              && dataPlatformConfig.baseUrl
              && !isLoadingDataPlatformProjects
              && dataPlatformProjects.length === 0 ? (
                <p className="home-empty-state">
                  {activeProjectSearch ? `未找到与“${activeProjectSearch}”匹配的项目` : '数据中台暂无项目'}
                </p>
              ) : null}

            {!dataPlatformError && !isLoadingDataPlatformProjects
              ? dataPlatformProjects.map((project) => (
                <article className="home-recent-card home-data-platform-card" key={project.id}>
                  <div className="home-recent-card-main">
                    <strong>{project.projectName}</strong>
                    <span title={formatEditorProject(project)}>{formatEditorProject(project)}</span>
                  </div>
                  <div className="home-data-platform-stats" aria-label={`${project.projectName}资源统计`}>
                    <span><strong>{project.sceneCount}</strong> 场景</span>
                    <span><strong>{project.modelCount}</strong> 模型</span>
                    <span><strong>{project.screenCount}</strong> 大屏</span>
                  </div>
                  <dl className="home-recent-meta home-data-platform-meta">
                    <div>
                      <dt>工程版本</dt>
                      <dd>{project.latestEditorProjectVersionNumber === null ? '—' : `v${project.latestEditorProjectVersionNumber}`}</dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{formatRecentTime(project.updatedAt)}</dd>
                    </div>
                  </dl>
                  <div className="home-recent-actions">
                    <button
                      disabled={isOpeningDataPlatformProject}
                      onClick={() => void handleOpenDataPlatformProject(project)}
                      type="button"
                    >
                      {busyActionId === `data-platform-project:${project.id}` ? '准备中...' : '打开'}
                    </button>
                  </div>
                </article>
              ))
              : null}
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
                    onClick={() => void handleRemoveRecentScene(scene.filePath)}
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

      {isConfigDialogOpen ? (
        <div
          className="home-config-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDataPlatformConfigDialog();
          }}
          role="presentation"
        >
          <form
            aria-labelledby="home-data-platform-dialog-title"
            aria-modal="true"
            className="home-config-dialog"
            onSubmit={(event) => void handleSaveDataPlatformConfig(event)}
            role="dialog"
          >
            <header>
              <div>
                <h2 id="home-data-platform-dialog-title">数据中台配置</h2>
                <p>配置项目启动台读取业务项目列表的服务地址。</p>
              </div>
              <button
                aria-label="关闭数据中台配置"
                disabled={isSavingConfig}
                onClick={closeDataPlatformConfigDialog}
                type="button"
              >
                ×
              </button>
            </header>

            <label className="home-config-dialog-field">
              <span>服务地址</span>
              <input
                autoFocus
                disabled={isSavingConfig}
                onChange={(event) => setConfigDraft(event.target.value)}
                placeholder="http://127.0.0.1:8080"
                spellCheck={false}
                value={configDraft}
              />
              <small>仅支持 HTTP/HTTPS；留空保存可清除配置。</small>
            </label>

            <p className="home-config-dialog-endpoint">
              保存后请求：<code>api/v1/projects/query</code>
            </p>

            {configDialogError ? (
              <p className="home-config-dialog-error" role="alert">{configDialogError}</p>
            ) : null}

            <div className="home-config-dialog-actions">
              <button disabled={isSavingConfig} onClick={closeDataPlatformConfigDialog} type="button">取消</button>
              <button className="home-config-dialog-primary" disabled={isSavingConfig} type="submit">
                {isSavingConfig ? '保存中...' : '保存并刷新'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}