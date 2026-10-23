import type { CadReferenceGeometryBudget, CadReferenceParseResult } from './cadReferenceCore';

export type CadReferenceDxfWorkerRequest = {
  id: string;
  sourceUrl: string;
  /** 仅保留旧消息类型兼容，新流式路径使用几何字节预算。 */
  geometryBudget?: CadReferenceGeometryBudget;
  maxGeometryBytes?: number;
  unitScaleToMeters?: number;
};

export type CadReferenceDxfWorkerProgressMessage = {
  id: string;
  type: 'progress';
  percent: number;
  detail: string;
};

export type CadReferenceDxfWorkerDoneMessage = {
  id: string;
  type: 'done';
  result: CadReferenceParseResult;
};

export type CadReferenceDxfWorkerErrorMessage = {
  id: string;
  type: 'error';
  message: string;
};

export type CadReferenceDxfWorkerMessage =
  | CadReferenceDxfWorkerProgressMessage
  | CadReferenceDxfWorkerDoneMessage
  | CadReferenceDxfWorkerErrorMessage;
