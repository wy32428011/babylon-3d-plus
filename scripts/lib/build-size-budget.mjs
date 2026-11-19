const ALLOWED_GROWTH_PERCENT = 5;

/** 用最终产物静态 JS 闭包的原始字节数校验首屏体积。 */
export function checkInitialJsBudget(target, summary, baseline) {
  const actualBytes = summary?.totals?.initial?.bytes;
  const baselineBytes = baseline?.initialJsBytes?.[target];
  if (
    summary?.target !== target ||
    !Number.isSafeInteger(actualBytes) ||
    actualBytes <= 0 ||
    !Number.isSafeInteger(baselineBytes) ||
    baselineBytes <= 0
  ) {
    throw new Error(`${target} 缺少有效的首屏 JS 构建统计或基线。`);
  }

  const limitBytes = Math.floor((baselineBytes * (100 + ALLOWED_GROWTH_PERCENT)) / 100);
  return { actualBytes, baselineBytes, limitBytes, withinBudget: actualBytes <= limitBytes };
}
