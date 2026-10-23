import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'lazy-editor-dialog-'));
const server = await createServer({ configFile: false, cacheDir: path.join(temporary, 'vite'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(async () => {
  await server.close();
  if (path.dirname(temporary) !== os.tmpdir() || !path.basename(temporary).startsWith('lazy-editor-dialog-')) throw new Error('测试临时目录范围无效');
  await rm(temporary, { recursive: true, force: true });
});
const { LazyEditorDialog } = await server.ssrLoadModule('/src/editor/ui/LazyEditorDialog.tsx');

const fixture = props => createElement('p', null, props.open ? `已打开：${props.draft}` : '宿主保留');
function createHost(load, extra = {}) {
  const host = new LazyEditorDialog({ load, dialogProps: { open: false, draft: '测试草稿' }, open: false,
    title: '测试窗口', onClose() {}, ...extra });
  // 只驱动公开 React 生命周期，SSR 用于检查加载和反馈；真实焦点与快捷键由浏览器验收覆盖。
  host.setState = update => { host.state = { ...host.state, ...update }; };
  return host;
}
function updateHost(host, patch) {
  host.props = { ...host.props, ...patch };
  host.state = { ...host.state, ...LazyEditorDialog.getDerivedStateFromProps(host.props, host.state) };
}
function renderLoaded(element) {
  return new Promise((resolve, reject) => {
    let markup = '';
    const errors = [];
    const output = new Writable({ write(chunk, _encoding, done) { markup += chunk.toString(); done(); } });
    output.on('error', reject);
    output.on('finish', () => resolve({ markup, errors }));
    const stream = renderToPipeableStream(element, {
      onAllReady() { stream.pipe(output); },
      onError(error) { errors.push(error); },
      onShellError: reject,
    });
  });
}

test('首次关闭不请求弹窗代码，首次打开才展示可关闭的模态加载反馈', async () => {
  let loads = 0;
  let resolve;
  const host = createHost(() => { loads++; return new Promise(done => { resolve = done; }); });
  assert.equal(host.render(), null);
  assert.equal(loads, 0);
  updateHost(host, { open: true, dialogProps: { open: true, draft: '未丢失' } });
  const pending = renderToStaticMarkup(host.render());
  assert.equal(loads, 1);
  assert.match(pending, /role="dialog"/);
  assert.match(pending, /data-editor-lazy-dialog/);
  assert.match(pending, /正在打开测试窗口/);
  assert.match(pending, /关闭测试窗口/);
  resolve({ default: fixture });
  const result = await renderLoaded(host.render());
  assert.deepEqual(result.errors, []);
  assert.match(result.markup, /已打开：未丢失/);
});

test('打开后关闭保留同一 lazy 类型及原弹窗关闭副作用所需的 open=false 属性', async () => {
  let loads = 0;
  const host = createHost(async () => { loads++; return { default: fixture }; });
  updateHost(host, { open: true, dialogProps: { open: true, draft: '保留草稿' } });
  await renderLoaded(host.render());
  const dialogType = host.state.Dialog;
  updateHost(host, { open: false, dialogProps: { open: false, draft: '保留草稿' } });
  assert.equal(host.render().props.children.type, dialogType);
  assert.equal(host.render().props.children.props.open, false);
  assert.equal(host.render().props.fallback, null);
  assert.match((await renderLoaded(host.render())).markup, /宿主保留/);
  updateHost(host, { open: true, dialogProps: { open: true, draft: '保留草稿' } });
  assert.equal(host.state.Dialog, dialogType);
  assert.match((await renderLoaded(host.render())).markup, /保留草稿/);
  assert.equal(loads, 1);
});

test('加载失败只影响当前弹窗，可关闭，并通过新的 lazy 类型真正重试', async () => {
  let loads = 0, closed = 0;
  const failure = new Error('模拟网络不可用');
  const host = createHost(async () => {
    loads++;
    if (loads === 1) throw failure;
    return { default: fixture };
  }, { onClose() { closed++; } });
  updateHost(host, { open: true, dialogProps: { open: true, draft: '重试保留' } });
  assert.deepEqual((await renderLoaded(host.render())).errors, [failure]);
  host.state = { ...host.state, ...LazyEditorDialog.getDerivedStateFromError(failure) };
  const feedback = host.render();
  const markup = renderToStaticMarkup(feedback);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /模拟网络不可用/);
  assert.match(markup, /重新加载/);
  feedback.props.onClose();
  assert.equal(closed, 1);
  updateHost(host, { open: false });
  assert.equal(host.render(), null);
  updateHost(host, { open: true });
  const failedType = host.state.Dialog;
  host.render().props.onRetry();
  assert.notEqual(host.state.Dialog, failedType);
  assert.equal(host.state.error, null);
  assert.match((await renderLoaded(host.render())).markup, /已打开：重试保留/);
  assert.equal(loads, 2);
});

test('人物预览关闭时允许卸载独立 WebGL 场景，布局在加载反馈期间保护快捷键', async () => {
  const host = createHost(async () => ({ default: fixture }), { keepMounted: false });
  updateHost(host, { open: true });
  updateHost(host, { open: false });
  assert.equal(host.render(), null);
  const [layout, inspector] = await Promise.all([
    readFile(new URL('../../src/editor/layout/EditorLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/panels/ManualRoamAvatarInspector.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /dialog\[data-editor-lazy-dialog\]\[open\]/);
  for (const name of ['DeploymentExportDialog', 'DigitalTwinPublishDialog', 'LightingBakeManager']) {
    assert.doesNotMatch(layout, new RegExp(`import \\{ ${name} \\} from`));
    assert.match(layout, new RegExp(`import\\('[^']+/${name}'\\)`));
  }
  assert.match(inspector, /loadManualRoamAvatarPreviewDialog/);
  assert.match(inspector, /preview\.sessionId === sceneSessionId && runtimeMode === 'edit'/);
  assert.match(inspector, /keepMounted=\{false\}/);
});
