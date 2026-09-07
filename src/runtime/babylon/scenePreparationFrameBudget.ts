/** 蒙版期间保留5次/秒的完整渲染，避免后台场景持续占满加载所需的主线程。 */
export class ScenePreparationFrameBudget {
  private lastRenderedAt = -Infinity;

  shouldRender(preparing: boolean, now: number): boolean {
    if (preparing && now - this.lastRenderedAt < 200) return false;
    this.lastRenderedAt = now;
    return true;
  }
}
