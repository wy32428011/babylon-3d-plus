/** 等待主进程接收中止请求；false 表示没有远程任务，不等于取消失败。 */
export async function cancelProjectLoading(cancel: (() => Promise<boolean>) | undefined): Promise<void> {
  if (!cancel) throw new Error('当前编辑器不支持取消远程加载，请更新编辑器后重试。');
  await cancel();
}

/** 使已取消或已卸载首页的异步打开结果失效。 */
export function createProjectOpenSession() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => { generation += 1; },
    isCurrent: (request: number) => request === generation,
  };
}
