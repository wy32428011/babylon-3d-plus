import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('初始项目资源加载在 StrictMode 清理后不会再调度模型发现刷新', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*let active = true;[\s\S]*?void loadProjectAssets\(\)\.then\(\(initialLoad\) => \{\s*if \(!active \|\| sceneSessionIdRef\.current !== sceneSessionId\) return;/,
  );
  assert.match(
    source,
    /return \(\) => \{\s*active = false;[\s\S]*?projectAssetsLoadRequestRef\.current \+= 1;/,
  );
});
