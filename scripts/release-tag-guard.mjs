import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取 package.json 版本号；打包与版本 tag 均以它为准。 */
function readPackageVersion() {
  return JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

/** 取版本号最大的 v* tag；仓库尚无 tag 时返回 null。 */
function readLatestReleaseTag() {
  const output = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return output.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

/** 同版本号下再次打包前询问用户；非交互环境直接中止，避免产物与上一版本混淆却无 tag 可辨。 */
async function confirmRepackage(version, tag) {
  if (!process.stdin.isTTY) {
    console.error(
      `版本号 ${version} 与上一版本 tag ${tag} 相同，当前环境无法交互确认，已中止打包。请先更新 package.json 版本号。`,
    );
    process.exit(1);
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => readline.question(
    `版本号 ${version} 与上一版本 tag ${tag} 相同。仍要继续打包？本次不会打 tag、不会生成 release note。(y/N) `,
    resolve,
  ));
  readline.close();

  if (/^y(es)?$/i.test(answer.trim())) return;

  console.log('已取消打包。请更新 package.json 版本号后重试。');
  process.exit(1);
}

// 免安装目录（pack:win）只是验证产物，不产生版本发布点，因此只报告版本状态、不做交互确认
const checkOnly = process.argv.includes('--check-only');
const version = readPackageVersion();
const latestTag = readLatestReleaseTag();
const previous = latestTag ? `上一版本 ${latestTag}` : '仓库尚无版本 tag';

if (checkOnly) {
  console.log(
    `验证打包：版本 ${version}（${previous}），本次不打 tag、不写 release note；正式发布请用 npm run dist:win。`,
  );
} else if (latestTag === `v${version}`) {
  await confirmRepackage(version, latestTag);
  console.log(`继续打包：${latestTag} 已存在，本次跳过打 tag 与 release note。`);
} else {
  console.log(`打包版本 ${version}，${previous}；完成后将打 tag v${version} 并生成 release note。`);
}
