import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = path.join(projectRoot, 'docs', 'releases');
const dryRun = process.argv.includes('--dry-run');

/** 提交类型到 release note 分组；未识别的前缀归入“其它”。 */
const RELEASE_NOTE_GROUPS = [
  { title: '新功能', types: ['feat'] },
  { title: '修复', types: ['fix'] },
  { title: '性能优化', types: ['perf'] },
  { title: '重构', types: ['refactor'] },
  { title: '文档', types: ['docs'] },
  { title: '测试', types: ['test'] },
  { title: '构建与杂项', types: ['chore', 'ci', 'build', 'style'] },
  { title: '其它', types: ['__other__'] },
];

function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

/** 读取 package.json 版本号；打包与版本 tag 均以它为准。 */
function readPackageVersion() {
  return JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

/** 取版本号最大的 v* tag；仓库尚无 tag 时返回 null。 */
function readLatestReleaseTag() {
  const output = git(['tag', '--list', 'v*', '--sort=-v:refname']);
  return output.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

/** 按区间取非合并提交，并从 `<type>(scope): 描述` 中拆出类型与描述。 */
function readCommits(range) {
  const output = git(['log', '--no-merges', '--pretty=format:%h%x09%s', range]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [hash, subject = ''] = line.split('\t');
    const match = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
    return {
      hash,
      subject,
      type: match ? match[1].toLowerCase() : '__other__',
      text: match ? match[2].trim() : subject,
    };
  });
}

/** 描述本次打包产物：存在同版本 NSIS 安装包时记安装包，否则是 pack:win 的免安装目录。 */
function formatArtifactLine(version) {
  const installer = `release/ZENDING-3D-EDITOR-Setup-${version}-x64.exe`;
  return existsSync(path.join(projectRoot, installer))
    ? `安装包：${installer}`
    : '打包产物：release/win-unpacked/（免安装目录，未生成 NSIS 安装包）';
}

/** 生成 release note：头部标注版本与提交区间，正文按提交类型分组。 */
function formatReleaseNote({ version, tag, previousTag, date, commits }) {
  const lines = [
    `# 版本 ${tag}`,
    '',
    `- 版本号：${version}`,
    `- 提交区间：${previousTag ? `${previousTag}..${tag}` : `首个提交..${tag}`}`,
    `- 发布日期：${date}`,
    `- ${formatArtifactLine(version)}`,
    '',
  ];

  for (const group of RELEASE_NOTE_GROUPS) {
    const items = commits.filter((commit) => group.types.includes(commit.type));
    if (items.length === 0) continue;
    lines.push(`## ${group.title}`, '');
    for (const item of items) lines.push(`- ${item.text}（${item.hash}）`);
    lines.push('');
  }

  if (commits.length === 0) lines.push('本区间没有代码提交。', '');
  return lines.join('\n');
}

const version = readPackageVersion();
const tag = `v${version}`;
const previousTag = readLatestReleaseTag();

if (previousTag === tag) {
  console.log(`${tag} 已存在，跳过打 tag 与 release note。`);
  process.exit(0);
}

const commits = readCommits(previousTag ? `${previousTag}..HEAD` : 'HEAD');
const notePath = path.join(notesDir, `${tag}.md`);
const noteContent = formatReleaseNote({
  version,
  tag,
  previousTag,
  date: new Date().toLocaleDateString('sv-SE'),
  commits,
});

if (dryRun) {
  console.log(`[dry-run] 将写入 ${path.relative(projectRoot, notePath)}，并执行 git tag -a ${tag} -m "Release ${tag}"：`);
  console.log('');
  console.log(noteContent);
  process.exit(0);
}

// 未提交改动会进入安装包却不属于 tag 指向的提交，提醒但不阻断打包结果
if (git(['status', '--porcelain']).trim()) {
  console.warn('警告：工作区存在未提交改动，安装包内容包含这些改动，但 tag 指向当前提交。建议提交后再打包。');
}

mkdirSync(notesDir, { recursive: true });
writeFileSync(notePath, noteContent, 'utf8');
git(['tag', '-a', tag, '-m', `Release ${tag}`]);

console.log(`已打 tag ${tag}（指向 ${git(['rev-parse', '--short', 'HEAD']).trim()}）`);
console.log(`release note：${path.relative(projectRoot, notePath)}（请随版本一起提交）`);
