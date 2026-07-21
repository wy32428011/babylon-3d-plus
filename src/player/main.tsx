import React from 'react';
import ReactDOM from 'react-dom/client';
import { PlayerApp } from './PlayerApp';

/** 获取 Viewer 挂载节点，缺失时显式阻断而不是静默白屏。 */
function getRootElement(): HTMLElement {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('未找到 Web Viewer 挂载节点 #root。');
  return rootElement;
}

ReactDOM.createRoot(getRootElement()).render(
  <React.StrictMode>
    <PlayerApp />
  </React.StrictMode>,
);
