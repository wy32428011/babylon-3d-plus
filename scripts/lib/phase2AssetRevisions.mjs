import assert from 'node:assert/strict';
import ts from 'typescript';

/** 新资产版本仅替换经过定位的私有方法；不改原文件、生命周期或参数/几何规则。 */
function rewriteMethod(source, name, rewrite) {
  const ast = ts.createSourceFile('asset.model.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, '源脚本包含语法错误');
  const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ParametricModelRuntimeComponent');
  assert.ok(owner, '未找到真实运行组件');
  const methods = owner.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.equal(methods.length, 1, `方法必须唯一：${name}`);
  const method = methods[0];
  const before = method.body.getText(ast).slice(1, -1);
  const after = rewrite(before);
  assert.notEqual(before, after, `方法未发生有效修改：${name}`);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return source.slice(0, method.body.getStart(ast) + 1) + after.replaceAll('\r\n', '\n').replaceAll('\n', eol)
    + source.slice(method.body.end - 1);
}

const nodeBody = `
		const scene = this.node.getScene?.();
		const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
		// 新修订只加速原生 Babylon 父子协议；定制方法/访问器继续原扫描，保留其有意副作用。
		const findDescriptor = (target: any, key: string): PropertyDescriptor | undefined => {
			for (let cursor = target; cursor; cursor = Object.getPrototypeOf(cursor)) {
				const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
				if (descriptor) return descriptor;
			}
			return undefined;
		};
		const parentDescriptor = findDescriptor(TransformNode.prototype, "parent");
		const expected: Record<string, unknown> = {
			isDescendantOf: TransformNode.prototype.isDescendantOf,
			getDescendants: TransformNode.prototype.getDescendants,
			_getDescendants: (TransformNode.prototype as any)._getDescendants,
		};
		const nativePrototypes = new Map<any, boolean>();
		const hasNativeProtocol = (target: any): boolean => {
			if (!target) return true;
			const cached = nativePrototypes.get(target);
			if (cached !== undefined) return cached;
			let valid = true;
			for (const [key, method] of Object.entries(expected)) {
				const descriptor = Object.getOwnPropertyDescriptor(target, key);
				if (descriptor && (descriptor.get || descriptor.set || descriptor.value !== method)) { valid = false; break; }
			}
			const parent = Object.getOwnPropertyDescriptor(target, "parent");
			if (parent && (parent.get !== parentDescriptor?.get || parent.set !== parentDescriptor?.set)) valid = false;
			valid = valid && hasNativeProtocol(Object.getPrototypeOf(target));
			nativePrototypes.set(target, valid);
			return valid;
		};
		if (!nodes.every(candidate => candidate instanceof TransformNode
			&& !Object.hasOwn(candidate, "isDescendantOf") && !Object.hasOwn(candidate, "getDescendants")
			&& !Object.hasOwn(candidate, "_getDescendants") && !Object.hasOwn(candidate, "parent")
			&& hasNativeProtocol(Object.getPrototypeOf(candidate)))) {
			return [...new Set(nodes.filter(candidate => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
		}
		// 每次调用重新取子树，不跨 onStart/onUpdate 缓存，增删/重挂接无需依赖不完整的失效事件。
		const descendants = new Set(this.node.getDescendants(false));
		return [...new Set(nodes.filter(candidate => candidate === this.node || descendants.has(candidate)))];
	`;

const integerUnion = `const componentKeys = [...vertexIndicesByKey.keys()];
		const componentIds = new Map(componentKeys.map((key, index) => [key, index]));
		const parents = componentKeys.map((_, index) => index);
		// 仍按原 toFixed(5) 的键焊接，按原三角形顺序定根；仅私有父链改为整数索引。
		const rootId = (id: number): number => {
			let root = id;
			while (parents[root] !== root) root = parents[root];
			while (parents[id] !== id) { const next = parents[id]; parents[id] = root; id = next; }
			return root;
		};
		const findRoot = (key: string): string => componentKeys[rootId(componentIds.get(key)!)];
		const union = (left: string, right: string): void => {
			const leftRoot = rootId(componentIds.get(left)!);
			const rightRoot = rootId(componentIds.get(right)!);
			if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
		};

		for (let index = 0; index + 2 < indices.length; index += 3) {
			const first = coordinateKeys[indices[index]];
			const second = coordinateKeys[indices[index + 1]];
			const third = coordinateKeys[indices[index + 2]];
			if (!first || !second || !third) continue;
			union(first, second);
			union(second, third);
		}

		`;

export function createAssetRevision(source, variant) {
  assert.ok(['nodes', 'kernel', 'both'].includes(variant), '未知资产候选');
  let revised = source;
  if (variant === 'nodes' || variant === 'both') revised = rewriteMethod(revised, 'getModelNodes', () => nodeBody);
  if (variant === 'kernel' || variant === 'both') revised = rewriteMethod(revised, 'getMeshComponents', before => {
    const normalized = before.replaceAll('\r\n', '\n');
    const start = normalized.indexOf('const parents = new Map<string, string>();');
    const end = normalized.indexOf('const verticesByRoot = new Map<string, Set<number>>();', start);
    assert.ok(start >= 0 && end > start, '连通分量原内核边界已漂移，拒绝猜测替换');
    return normalized.slice(0, start) + integerUnion + normalized.slice(end);
  });
  return revised;
}

export function extractRuntimeMethod(source, name) {
  const ast = ts.createSourceFile('asset.model.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ParametricModelRuntimeComponent');
  return owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)?.getText(ast);
}
