import assert from 'node:assert/strict';
import ts from 'typescript';

/** 仅改三处已定位的材质克隆调用；不改节点查询、几何、参数、生命周期或脚本原件。 */
export function createMaterialInitializationRevision(source) {
  const ast = ts.createSourceFile('candidate.model.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, '源脚本必须能够解析');
  assert.ok(!source.includes('zending-3d-runtime'), '源脚本已包含项目运行时扩展，拒绝重复改写');
  const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ParametricModelRuntimeComponent');
  assert.ok(owner, '未找到真实运行组件');
  const targets = new Map([['ensureEntityOwnedMaterial', 'material'], ['getOrCreateAppearanceMaterial', 'baseMaterial'], ['ensureThinInstanceHost', 'sourceMaterial']]);
  const edits = [];
  for (const [methodName, receiver] of targets) {
    const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === methodName);
    assert.ok(method, '缺少方法：' + methodName);
    const found = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'clone'
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(method); assert.equal(found.length, 1, '材质克隆调用必须唯一：' + methodName);
    const call = found[0]; assert.equal(call.arguments.length, 1, '只接受原有单名称参数克隆');
    const name = call.arguments[0].getText(ast), original = call.getText(ast);
    // 显式传入先求值的 clone 方法，保留原方法访问、名称参数和 receiver；旧宿主没有扩展时走原调用。
    const replacement = `(typeof cloneDetachedModelMaterial === "function" ? cloneDetachedModelMaterial(${receiver}, ${receiver}.clone, ${name}) : ${original})`;
    edits.push({ start: call.getStart(ast), end: call.end, replacement });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return `import { cloneDetachedModelMaterial } from "zending-3d-runtime";${eol}${result}`;
}
