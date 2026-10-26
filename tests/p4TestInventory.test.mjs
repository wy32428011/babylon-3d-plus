import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditClassification, selectDomainContracts } from '../scripts/p4-test-classification.mjs';

const source = "import test from 'node:test';\ntest('contract', () => {});\n";
const fixture = () => ({ schemaVersion: 1, entries: [{ file: 'tests/example.test.mjs', sha256: createHash('sha256').update(source).digest('hex'), disposition: 'node-contract', domain: 'editor', command: 'node --experimental-transform-types --test --test-concurrency=1 tests/example.test.mjs', purpose: '契约', prerequisites: ['独立进程'], evidence: [{ line: 1, text: "import test from 'node:test';" }] }] });
const rows = () => [{ file: 'tests/example.test.mjs', support: false, entries: new Set() }];

test('分类与执行证据分离，完整登记允许尚未执行并接受 CRLF 检出', () => {
  const result = auditClassification(fixture(), rows(), () => source.replaceAll('\n', '\r\n'));
  assert.equal(result.reviewed, 1); assert.equal(result.unresolved, 0);
  assert.equal('passed' in result, false);
});

test('新增未分类测试和移除文件会阻断，不能用既有登记掩盖发现范围变化', () => {
  assert.throws(() => auditClassification(fixture(), [...rows(), { file: 'tests/new.test.mjs', support: false, entries: new Set() }], () => source), /未分类/);
  assert.throws(() => auditClassification(fixture(), [], () => source), /不在当前候选/);
  assert.doesNotThrow(() => auditClassification({ schemaVersion: 1, entries: [] }, [{ file: 'tests/old.test.mjs', support: false, entries: new Set(['test:old']) }], () => source));
});

test('源码、证据、重复、领域和逃逸路径漂移均不能静默通过', () => {
  assert.throws(() => auditClassification(fixture(), rows(), () => source + '// changed'), /源码已漂移/);
  const evidence = fixture(); evidence.entries[0].evidence[0].line = 2;
  assert.throws(() => auditClassification(evidence, rows(), () => source), /证据已漂移/);
  const emptyEvidence = fixture(); emptyEvidence.entries[0].evidence = [{ line: 0 }];
  assert.throws(() => auditClassification(emptyEvidence, rows(), () => source), /证据已漂移/);
  const invalidCommand = fixture(); invalidCommand.entries[0].command = {};
  assert.throws(() => auditClassification(invalidCommand, rows(), () => source), /缺少命令/);
  const duplicate = fixture(); duplicate.entries.push({ ...duplicate.entries[0] });
  assert.throws(() => auditClassification(duplicate, rows(), () => source), /重复/);
  const domain = fixture(); domain.entries[0].domain = 'unknown';
  assert.throws(() => auditClassification(domain, rows(), () => source), /领域与分类不一致/);
  const traversal = fixture(); traversal.entries[0].file = 'tests/../outside.test.mjs';
  assert.throws(() => auditClassification(traversal, [{ ...rows()[0], file: traversal.entries[0].file }], () => source), /不在当前候选/);
});

test('领域执行保留独立 Node 命令、去重 runner 目标，手动 GPU 条目不会混入', () => {
  const registry = fixture();
  registry.entries.push({ ...registry.entries[0], file: 'tests/second.test.mjs', command: registry.entries[0].command.replace('node --experimental-transform-types ', 'node ') });
  registry.entries.push({ ...registry.entries[0], file: 'tests/manual.webgl.mjs', disposition: 'browser-webgl', domain: null, command: 'node tests/manual.webgl.mjs' });
  assert.deepEqual(selectDomainContracts(registry, 'editor'), ['node --test --test-concurrency=1 tests/example.test.mjs']);
  assert.throws(() => selectDomainContracts(registry, 'unknown'), /未知测试领域/);
});

test('原始 301 候选逐文件保留，不退役；手动项均有条件和源码证据', () => {
  const registry = JSON.parse(readFileSync(new URL('../scripts/test-entry-classification.json', import.meta.url), 'utf8'));
  assert.equal(registry.reviewedBaseline.originalUnconfirmed, 301);
  // 登记表只增不减：原始 301 候选是下限，后续新增的候选须同样逐文件登记。
  const total = registry.entries.length;
  assert.ok(total >= registry.reviewedBaseline.originalUnconfirmed);
  assert.equal(new Set(registry.entries.map(entry => entry.file)).size, total);
  assert.ok(registry.entries.every(entry => entry.command && entry.prerequisites.length && entry.evidence.length));
  assert.ok(registry.entries.filter(entry => entry.disposition !== 'node-contract').every(entry => entry.domain === null));
  const audit = auditClassification(registry, registry.entries.map(entry => ({ file: entry.file, support: false, entries: new Set() })), file => readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  assert.equal(audit.reviewed, total);
  assert.equal(audit.unresolved, 0);
});
