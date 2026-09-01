import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeDataPlatformChartSync,
  getDataPlatformChartIndexPath,
  readDataPlatformChartIndex,
  writeDataPlatformChartIndex,
} from '../../electron/ipc/dataPlatformChartStore.ts';

const PROJECT_ID = '2054201280000000001';

function page(
  records: unknown[],
  total: unknown = records.length,
  pageNum: unknown = 1,
  pageSize: unknown = 100,
): unknown {
  return {
    success: true,
    data: {
      records,
      total,
      pageNum,
      pageSize,
    },
  };
}

function screen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    relationId: '2054201280000000100',
    screenId: '2054201280000000200',
    screenName: '设备总览',
    screenCode: 'SCREEN-OVERVIEW',
    jsonContent: JSON.stringify({
      version: 1,
      widgets: [
        { id: 'line-main', type: 'LINE_CHART', name: '产量趋势', pageKey: 'overview' },
        { id: 'bar-main', type: 'BAR_CHART', name: '设备排行' },
        { id: 'pie-main', type: 'PIE_CHART', name: '状态占比' },
        { id: 'metric-main', type: 'METRIC_CARD', name: '今日产量' },
      ],
    }),
    ...overrides,
  };
}

test('项目大屏同步按字符串保留 Long ID，并且只同步完整大屏', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-sync-'));
  try {
    const requests: Array<{ pageNum: number; pageSize: number }> = [];
    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async (pageNum, pageSize) => {
        requests.push({ pageNum, pageSize });
        return page([screen()]);
      },
    });

    assert.deepEqual(requests, [{ pageNum: 1, pageSize: 100 }]);
    assert.equal(result.projectId, PROJECT_ID);
    assert.deepEqual(result.charts.map((chart) => chart.chartType), ['SCREEN']);
    assert.deepEqual(result.charts.map((chart) => chart.screenId), ['2054201280000000200']);
    assert.deepEqual(result.charts.map((chart) => chart.id), [
      `data-platform-screen:${PROJECT_ID}:2054201280000000200`,
    ]);
    assert.equal(result.charts[0]?.name, '设备总览');
    assert.equal(Object.hasOwn(result.charts[0] ?? {}, 'widgetId'), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('兼容数据中台 PageResult 将分页 Long 字段序列化为字符串', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-string-page-'));
  try {
    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async () => page([screen({ jsonContent: '' })], '1', '1', '100'),
    });

    assert.equal(result.charts.length, 1);
    assert.equal(result.charts[0]?.chartType, 'SCREEN');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('分页字符串仍拒绝小数、指数和超出安全整数范围的值', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-invalid-string-page-'));
  try {
    for (const total of ['1.5', '1e3', '9007199254740992']) {
      await assert.rejects(
        executeDataPlatformChartSync({
          projectId: PROJECT_ID,
          projectRoot,
          syncedAt: '2026-09-01T08:00:00.000Z',
          requestPage: async () => page([screen({ jsonContent: '' })], total, '1', '100'),
        }),
        /total.*非负安全整数/,
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('大屏索引只保存卡片元数据，不解析或落盘内部图表配置', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-minimal-index-'));
  try {
    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async () => page([screen({
        jsonContent: JSON.stringify({
          version: 1,
          widgets: [{
            id: 'line-private',
            type: 'LINE_CHART',
            name: '私有数据趋势',
            data: {
              remoteData: {
                url: 'https://api.example.com/private',
                headers: { Authorization: 'Bearer should-not-be-persisted' },
              },
            },
          }],
        }),
      })]),
    });

    assert.equal(result.charts.length, 1);
    const persisted = await readFile(getDataPlatformChartIndexPath(projectRoot), 'utf8');
    assert.doesNotMatch(persisted, /line-private|Authorization|should-not-be-persisted|api\.example\.com/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('jsonContent 为空或损坏时仍只同步完整大屏', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-screen-only-sync-'));
  try {
    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async () => page([
        screen({ jsonContent: '' }),
        screen({
          screenId: '2054201280000000201',
          screenName: '能源总览',
          screenCode: 'SCREEN-ENERGY',
          jsonContent: '{broken',
        }),
      ]),
    });

    assert.deepEqual(result.charts.map((chart) => chart.name), ['设备总览', '能源总览']);
    assert.ok(result.charts.every((chart) => chart.chartType === 'SCREEN'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('项目大屏查询遍历分页并在空项目时清空当前项目图表', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-pages-'));
  try {
    await writeDataPlatformChartIndex(projectRoot, {
      version: 1,
      projectId: PROJECT_ID,
      syncedAt: '2026-08-31T08:00:00.000Z',
      charts: [{
        id: `data-platform-chart:${PROJECT_ID}:101:old-chart`,
        projectId: PROJECT_ID,
        screenId: '101',
        screenName: '旧大屏',
        widgetId: 'old-chart',
        name: '旧图表',
        chartType: 'LINE_CHART',
      }],
    });

    const pageRequests: number[] = [];
    const twoPageResult = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      pageSize: 1,
      requestPage: async (pageNum) => {
        pageRequests.push(pageNum);
        if (pageNum === 1) return page([screen()], 2, 1, 1);
        return page([screen({
          screenId: '2054201280000000201',
          screenName: '能源总览',
          jsonContent: JSON.stringify({
            version: 1,
            widgets: [{ id: 'energy-pie', type: 'PIE_CHART', name: '能源占比' }],
          }),
        })], 2, 2, 1);
      },
    });
    assert.deepEqual(pageRequests, [1, 2]);
    assert.equal(twoPageResult.charts.length, 2);

    const emptyResult = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T09:00:00.000Z',
      requestPage: async () => page([]),
    });
    assert.deepEqual(emptyResult.charts, []);
    assert.deepEqual((await readDataPlatformChartIndex(projectRoot, PROJECT_ID)).charts, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('读取旧索引时过滤内部图表，仅保留完整大屏', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-legacy-index-'));
  try {
    const indexPath = getDataPlatformChartIndexPath(projectRoot);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, `${JSON.stringify({
      version: 1,
      projectId: PROJECT_ID,
      syncedAt: '2026-08-31T08:00:00.000Z',
      charts: [
        {
          id: `data-platform-screen:${PROJECT_ID}:101`,
          projectId: PROJECT_ID,
          screenId: '101',
          screenName: '旧大屏',
          name: '旧大屏',
          chartType: 'SCREEN',
        },
        {
          id: `data-platform-chart:${PROJECT_ID}:101:old-chart`,
          projectId: PROJECT_ID,
          screenId: '101',
          screenName: '旧大屏',
          widgetId: 'old-chart',
          name: '旧图表',
          chartType: 'BAR_CHART',
        },
      ],
    }, null, 2)}\n`, 'utf8');

    const index = await readDataPlatformChartIndex(projectRoot, PROJECT_ID);
    assert.deepEqual(index.charts.map((chart) => chart.chartType), ['SCREEN']);
    assert.deepEqual(index.charts.map((chart) => chart.name), ['旧大屏']);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('损坏的 jsonContent 不影响替换旧项目大屏索引', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-json-ignored-'));
  try {
    await writeDataPlatformChartIndex(projectRoot, {
      version: 1,
      projectId: PROJECT_ID,
      syncedAt: '2026-08-31T08:00:00.000Z',
      charts: [{
        id: `data-platform-screen:${PROJECT_ID}:101`,
        projectId: PROJECT_ID,
        screenId: '101',
        screenName: '旧大屏',
        name: '旧大屏',
        chartType: 'SCREEN',
      }],
    });

    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async () => page([screen({ jsonContent: '{broken' })]),
    });

    assert.deepEqual(result.charts.map((chart) => chart.name), ['设备总览']);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('分页未取完 total 时拒绝提交，避免把缺失大屏误判为已删除', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-truncated-page-'));
  try {
    const oldIndex = {
      version: 1 as const,
      projectId: PROJECT_ID,
      syncedAt: '2026-08-31T08:00:00.000Z',
      charts: [{
        id: `data-platform-screen:${PROJECT_ID}:101`,
        projectId: PROJECT_ID,
        screenId: '101',
        screenName: '旧大屏',
        name: '旧大屏',
        chartType: 'SCREEN' as const,
      }],
    };
    await writeDataPlatformChartIndex(projectRoot, oldIndex);

    await assert.rejects(
      executeDataPlatformChartSync({
        projectId: PROJECT_ID,
        projectRoot,
        syncedAt: '2026-09-01T08:00:00.000Z',
        requestPage: async () => page([screen()], 2),
      }),
      /total|分页|未取完/,
    );

    assert.deepEqual(await readDataPlatformChartIndex(projectRoot, PROJECT_ID), oldIndex);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('分页响应页码不一致时拒绝提交并保留旧项目索引', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-page-contract-'));
  try {
    const oldIndex = {
      version: 1 as const,
      projectId: PROJECT_ID,
      syncedAt: '2026-08-31T08:00:00.000Z',
      charts: [{
        id: `data-platform-screen:${PROJECT_ID}:101`,
        projectId: PROJECT_ID,
        screenId: '101',
        screenName: '旧大屏',
        name: '旧大屏',
        chartType: 'SCREEN' as const,
      }],
    };
    await writeDataPlatformChartIndex(projectRoot, oldIndex);

    await assert.rejects(
      executeDataPlatformChartSync({
        projectId: PROJECT_ID,
        projectRoot,
        syncedAt: '2026-09-01T08:00:00.000Z',
        requestPage: async () => page([screen()], 1, 2, 100),
      }),
      /pageNum|页码/,
    );

    assert.deepEqual(await readDataPlatformChartIndex(projectRoot, PROJECT_ID), oldIndex);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('内部图表重复不会参与同步或触发稳定 ID 冲突', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-widget-ignored-'));
  try {
    const result = await executeDataPlatformChartSync({
      projectId: PROJECT_ID,
      projectRoot,
      syncedAt: '2026-09-01T08:00:00.000Z',
      requestPage: async () => page([screen({
        jsonContent: JSON.stringify({
          version: 1,
          widgets: [
            { id: 'duplicate-chart', type: 'LINE_CHART', name: '趋势 A' },
            { id: 'duplicate-chart', type: 'BAR_CHART', name: '趋势 B' },
          ],
        }),
      })]),
    });

    assert.deepEqual(result.charts.map((chart) => chart.chartType), ['SCREEN']);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('重复大屏稳定 ID 时拒绝提交', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-screen-duplicate-'));
  try {
    await assert.rejects(
      executeDataPlatformChartSync({
        projectId: PROJECT_ID,
        projectRoot,
        syncedAt: '2026-09-01T08:00:00.000Z',
        requestPage: async () => page([
          screen({ jsonContent: '' }),
          screen({ screenName: '重复大屏', jsonContent: '' }),
        ]),
      }),
      /重复|冲突/,
    );

    await assert.rejects(readFile(getDataPlatformChartIndexPath(projectRoot)), /ENOENT/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('图表索引拒绝跨项目读取和不安全数字型 Long ID', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'zending-chart-isolation-'));
  try {
    await writeDataPlatformChartIndex(projectRoot, {
      version: 1,
      projectId: PROJECT_ID,
      syncedAt: '2026-09-01T08:00:00.000Z',
      charts: [],
    });
    await assert.rejects(
      readDataPlatformChartIndex(projectRoot, '2054201280000000002'),
      /项目不匹配/,
    );

    await assert.rejects(
      executeDataPlatformChartSync({
        projectId: PROJECT_ID,
        projectRoot,
        syncedAt: '2026-09-01T08:00:00.000Z',
        requestPage: async () => page([screen({ screenId: 2054201280000000200 })]),
      }),
      /screenId.*安全整数|大屏 ID/,
    );

    const persisted = JSON.parse(await readFile(getDataPlatformChartIndexPath(projectRoot), 'utf8')) as { projectId: unknown };
    assert.equal(typeof persisted.projectId, 'string');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
