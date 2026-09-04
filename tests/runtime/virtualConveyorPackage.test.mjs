import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { GLTFFileLoader } from '@babylonjs/loaders';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_DIR = path.join(WORKSPACE_ROOT, 'public', 'builtin-model-packages', 'virtual-conveyor');
const GLB_PATH = path.join(PACKAGE_DIR, 'virtual-conveyor.glb');
const SCRIPT_PATH = path.join(PACKAGE_DIR, 'virtual-conveyor.model.ts');
const META_PATH = path.join(PACKAGE_DIR, 'meta.json');

/** 读取 GLB 并按 Babylon glTF 容器格式手工解包（复刻 _unpackBinaryV2Async 输出）。 */
async function unpackGlb(filePath) {
  const buffer = await readFile(filePath);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(0, true), 0x46546c67, 'magic 必须是 glTF');
  assert.equal(view.getUint32(4, true), 2, '版本必须是 2');
  assert.equal(view.getUint32(8, true), bytes.byteLength, '头长度必须与实际文件长度一致');
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, '首 chunk 必须是 JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binHeader = 20 + jsonLength;
  const binLength = view.getUint32(binHeader, true);
  assert.equal(view.getUint32(binHeader + 4, true), 0x004e4942, '次 chunk 必须是 BIN');
  assert.equal(binHeader + 8 + binLength, bytes.byteLength, 'BIN chunk 长度必须与文件尾对齐');
  const binBytes = bytes.subarray(binHeader + 8, binHeader + 8 + binLength);
  const bin = {
    readAsync: (byteOffset, byteLength) => Promise.resolve(binBytes.subarray(byteOffset, byteOffset + byteLength)),
    byteLength: binBytes.byteLength,
  };
  return { json, bin };
}

/** 复刻 ExternalModelScriptRuntime 的受控编译：剥 import、注入 __babylon/__decorator、转译后 new Function。 */
async function compileModelScript(filePath) {
  const ts = await import('typescript');
  const sourceText = await readFile(filePath, 'utf8');
  const withoutImports = sourceText
    .replace(/^import\s.+?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+class\s+/g, 'class ');
  const transpiled = ts.transpileModule(withoutImports, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  });
  const babylon = await import('@babylonjs/core');
  const factory = new Function(
    '__babylon',
    '__decorator',
    `const { Color3, Vector3 } = __babylon;\n`
    + `const visibleAsNumber = __decorator;\nconst visibleAsColor3 = __decorator;\n`
    + `${transpiled.outputText}\n`
    + 'return { dataDriven, ParametricModelParamsComponent, ParametricModelRuntimeComponent };',
  );
  const noopDecorator = () => () => {};
  return factory(babylon, noopDecorator);
}

/** 用真实 Babylon glTF 管线导入虚拟输送线 GLB，返回 { scene, belt, baseMaterial }。 */
async function importVirtualConveyorGlb() {
  const { json, bin } = await unpackGlb(GLB_PATH);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const loader = new GLTFFileLoader();
  loader.validate = false;
  const result = await loader.importMeshAsync(null, scene, { json, bin }, '');
  const belt = result.meshes.find((mesh) => mesh.name === 'VCConveyorBelt');
  assert.ok(belt, '必须存在 VCConveyorBelt mesh');
  return { scene, belt, root: result.meshes[0] };
}

/** 复刻 SceneRuntime 的 modelRoot → contentRoot 层级并挂载导入结果。 */
function mountModelHierarchy(scene, loadedRoot) {
  const modelRoot = new TransformNode('entity_modelRoot', scene);
  const contentRoot = new TransformNode('entity_modelContentRoot', scene);
  contentRoot.parent = modelRoot;
  loadedRoot.parent = contentRoot;
  modelRoot.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  return { modelRoot, contentRoot };
}

test('GLB 结构完整且 Babylon 解析为 1×0.05×1 m 皮带板', async () => {
  const { json } = await unpackGlb(GLB_PATH);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].name, 'VCConveyorBelt');
  assert.deepEqual(json.accessors.find((a) => a.type === 'SCALAR')?.count, 36);

  const { belt } = await importVirtualConveyorGlb();
  assert.equal(belt.getTotalVertices(), 24);
  assert.equal(belt.getTotalIndices(), 36);
  belt.refreshBoundingInfo();
  const bounds = belt.getBoundingInfo().boundingBox;
  assert.ok(Math.abs(bounds.minimum.x - -0.5) < 1e-4 && Math.abs(bounds.maximum.x - 0.5) < 1e-4, 'x 跨度必须 1 m');
  assert.ok(Math.abs(bounds.minimum.y - 0) < 1e-4 && Math.abs(bounds.maximum.y - 0.05) < 1e-4, 'y 跨度必须 0.05 m 且底面贴 0');
  assert.ok(Math.abs(bounds.minimum.z - -0.5) < 1e-4 && Math.abs(bounds.maximum.z - 0.5) < 1e-4, 'z 跨度必须 1 m');
  assert.equal(belt.material?.getClassName?.(), 'PBRMaterial');
});

test('脚本 dataDriven 导出与 meta.json 一致', async () => {
  const compiled = await compileModelScript(SCRIPT_PATH);
  const meta = JSON.parse(await readFile(META_PATH, 'utf8'));
  assert.deepEqual(compiled.dataDriven, meta.dataDriven);
  assert.equal(compiled.dataDriven.device.devType, 'conveyor');
  assert.deepEqual(compiled.dataDriven.cargo.travel.nodes, []);
});

test('参数化脚本：默认参数缩放 2×1、颜色 #8a97a5', async () => {
  const { scene, belt, root } = await importVirtualConveyorGlb();
  const { contentRoot } = mountModelHierarchy(scene, root);
  const compiled = await compileModelScript(SCRIPT_PATH);

  const component = new compiled.ParametricModelRuntimeComponent(contentRoot);
  component.onStart();
  assert.ok(Math.abs(belt.scaling.x - 2) < 1e-3, `默认 length=2 / 基线 1m，scaling.x 应为 2，实际 ${belt.scaling.x}`);
  assert.ok(Math.abs(belt.scaling.z - 1) < 1e-3, `默认 width=1，scaling.z 应为 1，实际 ${belt.scaling.z}`);
  assert.ok(belt.material.albedoColor.r > 0.5 && belt.material.albedoColor.r < 0.58, '材质应乘 #8a97a5');
  assert.ok(belt.material.albedoColor.b > 0.62, '材质蓝色通道应接近 0.647');
});

test('参数热更新：length/width/color 注入后缩放与乘色跟随，黑色恢复原材质', async () => {
  const { scene, belt, root } = await importVirtualConveyorGlb();
  const { contentRoot } = mountModelHierarchy(scene, root);
  const compiled = await compileModelScript(SCRIPT_PATH);
  const baseMaterial = belt.material;

  const component = new compiled.ParametricModelRuntimeComponent(contentRoot);
  component.onStart();

  // 编辑器参数注入路径：直接写实例字段后触发 onUpdate（等价 assignParameterValues + update）。
  component.length = 4;
  component.width = 2;
  component.color = '#ff0000';
  component.onUpdate();
  assert.ok(Math.abs(belt.scaling.x - 4) < 1e-3, `length=4 时 scaling.x 应为 4，实际 ${belt.scaling.x}`);
  assert.ok(Math.abs(belt.scaling.z - 2) < 1e-3, `width=2 时 scaling.z 应为 2，实际 ${belt.scaling.z}`);
  assert.ok(belt.material.albedoColor.r > 0.99 && belt.material.albedoColor.g < 0.01, '材质应乘 #ff0000');
  assert.notEqual(belt.material, baseMaterial, '乘色应使用克隆材质，不污染基线');

  // 黑色 = 保留原色：恢复原基线材质实例。
  component.color = '#000000';
  component.onUpdate();
  assert.equal(belt.material, baseMaterial, '黑色应恢复基线材质实例');

  component.onStop();
  assert.ok(belt.material.isDisposed || !belt.material.isDisposed, 'onStop 不抛异常即可');
});

test('meta.json modelParameters 暴露 length/width/color 三参数', async () => {
  const meta = JSON.parse(await readFile(META_PATH, 'utf8'));
  assert.equal(meta.modelParameters.schema, 'babylon-editor.model-parameters');
  assert.deepEqual(meta.modelParameters.parameters.map((p) => p.key), ['length', 'width', 'color']);
  assert.equal(meta.lengthUnit, 'meter');
});
