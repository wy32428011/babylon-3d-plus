import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INPUT = path.join('Assets', 'Environments', '厂区环境模型_Optimized', '厂区环境模型_Optimized.glb');
const DEFAULT_OUTPUT_DIR = path.join('Assets', 'Environments', '厂区环境模型_Optimized');
const DEFAULT_OUTPUT_NAME = '厂区环境模型_Optimized.ktx2.glb';

/**
 * 用 glTF-Transform 把环境 GLB 的 PNG 转成 KTX2/UASTC，保留 Draco 几何。
 * 这是打开场景后环境加载变慢的主要资产侧修复，不改运行时加载器。
 */
async function main() {
  const input = path.resolve(process.argv[2] ?? DEFAULT_INPUT);
  const output = path.resolve(
    process.argv[3] ?? path.join(DEFAULT_OUTPUT_DIR, DEFAULT_OUTPUT_NAME),
  );
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`找不到环境 GLB：${input}`);
  await mkdir(path.dirname(output), { recursive: true });

  const args = [
    '--yes',
    '@gltf-transform/cli',
    'uastc',
    input,
    output,
    '--level',
    '2',
    '--rdo',
    '--rdo-lambda',
    '1.0',
    '--slots',
    'baseColor',
  ];
  console.log(`[optimize-environment-glb] 输入 ${formatMegabytes(inputStat.size)}：${input}`);
  console.log('[optimize-environment-glb] 执行 npx @gltf-transform/cli uastc ...');
  await runCommand('npx', args);
  const outputStat = await stat(output);
  console.log(`[optimize-environment-glb] 输出 ${formatMegabytes(outputStat.size)}：${output}`);
  console.log('[optimize-environment-glb] 完成后把环境库该文件替换为输出，或在 Inspector 重新导入该 GLB。');
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`环境 GLB 优化失败，退出码 ${code}。`));
    });
  });
}

void main().catch((error) => {
  console.error('[optimize-environment-glb] 失败：', error instanceof Error ? error.message : error);
  console.error('可手动执行：npx --yes @gltf-transform/cli uastc <输入.glb> <输出.glb>');
  process.exitCode = 1;
});
