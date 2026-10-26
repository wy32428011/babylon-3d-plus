import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createLightingBakeTask, cleanupLightingBakeTasks, getLightingBakeTaskHistory } from '../../electron/ipc/lightingBakeTaskHistory.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-gamma-task-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^phase2-gamma-task-/); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
const makeTask = (root, id) => createLightingBakeTask(root, { jobId: id, sceneName: 'Gamma task regression', signature: 'fixture-signature' }, 'fixture-engine', { signature: 'fixture-signature', issues: [] });

test('真实服务spawn环境只抑制自有Python字节码；真实helper import不生成目录', async t => {
  const root = await fixture(t), source = await fs.readFile(new URL('../../electron/ipc/lightingBakeService.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('lightingBakeService.ts', source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runLightingBakeProcess');
  assert.ok(fn);
  let call;
  const visit = node => { if (ts.isCallExpression(node) && node.expression.getText(tree) === 'spawn') call = node; ts.forEachChild(node, visit); }; visit(fn);
  assert.ok(call);
  const original = process.env.PYTHONDONTWRITEBYTECODE;
  const actualOptions = runInNewContext('(' + call.arguments[2].getText(tree) + ')', { directory: root, process: { env: process.env } });
  assert.equal(actualOptions.env.PYTHONDONTWRITEBYTECODE, '1'); assert.equal(process.env.PYTHONDONTWRITEBYTECODE, original);
  const target = path.join(root, 'rgbm_gamma_codec.py'); await fs.copyFile(fileURLToPath(new URL('../../electron/lighting-bake/rgbm_gamma_codec.py', import.meta.url)), target);
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', ['-c', "import importlib.util,sys,numpy as np; s=importlib.util.spec_from_file_location('codec',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);assert m.encode_rgbm_gamma_pixels(np.array([1,4,.25,1],dtype=np.float32))[0]==4", target], { ...actualOptions, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readdir(root), ['rgbm_gamma_codec.py']);
});

test('忽略PYTHON环境时，真实save_rgbm显式Gamma导入仍不产pyc且恢复解释器状态', async t => {
  const root = await fixture(t);
  await fs.copyFile(fileURLToPath(new URL('../../electron/lighting-bake/rgbm_gamma_codec.py', import.meta.url)), path.join(root, 'rgbm_gamma_codec.py'));
  const program = String.raw`
import ast,sys,types,numpy as np
from pathlib import Path
assert sys.flags.ignore_environment==1 and not sys.dont_write_bytecode
source=Path(sys.argv[1]).read_text(encoding='utf-8'); tree=ast.parse(source)
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='save_rgbm')
image=types.SimpleNamespace(colorspace_settings=types.SimpleNamespace(name=''),pixels=types.SimpleNamespace(foreach_set=lambda value:None),save=lambda:None)
bpy=types.SimpleNamespace(data=types.SimpleNamespace(images=types.SimpleNamespace(new=lambda *args,**kwargs:image,remove=lambda image:None)))
namespace={'np':np,'Path':Path,'sys':sys,'bpy':bpy,'__file__':str(Path(sys.argv[2])/'cycles_bake.py')}
exec(compile(ast.Module(body=[function],type_ignores=[]),'actual-save-rgbm','exec'),namespace)
assert namespace['save_rgbm'](np.array([1,4,.25,1],dtype=np.float32),1,Path(sys.argv[2])/'fixture.png','rgbm-gamma')==4
assert not sys.dont_write_bytecode
assert sorted(path.name for path in Path(sys.argv[2]).iterdir())==['rgbm_gamma_codec.py']
`;
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', ['-E', '-c', program,
    fileURLToPath(new URL('../../electron/lighting-bake/cycles_bake.py', import.meta.url)), root], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});

test('精确受控helper和probe-batches不阻止success/error finish及安全清理', async t => {
  const root = await fixture(t);
  for (const status of ['completed', 'error']) {
    const task = await makeTask(root, 'gamma-' + status);
    await fs.writeFile(path.join(task.directory, 'rgbm_gamma_codec.py'), '# owned codec helper fixture');
    await fs.writeFile(path.join(task.directory, 'probe-batches.json'), '{}');
    await task.finish(status, 'explicit ' + status, 0);
    const history = await getLightingBakeTaskHistory(root);
    assert.equal(history.tasks.find(row => row.taskId === task.record.taskId).status, status);
    const cleaned = await cleanupLightingBakeTasks(root, [task.record.taskId]);
    assert.deepEqual(cleaned.removedTaskIds, [task.record.taskId]);
  }
});

test('未知目录仍使success/error finish失败，未知py/目录均不得安全清理', async t => {
  const root = await fixture(t), directoryTask = await makeTask(root, 'gamma-unknown-directory');
  await fs.mkdir(path.join(directoryTask.directory, '__pycache__'));
  await assert.rejects(directoryTask.finish('completed', 'must refuse'), /非普通文件/);
  await assert.rejects(directoryTask.finish('error', 'must still refuse'), /非普通文件/);
  await directoryTask.update({ status: 'error', phase: 'error' });
  await assert.rejects(cleanupLightingBakeTasks(root, [directoryTask.record.taskId]), /非普通文件/);
  assert.equal((await fs.lstat(path.join(directoryTask.directory, '__pycache__'))).isDirectory(), true);
  const fileTask = await makeTask(root, 'gamma-unknown-python');
  await fs.writeFile(path.join(fileTask.directory, 'unknown-helper.py'), '# not an authorized cleanup name');
  await fileTask.finish('error', 'flat record remains inspectable');
  await assert.rejects(cleanupLightingBakeTasks(root, [fileTask.record.taskId]), /未知文件/);
  assert.ok(await fs.readFile(path.join(fileTask.directory, 'unknown-helper.py')));
});
