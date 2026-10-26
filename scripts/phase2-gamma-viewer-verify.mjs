import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyBusinessGiViewer } from '../tests/helpers/phase2GiViewer.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--report') options.report = process.argv[++index];
  else if (process.argv[index] === '--output') options.output = process.argv[++index];
  else throw new Error('未知Viewer-only参数：' + process.argv[index]);
}
assert.ok(options.report && options.output);
const output = path.resolve(options.output); assert.ok(output.startsWith(path.resolve('output') + path.sep)); await fs.mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptBytes = await fs.readFile(options.report), receipt = JSON.parse(receiptBytes.toString('utf8'));
const original = JSON.parse(await fs.readFile(receipt.previousReport, 'utf8'));
const sceneBytes = await fs.readFile(receipt.savedScenePath), saved = JSON.parse(sceneBytes.toString('utf8'));
const archive = receipt.packages.dist.filePath, archiveHash = sha(await fs.readFile(archive));
assert.equal(archiveHash, receipt.packages.dist.sha256); assert.equal(sha(sceneBytes), receipt.savedSceneSha256);
const product = Object.entries(receipt.sourceHashes).filter(([file]) => file.startsWith('src/'));
for (const [file, expected] of product) assert.equal(sha(await fs.readFile(file)), expected, '不能把不同产品源版本混入同包验收');
for (const [file, expected] of Object.entries(receipt.buildHashes)) assert.equal(sha(await fs.readFile(file)), expected);
const report = { status: 'RUNNING', scope: 'same exact already-packaged fixed-3 DIST; new standalone/iframe Chrome only; no packager/bake/product change',
  sourceReceipt: path.resolve(options.report), sourceReceiptSha256: sha(receiptBytes), archive, archiveSha256: archiveHash,
  sceneSha256: sha(sceneBytes), productHashes: Object.fromEntries(product), buildHashes: receipt.buildHashes,
  toolShaderReadback: 'verified Babylon 9.12 Effect.fragmentSourceCode getter; previous guessed method failure retained',
  helperSha256: sha(await fs.readFile('tests/helpers/phase2GiViewer.mjs')) };
try {
  report.viewer = await verifyBusinessGiViewer({ root: archive, snapshot: original.snapshot, expectedScene: saved.scene, output,
    projectId: '9000000000000000001', gamma: true, iframe: true });
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  report.archiveUnchanged = sha(await fs.readFile(archive)) === archiveHash;
  report.savedSceneUnchanged = sha(await fs.readFile(receipt.savedScenePath)) === report.sceneSha256;
  report.productVersionsStable = (await Promise.all(product.map(async ([file, expected]) => sha(await fs.readFile(file)) === expected))).every(Boolean);
  report.bakedAssetsUnchanged = true;
  for (const asset of original.snapshot.assets) if (sha(await fs.readFile(decodeURIComponent(new URL(asset.url).pathname.slice(1)))) !== asset.sha256) report.bakedAssetsUnchanged = false;
  if (![report.archiveUnchanged, report.savedSceneUnchanged, report.productVersionsStable, report.bakedAssetsUnchanged].every(Boolean)) { report.status = 'FAIL'; process.exitCode = 1; }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
