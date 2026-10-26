import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * 外置参数化脚本（*.model.ts）的静态写法扫描器：只读、不改任何脚本。
 * 目的是把“每帧遍历全场节点、强制刷新矩阵、重绘动态纹理、带副作用的 getter”这类
 * 会放大主线程成本、或依赖框架读取次数的写法列成报告，交给资产作者与性能分析使用。
 * 结论仅是静态启发式提示，不是运行时证明，也不等价于脚本有缺陷。
 */

export const RULES = {
  'per-frame-scene-traversal': '逐帧回调中遍历场景全部网格/节点，或按祖先链反复判断',
  'per-frame-force-world-matrix': '逐帧强制重算世界矩阵或求逆',
  'per-frame-texture-update': '逐帧重绘/上传动态纹理',
  'getter-side-effect': 'getter 内含写入、自增或集合修改，行为依赖被读取的次数',
};

const FRAME_OBSERVABLES = new Set(['onBeforeRenderObservable', 'onAfterRenderObservable', 'onBeforeActiveMeshesEvaluationObservable']);
const FRAME_REGISTRARS = new Set(['registerBeforeRender', 'registerAfterRender']);
const FRAME_METHODS = new Set(['onUpdate']);
const SCENE_COLLECTIONS = new Set(['meshes', 'transformNodes', 'rootNodes', 'lights', 'materials']);
const TRAVERSAL_CALLS = new Set(['getChildMeshes', 'getDescendants', 'isDescendantOf', 'getChildTransformNodes']);
const MUTATING_METHODS = new Set(['push', 'add', 'set', 'delete', 'splice', 'pop', 'shift', 'unshift', 'clear']);

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function calleeName(call) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** 收集文件内所有具名函数/方法，供“帧回调可达”分析使用（只做同文件、按名称的保守近似）。 */
function collectNamedFunctions(sourceFile) {
  const functions = new Map();
  const add = (name, node) => { if (name && node) (functions.get(name) ?? functions.set(name, []).get(name)).push(node); };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) add(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) add(node.name.text, node.initializer);
    else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) add(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

/** 找出帧回调入口：onUpdate 方法，以及传给帧 Observable/registerBeforeRender 的回调。 */
function collectFrameRoots(sourceFile, functions) {
  const roots = new Set();
  for (const name of FRAME_METHODS) for (const node of functions.get(name) ?? []) roots.add(node);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const method = ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      const viaObservable = method === 'add' && ts.isPropertyAccessExpression(expression.expression)
        && FRAME_OBSERVABLES.has(expression.expression.name.text);
      const viaRegistrar = method !== null && FRAME_REGISTRARS.has(method);
      if (viaObservable || viaRegistrar) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) roots.add(callback);
        else if (callback && ts.isIdentifier(callback)) for (const fn of functions.get(callback.text) ?? []) roots.add(fn);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return roots;
}

/** 从帧入口出发，沿同文件内按名称的直接调用扩展出“每帧可能执行”的函数集合。 */
function expandFrameScope(roots, functions) {
  const scope = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const fn = queue.pop();
    const visit = (node) => {
      if (node !== fn && (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) return;
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        for (const target of (name ? functions.get(name) : null) ?? []) {
          if (!scope.has(target)) { scope.add(target); queue.push(target); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
  }
  return scope;
}

function isInside(node, scope) {
  for (let current = node.parent; current; current = current.parent) if (scope.has(current)) return true;
  return false;
}

function pushFinding(findings, sourceFile, fileName, rule, node, detail) {
  findings.push({ file: fileName, rule, line: lineOf(sourceFile, node), message: RULES[rule], detail });
}

/** 扫描一份脚本源码，返回按行号排序的提示列表。 */
export function scanModelScriptSource(sourceText, fileName = 'script.model.ts') {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = collectNamedFunctions(sourceFile);
  const frameScope = expandFrameScope(collectFrameRoots(sourceFile, functions), functions);
  const findings = [];

  const visit = (node) => {
    const perFrame = frameScope.size > 0 && isInside(node, frameScope);
    if (perFrame && ts.isPropertyAccessExpression(node) && SCENE_COLLECTIONS.has(node.name.text)
      && /(^|[.\s)])(scene|getScene\(\))$/.test(node.expression.getText(sourceFile).replace(/\?$/, ''))) {
      pushFinding(findings, sourceFile, fileName, 'per-frame-scene-traversal', node, node.getText(sourceFile));
    }
    if (perFrame && ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && TRAVERSAL_CALLS.has(name)) pushFinding(findings, sourceFile, fileName, 'per-frame-scene-traversal', node, name + '()');
      if (name === 'computeWorldMatrix' && node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword) {
        pushFinding(findings, sourceFile, fileName, 'per-frame-force-world-matrix', node, 'computeWorldMatrix(true)');
      }
      if (name && /^invert(ToRef)?$/.test(name)) pushFinding(findings, sourceFile, fileName, 'per-frame-force-world-matrix', node, name + '()');
      if (name === 'update' && ts.isPropertyAccessExpression(node.expression) && /texture/i.test(node.expression.expression.getText(sourceFile))) {
        pushFinding(findings, sourceFile, fileName, 'per-frame-texture-update', node, node.expression.getText(sourceFile) + '()');
      }
    }
    if (ts.isGetAccessor(node) && node.body) {
      const locals = new Set();
      const collectLocals = (inner) => {
        if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name)) locals.add(inner.name.text);
        ts.forEachChild(inner, collectLocals);
      };
      collectLocals(node.body);
      const effects = [];
      const inspect = (inner) => {
        const isAssignment = ts.isBinaryExpression(inner)
          && inner.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && inner.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const isUpdate = (ts.isPrefixUnaryExpression(inner) || ts.isPostfixUnaryExpression(inner))
          && (inner.operator === ts.SyntaxKind.PlusPlusToken || inner.operator === ts.SyntaxKind.MinusMinusToken);
        const target = isAssignment ? inner.left : isUpdate ? inner.operand : null;
        if (target && !(ts.isIdentifier(target) && locals.has(target.text))) effects.push(inner.getText(sourceFile));
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
          && MUTATING_METHODS.has(inner.expression.name.text)
          && !(ts.isIdentifier(inner.expression.expression) && locals.has(inner.expression.expression.text))) effects.push(inner.getText(sourceFile));
        ts.forEachChild(inner, inspect);
      };
      inspect(node.body);
      if (effects.length) pushFinding(findings, sourceFile, fileName, 'getter-side-effect', node, effects[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

async function collectScriptFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await collectScriptFiles(full));
    else if (/\.model\.ts$/i.test(entry.name)) files.push(full);
  }
  return files;
}

/** 扫描多个文件/目录；返回逐文件结果与规则汇总。 */
export async function scanModelScripts(targets) {
  const files = [...new Set((await Promise.all(targets.map(collectScriptFiles))).flat())].sort();
  const results = [];
  for (const file of files) results.push({ file, findings: scanModelScriptSource(await readFile(file, 'utf8'), file) });
  const summary = Object.fromEntries(Object.keys(RULES).map(rule => [rule, 0]));
  for (const result of results) for (const finding of result.findings) summary[finding.rule] += 1;
  return { scannedFiles: files.length, filesWithFindings: results.filter(result => result.findings.length).length, summary, results };
}

function formatText(report) {
  const lines = [`扫描 ${report.scannedFiles} 个脚本，${report.filesWithFindings} 个有提示。`];
  for (const [rule, count] of Object.entries(report.summary)) lines.push(`  ${rule}: ${count}  （${RULES[rule]}）`);
  for (const { file, findings } of report.results) {
    for (const finding of findings) lines.push(`${file}:${finding.line}  [${finding.rule}]  ${finding.detail}`);
  }
  lines.push('注意：静态启发式提示，不是运行时证明；脚本本身不会被修改。');
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const failOnFindings = args.includes('--fail-on-findings');
  const targets = args.filter(arg => !arg.startsWith('--'));
  if (!targets.length) {
    console.error('用法：node scripts/scan-model-script-patterns.mjs <文件或目录...> [--json] [--fail-on-findings]');
    process.exitCode = 2;
  } else {
    const report = await scanModelScripts(targets);
    console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
    if (failOnFindings && report.filesWithFindings) process.exitCode = 1;
  }
}
