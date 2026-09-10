import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const method = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerEditorAssetProtocol')!;
const code = ts.transpileModule(method.getText(ast) + '\nregisterEditorAssetProtocol();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
async function run(codeName: string, authorized = true) {
  let handler: any;
  runInNewContext(code, { Response, protocol: { handle(_scheme: string, callback: any) { handler = callback; } },
    decodeAssetUrl: () => 'D:/missing/model.glb', isAuthorizedAssetFile: () => authorized,
    fs: { stat: async () => { throw Object.assign(new Error('internal absolute path'), { code: codeName }); } } });
  return handler({ url: 'editor-asset://local/model.glb', headers: new Headers() });
}
test('受控资源不存在返回404，避免变成无法定位的ERR_UNEXPECTED', async () => {
  for (const code of ['ENOENT', 'ENOTDIR']) { const response = await run(code); assert.equal(response.status, 404); assert.match(await response.text(), /不存在/); }
});
test('无权限返回403；未授权文件不会进入磁盘读取', async () => {
  assert.equal((await run('EACCES')).status, 403);
  assert.equal((await run('unexpected', false)).status, 403);
});
test('未知IO失败继续上报，不能伪装成文件不存在', async () => {
  await assert.rejects(run('EIO'), /internal absolute path/);
});
