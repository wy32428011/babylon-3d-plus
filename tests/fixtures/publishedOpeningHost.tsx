import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import Preview from '@published-opening/Preview';
import Published from '@published-opening/Published';

// 页面、组件渲染器及 iframe 桥接均使用中台真实源码；仅 Umi 路由与请求入口由夹具提供。
const Page = location.pathname === '/preview' ? Preview : Published;
createRoot(document.getElementById('root')!).render(
  <ConfigProvider><App><Page /></App></ConfigProvider>,
);
