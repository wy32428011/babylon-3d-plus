import { createHash } from 'node:crypto';

export const contractDomains = ['editor', 'effects', 'motion', 'observability', 'opening', 'resources'];
const dispositions = new Set(['node-contract', 'browser-webgl', 'performance', 'asset-required', 'electron-integration', 'metadata', 'tooling', 'blender']);

// 分类登记保留源码摘要，防止文件内容变化后继续沿用未经复核的运行方式或前置条件。
export function auditClassification(registry, rows, readSource) {
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.entries)) throw new Error('测试分类注册表版本或结构无效');
  const candidates = new Map(rows.map(row => [row.file, row]));
  const entries = new Map();
  for (const entry of registry.entries) {
    if (!entry || typeof entry.file !== 'string' || !/^(?:tests|scripts)\/[\w/.-]+\.(?:ts|tsx|mjs|js|json|py)$/.test(entry.file) || entry.file.split('/').includes('..') || !candidates.has(entry.file)) throw new Error('分类文件不在当前候选清单：' + entry?.file);
    if (entries.has(entry.file)) throw new Error('测试分类重复：' + entry.file);
    if (!dispositions.has(entry.disposition)) throw new Error('未知测试分类：' + entry.file);
    if (entry.disposition === 'node-contract' ? !contractDomains.includes(entry.domain) : entry.domain !== null) throw new Error('测试领域与分类不一致：' + entry.file);
    if (typeof entry.command !== 'string' || !entry.command.trim() || typeof entry.purpose !== 'string' || !entry.purpose.trim() || !Array.isArray(entry.prerequisites) || !entry.prerequisites.length || !entry.prerequisites.every(item => typeof item === 'string' && item.trim()) || !Array.isArray(entry.evidence) || !entry.evidence.length) throw new Error('测试分类缺少命令、用途、条件或源码证据：' + entry.file);
    const source = readSource(entry.file).replaceAll('\r\n', '\n');
    if (createHash('sha256').update(source).digest('hex') !== entry.sha256) throw new Error('测试分类源码已漂移，需复核后更新摘要：' + entry.file);
    const lines = source.split('\n');
    if (!entry.evidence.every(item => item && Number.isInteger(item.line) && item.line >= 1 && typeof item.text === 'string' && item.text.trim() && lines[item.line - 1]?.trim() === item.text)) throw new Error('测试分类源码证据已漂移：' + entry.file);
    entries.set(entry.file, entry);
  }
  const unresolved = rows.filter(row => !row.support && !row.entries.size && !entries.has(row.file));
  if (unresolved.length) throw new Error('发现未分类且无静态入口的测试候选：' + unresolved.map(row => row.file).join(', '));
  return { entries, reviewed: entries.size, unresolved: unresolved.length };
}

export function selectDomainContracts(registry, domain) {
  if (!contractDomains.includes(domain)) throw new Error('未知测试领域：' + domain);
  // runner 和其目标可以共用同一原命令；只执行一次，仍保留各文件的登记关系。
  return [...new Set(registry.entries.filter(entry => entry.disposition === 'node-contract' && entry.domain === domain).map(entry => entry.command.replace(/^node --experimental-transform-types /, 'node ')))];
}
