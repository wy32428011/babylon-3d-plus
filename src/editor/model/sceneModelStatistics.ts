/** 当前场景的模型三角面统计；仅用于界面，不进入场景文档与撤销历史。 */
export type SceneModelStatisticsSnapshot = {
  sceneId: string | null;
  phase: 'loading' | 'ready' | 'error';
  modelTriangleCount: number;
  environmentTriangleCount: number;
};
