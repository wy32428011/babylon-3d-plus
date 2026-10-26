import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { giArtifactSha, insideGiRoot, verifyGiSourceReadback } from '../tests/helpers/phase2GiArtifacts.mjs';
import { openGiArtifactReader } from '../tests/helpers/phase2GiArchiveReader.mjs';
import { verifyBusinessGiViewer } from '../tests/helpers/phase2GiViewer.mjs';

assert.equal(process.argv.length, 4, '用法：node scripts/phase2-gi-verify-existing.mjs <真实完成烘焙及打包的report.json> <新输出目录>');
const originalReportPath = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]), outputBase = path.resolve('output');
assert.ok(output !== outputBase && insideGiRoot(outputBase, output));
const previous = JSON.parse(await fs.readFile(originalReportPath, 'utf8'));
assert.ok(previous.snapshot?.surfaces.length && previous.packages?.source && previous.packages?.dist, '必须复用真实成功的烘焙及正式包，不能虚构snapshot');
await fs.mkdir(output);
const report = { status: 'RUNNING', scope: 'read-only SOURCE/DIST/Viewer verification of existing real business GI outputs; no new bake',
  originalReportPath, originalReportStatus: previous.status, output, workloadClass: previous.workloadClass,
  snapshot: previous.snapshot, packages: previous.packages, sourceInputReportSha256: giArtifactSha(await fs.readFile(originalReportPath)) };
try {
  for (const artifact of Object.values(previous.packages)) assert.equal(giArtifactSha(await fs.readFile(artifact.filePath)), artifact.sha256);
  const saved = JSON.parse(await fs.readFile(previous.preparation.scenePath, 'utf8')).scene;
  const sourceReader = await openGiArtifactReader(previous.packages.source.filePath), distReader = await openGiArtifactReader(previous.packages.dist.filePath);
  report.sourceArchive = { reader: 'zip-without-extra-extraction', entries: sourceReader.archiveEntries, unpackedBytes: sourceReader.unpackedBytes };
  report.distArchive = { reader: 'zip-without-extra-extraction', entries: distReader.archiveEntries, unpackedBytes: distReader.unpackedBytes };
  report.sourceReadback = await verifyGiSourceReadback({ root: previous.packages.source.filePath, entryScenePath: previous.packages.source.entryScenePath,
    expectedSnapshot: previous.snapshot, expectedScene: saved });
  report.viewer = await verifyBusinessGiViewer({ root: previous.packages.dist.filePath, snapshot: previous.snapshot, expectedScene: saved, output, projectId: '9000000000000000001' });
  assert.equal(giArtifactSha(await fs.readFile(originalReportPath)), report.sourceInputReportSha256, '不得改写原失败报告');
  report.status = 'PASS_EXISTING_BAKE_PORTABLE_VIEWER';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
