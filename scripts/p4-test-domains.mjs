import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './test-groups.mjs';
import { auditClassification, contractDomains, selectDomainContracts } from './p4-test-classification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = JSON.parse(readFileSync(path.join(root, 'scripts/test-entry-classification.json'), 'utf8'));
const [domain, ...flags] = process.argv.slice(2);
try {
  if (!contractDomains.includes(domain) || flags.some(flag => flag !== '--list')) throw new Error('用法：p4-test-domains.mjs [' + contractDomains.join('|') + '] [--list]');
  auditClassification(registry, registry.entries.map(entry => ({ file: entry.file, support: false, entries: new Set() })), file => readFileSync(path.join(root, file), 'utf8'));
  const commands = selectDomainContracts(registry, domain);
  if (flags.includes('--list')) console.log(JSON.stringify({ domain, commands, evidence: '仅枚举，不执行测试，不表示通过' }, null, 2));
  else {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      for (const command of commands) {
        // 注册表只接受明确的 Node 文件命令；不通过 shell 解释，也不执行手动/GPU 分类。
        const match = /^node (?:--experimental-transform-types )?(?:(--test --test-concurrency=1) )?((?:tests|scripts)\/[\w/.-]+\.(?:ts|mjs|js))$/.exec(command);
        if (!match) throw new Error('领域入口不支持的命令：' + command);
        const args = ['--experimental-transform-types', ...(match[1] ? ['--test', '--test-concurrency=1'] : []), match[2]];
        console.log('[contract:' + domain + '] ' + match[2]);
        await runCommand(process.execPath, args, { cwd: root, signal: abort.signal });
      }
      console.log(JSON.stringify({ domain, commandsCompleted: commands.length, status: 'passed' }));
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
