import React, { type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

type EditorErrorBoundaryProps = {
  children: ReactNode;
};

type EditorErrorBoundaryState = {
  error: Error | null;
};

/** 捕获 React 渲染链路中的异常，避免 Electron 窗口只剩空白内容区。 */
class EditorErrorBoundary extends React.Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  state: EditorErrorBoundaryState = {
    error: null,
  };

  /** 将渲染异常转换成可见错误状态。 */
  static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
    return { error };
  }

  /** 输出组件栈，配合 Electron 主进程日志定位白屏根因。 */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('编辑器渲染失败。', error, errorInfo.componentStack);
  }

  /** 渲染正常编辑器界面或可读错误页。 */
  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="app-error-screen" role="alert">
          <section className="app-error-panel">
            <h1>编辑器启动失败</h1>
            <p>{this.state.error.message}</p>
            {this.state.error.stack ? <pre>{this.state.error.stack}</pre> : null}
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

/** 获取 React 挂载节点；缺少根节点时直接显示可读错误，避免静默白屏。 */
function getRootElement(): HTMLElement {
  const rootElement = document.getElementById('root');
  if (rootElement) return rootElement;

  document.body.innerHTML = '<main class="app-error-screen"><section class="app-error-panel"><h1>编辑器启动失败</h1><p>未找到 React 挂载节点 #root。</p></section></main>';
  throw new Error('未找到 React 挂载节点 #root。');
}

ReactDOM.createRoot(getRootElement()).render(
  <React.StrictMode>
    <EditorErrorBoundary>
      <App />
    </EditorErrorBoundary>
  </React.StrictMode>,
);
