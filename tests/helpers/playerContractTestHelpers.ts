import assert from 'node:assert/strict';
import ts from 'typescript';

/** 执行真实入口表达式，避免把变量名或排版当作业务契约。 */
export function evaluateSourceExpression(sourceText: string, select: (node: ts.Node) => boolean,
  scope: Record<string, unknown>) {
  const source = ts.createSourceFile('contract.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (select(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(matches.length, 1, '必须准确定位一个真实入口');
  const node = matches[0];
  const expression = ts.isMethodDeclaration(node)
    ? `({${node.getText(source).replace(/^private\s+/, '')}}).${node.name.getText(source)}`
    : node.getText(source);
  const js = ts.transpileModule(`return (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(scope), js)(...Object.values(scope));
}

export function namedArrow(name: string) {
  return (node: ts.Node) => ts.isArrowFunction(node)
    && (ts.isPropertyAssignment(node.parent) || ts.isVariableDeclaration(node.parent))
    && node.parent.name.getText() === name;
}

export function controlCondition(component: string) {
  return (node: ts.Node) => Boolean(node.parent) && ts.isConditionalExpression(node.parent)
    && node.parent.condition === node
    && node.parent.whenTrue.getText().includes(`<${component}`);
}
