import assert from 'node:assert/strict';
import ts from 'typescript';

const SNAPSHOT_NAME = '__phase2LedRootProtocol';
const snapshot = `
// 研究候选只保存协议函数引用，不保存节点、世界矩阵、滚动状态或纹理。
const ${SNAPSHOT_NAME} = (() => {
  const descriptor = (target: any, key: string): PropertyDescriptor | undefined => {
    for (let current = target; current; current = Object.getPrototypeOf(current)) {
      const value = Object.getOwnPropertyDescriptor(current, key); if (value) return value;
    }
    return undefined;
  };
  return { getModelNodes: Object.getOwnPropertyDescriptor(ParametricModelRuntimeComponent.prototype, "getModelNodes")!.value,
    getScene: TransformNode.prototype.getScene, descendant: TransformNode.prototype.isDescendantOf,
    parent: descriptor(TransformNode.prototype, "parent"),
    arrayFilter: Array.prototype.filter, arrayFind: Array.prototype.find, arrayIterator: Array.prototype[Symbol.iterator],
    set: Set, setAdd: Set.prototype.add, setIterator: Set.prototype[Symbol.iterator],
    map: Map, mapSet: Map.prototype.set, mapGet: Map.prototype.get,
    regexpTest: RegExp.prototype.test, regexpExec: RegExp.prototype.exec };
})();
`;

/** 只改真实LED私有resolve方法；候选是否可采用必须由副作用/身份oracle决定。 */
export function createLedRootRevision(source) {
  const ast = ts.createSourceFile('led.model.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0);
  const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ParametricModelRuntimeComponent');
  assert.ok(owner, '真实LED运行组件缺失');
  const method = name => { const found = owner.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
    assert.equal(found.length, 1, '方法不唯一：' + name); return found[0]; };
  const resolve = method('resolveLedContentRoot'), nodes = method('getModelNodes');
  const compact = value => value.replace(/\s+/g, '');
  assert.equal(compact(nodes.body.getText(ast)), compact(`{
    const scene = this.node.getScene?.();
    const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
    return [...new Set(nodes.filter((candidate) => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
  }`), '原getModelNodes协议漂移，不猜测快路径');
  assert.equal(resolve.body.statements.length, 3); assert.ok(ts.isIfStatement(resolve.body.statements[0]));
  assert.ok(!source.includes(SNAPSHOT_NAME), '不对研究候选重复加补丁');
  const early = resolve.body.statements[0].getText(ast);
  assert.equal(compact(early), compact(`if (LED_CONTENT_ROOT_PATTERN.test(String(this.node?.name ?? ""))) { return this.node; }`));
  const originalTail = `const match = this.getModelNodes().find((candidate) => LED_CONTENT_ROOT_PATTERN.test(String(candidate.name ?? "")));
    return match ?? this.node;`;
  assert.equal(compact(resolve.body.statements.slice(1).map(node => node.getText(ast)).join('\n')), compact(originalTail));
  const body = `
    ${early}
    const native = ${SNAPSHOT_NAME};
    const descriptor = (target: any, key: string): PropertyDescriptor | undefined => {
      for (let current = target; current; current = Object.getPrototypeOf(current)) {
        const found = Object.getOwnPropertyDescriptor(current, key); if (found) return found;
      }
      return undefined;
    };
    const nodeField = Object.getOwnPropertyDescriptor(this, "node");
    const modelMethod = descriptor(this, "getModelNodes");
    const root = nodeField && "value" in nodeField ? nodeField.value : undefined;
    const rootScene = root && Object.getOwnPropertyDescriptor(root, "_scene");
    const rootSceneMethod = root && descriptor(root, "getScene");
    // 在读取scene之前拒绝定制入口，回退只执行一次原tail。
    if (!nodeField || !("value" in nodeField) || !modelMethod || !("value" in modelMethod)
      || modelMethod.value !== native.getModelNodes || !rootScene || !("value" in rootScene)
      || !rootSceneMethod || !("value" in rootSceneMethod) || rootSceneMethod.value !== native.getScene) {
      ${originalTail}
    }
    // 按原顺序读取同次快照；后面的保守回退不能二次getScene/读取数组getter。
    const scene = this.node.getScene?.();
    const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
    const legacySnapshot = () => {
      const filtered = [...new Set(nodes.filter((candidate) => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
      const match = filtered.find((candidate) => LED_CONTENT_ROOT_PATTERN.test(String(candidate.name ?? "")));
      return match ?? this.node;
    };
    if (Array.prototype.filter !== native.arrayFilter || Array.prototype.find !== native.arrayFind
      || Array.prototype[Symbol.iterator] !== native.arrayIterator || Set !== native.set
      || Set.prototype.add !== native.setAdd || Set.prototype[Symbol.iterator] !== native.setIterator
      || Map !== native.map || Map.prototype.set !== native.mapSet || Map.prototype.get !== native.mapGet
      || RegExp.prototype.test !== native.regexpTest || RegExp.prototype.exec !== native.regexpExec
      || Object.hasOwn(LED_CONTENT_ROOT_PATTERN, "test") || Object.hasOwn(LED_CONTENT_ROOT_PATTERN, "exec")) return legacySnapshot();
    const trusted = new Map<any, boolean>();
    const nativeNode = (target: any): boolean => {
      if (target === null) return true;
      if (!target || !(target instanceof TransformNode)) return false;
      if (trusted.has(target)) return trusted.get(target)!;
      trusted.set(target, false); // 循环父链也回到原流程，不改成伪造非后代。
      const name = Object.getOwnPropertyDescriptor(target, "name");
      const parentField = Object.getOwnPropertyDescriptor(target, "_parentNode");
      const parent = descriptor(target, "parent"), descendant = descriptor(target, "isDescendantOf");
      const valid = !!name && "value" in name && typeof name.value === "string"
        && !!parentField && "value" in parentField
        && !!parent && parent.get === native.parent?.get && parent.set === native.parent?.set
        && !!descendant && "value" in descendant && descendant.value === native.descendant
        && nativeNode(parentField.value);
      trusted.set(target, valid); return valid;
    };
    if (!nodes.every(nativeNode)) return legacySnapshot();
    for (const candidate of nodes) {
      const name = Object.getOwnPropertyDescriptor(candidate, "name")!.value;
      if (LED_CONTENT_ROOT_PATTERN.test(name) && (candidate === this.node || candidate.isDescendantOf(this.node))) return candidate;
    }
    return this.node;
  `;
  const eol = source.includes('\r\n') ? '\r\n' : '\n', normalized = value => value.replaceAll('\r\n', '\n').replaceAll('\n', eol);
  const edits = [{ start: resolve.body.getStart(ast) + 1, end: resolve.body.end - 1, text: normalized(body) },
    { start: owner.end, end: owner.end, text: normalized('\n' + snapshot) }];
  let candidate = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.end);
  const parsed = ts.createSourceFile('led-candidate.model.ts', candidate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(parsed.parseDiagnostics.length, 0, 'LED候选语法错误');
  const newOwner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === owner.name.text);
  for (const item of owner.members) if (item !== resolve) {
    const equivalent = newOwner.members.find(node => node.name?.getText(parsed) === item.name?.getText(ast));
    assert.ok(equivalent && equivalent.getText(parsed) === item.getText(ast), '不得改动其它方法/字段：' + item.name?.getText(ast));
  }
  return candidate;
}
