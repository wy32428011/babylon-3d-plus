import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { inspectGlbModelFile } from './modelPackageScanner.js';
export type EnvironmentValidationWorkerInput = { filePath: string };

async function validate(): Promise<void> {
  const filePath = (workerData as EnvironmentValidationWorkerInput).filePath;
  try {
    const inspection = await inspectGlbModelFile(filePath);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
    parentPort?.postMessage({ ok: true, result: { ...inspection, fileSha256: hash.digest('hex') } });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    parentPort?.close();
  }
}

await validate();
