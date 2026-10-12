import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 推算试打包版本：在 package.json 版本基础上 +1 patch 并加 -alpha 后缀（0.3.41 → 0.3.42-alpha）。
 * 不改 package.json，文件名字末尾带该版本；需要指定时用 APP_VERSION 环境变量覆盖。
 */
function deriveAlphaVersion(baseVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(baseVersion);
  if (!match) throw new Error(`无法从 package.json 版本“${baseVersion}”推算试打包版本。`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-alpha`;
}

const baseVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
const version = (process.env.APP_VERSION ?? '').trim() || deriveAlphaVersion(baseVersion);

console.log(`试打包 ${version}（由 ${baseVersion} 推算；不打 tag、不写 release note）`);

// VITE_APP_VERSION 让渲染端首页显示该版本，而无需改动 package.json 的 version 字段。
const env = { ...process.env, VITE_APP_VERSION: version };
execSync('npm run build', { cwd: projectRoot, stdio: 'inherit', env });

// extraMetadata.version 覆盖 electron-builder 从 package.json 读取的版本，产物名随之变为 ...-<version>-x64.exe。
const electronBuilder = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
execFileSync(electronBuilder, ['--win', 'nsis', '--x64', `--config.extraMetadata.version=${version}`], {
  cwd: projectRoot,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

console.log(`试打包完成：release/ZENDING-3D-EDITOR-Setup-${version}-x64.exe`);
