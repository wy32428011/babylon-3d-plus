import { parentPort, workerData } from 'node:worker_threads';
import { inspectSourceModelDensityLocal } from './modelPackageScanner.js';

type Input = { modelFilePath: string; unitScaleToMeters: number; sourceScripted: boolean };
const input = workerData as Input;
try {
  const result = await inspectSourceModelDensityLocal(input.modelFilePath, input.unitScaleToMeters, input.sourceScripted);
  parentPort?.postMessage({ ok: true, result });
} catch {
  parentPort?.postMessage({ ok: false });
} finally {
  parentPort?.close();
}
