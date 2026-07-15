import type { CadReferenceGeometryBudget, CadReferenceParseResult } from './cadReference';

export type CadReferenceDxfWorkerRequest = {
  id: string;
  sourceUrl: string;
  geometryBudget: CadReferenceGeometryBudget;
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
