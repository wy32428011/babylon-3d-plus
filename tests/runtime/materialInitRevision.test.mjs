import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { createMaterialInitializationRevision } from '../../scripts/lib/babylonMaterialInitRevision.mjs';
import { prepareModelScriptCompilation } from '../../electron/shared/modelScriptCompilation.ts';
import { cloneDetachedModelMaterial } from '../../src/runtime/babylon/cloneDetachedModelMaterial.ts';

const source = `export class ParametricModelRuntimeComponent {
  public onStart(material: any) { return [this.ensureEntityOwnedMaterial({ material }), this.getOrCreateAppearanceMaterial(material), this.ensureThinInstanceHost({ material })]; }
  private ensureEntityOwnedMaterial(target: any) { const material = target.material; if (typeof material.clone !== 'function') return material; return material.clone(material.name + '-owned'); }
  private getOrCreateAppearanceMaterial(baseMaterial: any) { if (typeof baseMaterial.clone !== 'function') return null; return baseMaterial.clone(baseMaterial.name + '-appearance'); }
  private ensureThinInstanceHost(mesh: any) { const sourceMaterial = mesh.material; return sourceMaterial.clone(sourceMaterial.name + '-host'); }
}`;
function run(text, projectApi) {
  const compiled = prepareModelScriptCompilation(text);
  const code = ts.transpileModule(compiled.sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText + compiled.returnStatement;
  const api = new Function('__babylon', '__decorator', code)(projectApi, () => () => {});
  const events = []; let reads = 0;
  const material = { get name() { events.push('name'); return 'value-' + reads; }, get clone() {
    const sequence = ++reads; events.push('clone:' + sequence);
    return function (name) { assert.equal(this, material); events.push('invoke:' + sequence); return { name, sequence }; };
  } };
  return { result: new api.classes.ParametricModelRuntimeComponent().onStart(material), events };
}

test('材质修订只替换三处clone，保留访问器顺序、参数求值和receiver', () => {
  const revised = createMaterialInitializationRevision(source);
  assert.equal((revised.match(/typeof cloneDetachedModelMaterial/g) ?? []).length, 3);
  assert.deepEqual(run(revised, { cloneDetachedModelMaterial }), run(source, {}));
  const methods = text => {
    const ast = ts.createSourceFile('asset.ts', text, ts.ScriptTarget.Latest, true);
    const owner = ast.statements.find(node => ts.isClassDeclaration(node));
    return owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'onStart').getText(ast);
  };
  assert.equal(methods(revised), methods(source));
});

test('旧宿主没有项目扩展仍按原clone运行，重复改写明确拒绝', () => {
  const revised = createMaterialInitializationRevision(source);
  assert.deepEqual(run(revised, {}), run(source, {}));
  assert.throws(() => createMaterialInitializationRevision(revised), /重复/);
});
