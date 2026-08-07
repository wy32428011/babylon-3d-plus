import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(scriptDirectory, '..');
const viewerFixture = path.join(viewerRoot, 'tests', 'fixtures', 'digitalTwinInteraction.v1.json');
const candidatePlatformRoots = [
  process.env.CENTRAL_DATA_PLATFORM_ROOT,
  process.argv[2],
  path.resolve(viewerRoot, '..', 'CentralDataPlatform'),
  path.resolve(viewerRoot, '..', '..', 'projects', 'CentralDataPlatform'),
].filter(Boolean);

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

let platformFixture;
let platformFixturePath;
for (const root of candidatePlatformRoots) {
  const candidate = path.join(path.resolve(root), 'frontend', 'src', 'pages', 'BigscreenDesigner', 'fixtures', 'digitalTwinInteraction.v1.json');
  try {
    platformFixture = await readFile(candidate);
    platformFixturePath = candidate;
    break;
  } catch {
    // 继续尝试显式参数、环境变量和常见并列工作区位置。
  }
}

if (!platformFixture || !platformFixturePath) {
  throw new Error('未找到 CentralDataPlatform 合同夹具；请设置 CENTRAL_DATA_PLATFORM_ROOT 或传入仓库根目录。');
}

const viewerBytes = await readFile(viewerFixture);
const viewerHash = digest(viewerBytes);
const platformHash = digest(platformFixture);
if (viewerHash !== platformHash) {
  throw new Error([
    '数字孪生 Bridge v1 合同夹具不一致。',
    `Viewer: ${viewerFixture} (${viewerHash})`,
    `Host:   ${platformFixturePath} (${platformHash})`,
  ].join('\n'));
}

console.log(`digital twin interaction contract fixture matched: ${viewerHash}`);
