import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('首页数据中台项目卡片展示最新发布时间', async () => {
  const [homeSource, cssSource, electronTypesSource, rendererTypesSource, ipcSource] = await Promise.all([
    readFile(new URL('../../src/editor/home/HomePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/vite-env.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/ipc/dataPlatformIpc.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(electronTypesSource, /digitalTwinLastPublishedAt: string \| null/);
  assert.match(rendererTypesSource, /digitalTwinLastPublishedAt: string \| null/);
  assert.match(
    ipcSource,
    /digitalTwinLastPublishedAt: normalizeOptionalString\(value\.digitalTwinLastPublishedAt\)/,
  );
  assert.match(electronTypesSource, /frontendPort: number \| null/);
  assert.match(rendererTypesSource, /frontendPort: number \| null/);
  assert.match(ipcSource, /frontendPort: stored\.frontendPort/);
  assert.match(ipcSource, /resolveSavedDataPlatformPageConfig\(/);
  assert.match(homeSource, /<dt>最新发布时间<\/dt>/);
  assert.match(
    homeSource,
    /formatRecentTime\(project\.digitalTwinLastPublishedAt\)/,
  );
  assert.match(homeSource, /className="home-data-platform-publish-meta"/);
  assert.match(
    cssSource,
    /\.home-data-platform-publish-meta\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s,
  );
});
