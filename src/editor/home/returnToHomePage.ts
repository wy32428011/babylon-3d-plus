/** 编辑器返回首页时共用的文案和忙碌拦截。 */

export type ReturnToHomePageBlockers = {
  scenePreparationActive?: boolean;
  publishActive?: boolean;
  deploymentExportBusy?: boolean;
  cadImportActive?: boolean;
};

export const RETURN_TO_HOME_PAGE_LABEL = '返回首页';

export const RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM =
  '当前场景有未保存修改。返回首页会丢失这些修改，是否继续？';

/** 返回应阻止离开编辑器的原因；无阻塞时返回 null。 */
export function getReturnToHomePageBlockMessage(
  blockers: ReturnToHomePageBlockers,
): string | null {
  if (blockers.scenePreparationActive) {
    return '请等待场景准备完成后再返回首页。';
  }

  if (blockers.publishActive) {
    return '数字孪生发布正在进行，完成或取消发布后才能返回首页。';
  }

  if (blockers.deploymentExportBusy) {
    return '请等待部署工程导出完成后再返回首页。';
  }

  if (blockers.cadImportActive) {
    return '请等待 CAD 导入完成后再返回首页。';
  }

  return null;
}
