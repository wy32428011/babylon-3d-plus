import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bindReceiverRoiDocument, encodeReceiverRoiJson, prepareReceiverRoiProject, readReceiverRoiPlan,
  receiverRoiBudgetEvidence, roiSha, verifyAppliedReceiverRoi, assertReceiverRoiVersionLock,
  readReceiverRoiReceipt, readReceiverRoiObservation } from '../tests/lightingBake/phase2GiReceiverRoi.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, plan: { type: 'string' }, preparation: { type: 'string' }, binding: { type: 'string' },
  observation: { type: 'string' }, budgets: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('prepare --source <original.scene.json> --plan <frozen-plan.json> --output <new-output-dir>\n'
    + 'bind --preparation <roi-preparation.json> --observation <actual-editor-classification.json> --output <new-evidence-dir>\n'
    + 'validate --binding <roi-binding.json> --observation <fresh-applied-editor-classification.json> [--budgets <actual-metrics.json>] --output <new-evidence-dir>\n'
    + 'No command launches Editor/Blender/network or bakes. Unbound and bound scene documents remain bake.enabled=false.');
  process.exit(0);
}
const inside = (root, file) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function read(file) { const stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 ** 2); const bytes = await fs.readFile(file); return { value: JSON.parse(bytes.toString('utf8')), sha256: roiSha(bytes) }; }
async function verifyScene(file, expectedSha, project, environmentSha) {
  assert.ok(inside(project, file) && inside(path.resolve('output'), project));
  const current = await read(file); assert.equal(current.sha256, expectedSha, '已冻结ROI文档变化');
  const url = current.value.scene.sceneSettings.environment.activeVariantUrl;
  assert.ok(url.startsWith('editor-asset://local/'));
  const asset = decodeURIComponent(new URL(url).pathname.slice(1)), real = await fs.realpath(asset), stat = await fs.lstat(asset);
  assert.ok(inside(await fs.realpath(project), real) && stat.isFile() && !stat.isSymbolicLink());
  const hash = createHash('sha256'); for await (const chunk of createReadStream(real)) hash.update(chunk);
  assert.equal(hash.digest('hex'), environmentSha, '真实copied GLB必须仍是原始字节');
  return current.value;
}
assert.ok(values.output && positionals.length === 1);
const command = positionals[0], output = path.resolve(values.output);
assert.ok(inside(path.resolve('output'), output));
if (command === 'prepare') {
  assert.ok(values.source && values.plan);
  const prepared = await prepareReceiverRoiProject({ sourceScene: values.source, planFile: values.plan, output });
  console.log(JSON.stringify({ status: prepared.status, scenePath: prepared.scenePath, receipt: path.join(output, 'roi-preparation.json'),
    sourceSceneSha256: prepared.sourceSceneSha256, environmentSha256: prepared.environmentSha256, bakeAllowed: false }));
} else if (command === 'bind') {
  assert.ok(values.preparation && values.observation);
  const preparedFile = await read(values.preparation), prepared = preparedFile.value;
  assert.equal(prepared.status, 'PREPARED_RESOURCE_IDENTITY_UNBOUND_BAKE_DISABLED');
  const planFile = path.join(path.dirname(path.resolve(values.preparation)), 'roi-plan-frozen.json'), bundle = await readReceiverRoiPlan(planFile);
  assert.equal(bundle.planSha256, prepared.planSha256); assert.deepEqual(bundle.evidenceSha256, prepared.evidenceSha256);
  const document = await verifyScene(prepared.scenePath, prepared.sceneSha256, prepared.project, prepared.environmentSha256);
  const observation = await readReceiverRoiObservation(values.observation), bound = bindReceiverRoiDocument(document, bundle, observation.value, prepared);
  assertReceiverRoiVersionLock(observation.value.versionLock, observation.value.versionLock);
  await fs.mkdir(output, { recursive: false });
  const scenePath = path.join(prepared.project, 'Scenes', 'receiver-roi-bound-' + roiSha(observation.value.captureId).slice(0, 12) + '.scene.json');
  const bytes = encodeReceiverRoiJson(bound.document); await fs.writeFile(scenePath, bytes, { flag: 'wx' });
  const receipt = { ...prepared, status: bound.binding.status, scenePath, sceneSha256: roiSha(bytes), planFile,
    preparationFile: path.resolve(values.preparation), preparationSha256: preparedFile.sha256,
    binding: bound.binding, policySha256: roiSha(encodeReceiverRoiJson(bound.document.scene.sceneSettings.lighting.policy)),
    versionLock: observation.value.versionLock,
    observationFile: path.resolve(values.observation), observationSha256: observation.sha256, bakeAllowed: false };
  await fs.writeFile(path.join(output, 'roi-binding.json'), encodeReceiverRoiJson(receipt), { flag: 'wx' });
  console.log(JSON.stringify({ status: receipt.status, scenePath, receipt: path.join(output, 'roi-binding.json'), bakeAllowed: false }));
} else if (command === 'validate') {
  assert.ok(values.binding && values.observation);
  const chain = await readReceiverRoiReceipt(values.binding), bound = chain.receipt, bundle = chain.bundle;
  assert.equal(chain.mode, 'observe-bound');
  assert.equal(bound.planSha256, bundle.planSha256); assert.deepEqual(bound.evidenceSha256, bundle.evidenceSha256);
  const document = await verifyScene(bound.scenePath, bound.sceneSha256, bound.project, bound.environmentSha256);
  const observation = await readReceiverRoiObservation(values.observation);
  assertReceiverRoiVersionLock(bound.versionLock, observation.value.versionLock);
  const runtime = verifyAppliedReceiverRoi(bundle, document, observation.value, bound, bound.binding);
  const budgets = receiverRoiBudgetEvidence(bundle, values.budgets ? (await read(values.budgets)).value : {});
  await fs.mkdir(output, { recursive: false });
  const report = { ...bound, status: runtime.status, bindingFile: path.resolve(values.binding), bindingSha256: chain.receiptSha256,
    observationFile: path.resolve(values.observation), observationSha256: observation.sha256, runtime, budgets, bakeAllowed: false,
    actualPredicateSkipCount: null, actualProbeCount: null, note: 'Actual fresh Capture/preflight/OS metrics and root scheduling still required; this tool does not bake.' };
  await fs.writeFile(path.join(output, 'roi-validation.json'), encodeReceiverRoiJson(report), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, scenePath: report.scenePath, receipt: path.join(output, 'roi-validation.json'),
    runtime, budgets, bakeAllowed: false }, null, 2));
} else throw new Error('只允许prepare/bind/validate，未提供bake命令。');
